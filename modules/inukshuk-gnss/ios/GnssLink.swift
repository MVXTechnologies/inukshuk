import CoreBluetooth
import Foundation

/// Receives link events; the Expo module forwards them to JS.
protocol GnssEventSink: AnyObject {
  func emit(_ name: String, _ body: [String: Any?])
}

/// Error codes are part of the JS contract (src/lib/gnss/nativeGnss.ts).
struct GnssError: Error {
  let code: String
  let message: String
  /// Retrying cannot help (no permission, no serial service, unknown device).
  var fatal = false
}

let gnssFakeDeviceId = "inukshuk-fake-receiver"
let gnssFakeDeviceName = "Simulated receiver (test)"

/// Where a connect() wants to go. BLE targets are persisted so iOS state
/// restoration can resume the link after relaunching the app in the
/// background (fake frames are never persisted).
struct GnssTarget: Codable {
  let deviceId: String
  let transport: String
  let profiles: [GnssGattProfile]
  let autoReconnect: Bool
  var fakeFrames: [Data] = []
  var fakeIntervalMs: Int64 = 1_000
  var fakeLoop = true

  enum CodingKeys: String, CodingKey { case deviceId, transport, profiles, autoReconnect }
}

/// The one receiver link of the process (iOS).
///
/// - **Transports:** BLE through CoreBluetooth (Nordic UART and the other
///   serial profiles JS passes in), and the test-only fake receiver.
///   iOS has no public Bluetooth Classic API: SPP receivers reach third-party
///   apps only as MFi accessories through External Accessory, which needs each
///   vendor to whitelist the app (P3, not in v1). **Seam:** an EA transport
///   would be a third `transport` value ("ea") handled next to "fake" in
///   `connect`, with `EASession` streams feeding `received(_:)` and
///   `write(_:)`, plus `UISupportedExternalAccessoryProtocols` per approved
///   vendor in plugins/withGnss.js. Nothing else changes.
/// - **Background:** `bluetooth-central` (plugins/withGnss.js) wakes the app
///   for notifications; state restoration (`restoreIdentifier`) lets iOS
///   relaunch it to resume the link. While recording, the `location` mode
///   keeps the app running anyway.
/// - **Process-scoped:** the link outlives React reloads; module instances
///   attach as sinks. Bytes received with no JS listener wait in a 512 KiB
///   ring (oldest dropped and counted) and flush when one attaches.
/// - **Threading:** all state is confined to `queue`, which is also the
///   CoreBluetooth delegate queue. `sinks` and `snapshotValue` take `lock`.
final class GnssLink: NSObject {
  static let shared = GnssLink()
  static let restoreIdentifier = "app.inukshuk.gnss.central"
  private static let targetKey = "app.inukshuk.gnss.target"
  private static let ringBytes = 512 * 1024
  private static let maxEventBytes = 64 * 1024
  private static let maxPendingWriteBytes = 64 * 1024
  private static let setupTimeoutMs: Int64 = 20_000
  private static let writeStallMs: Int64 = 5_000
  private static let rssiIntervalMs: Int64 = 5_000

  let queue = DispatchQueue(label: "app.inukshuk.gnss", qos: .userInitiated)
  private let lock = NSLock()

  private final class WeakSink {
    weak var sink: GnssEventSink?
    var listening = false
    init(_ sink: GnssEventSink) { self.sink = sink }
  }
  private var sinks: [ObjectIdentifier: WeakSink] = [:]
  private var snapshotValue: [String: Any?] = GnssLink.stateBody("idle", nil, nil, nil, false)

  // --- queue-confined state ---
  private var central: CBCentralManager?
  private var whenReady: [(GnssError?) -> Void] = []
  private var permissionWaiters: [() -> Void] = []
  private var known: [String: CBPeripheral] = [:]
  private var scanning = false
  private var scanGeneration = 0
  private var scanThrottle = GnssScanThrottle()

  private var target: GnssTarget?
  private var peripheral: CBPeripheral?
  private var generation = 0
  private var opened = false
  private var mtu: Int?
  private var choice: GnssProfileChoice?
  private var notifyChar: CBCharacteristic?
  private var writeChar: CBCharacteristic?
  private var writeType: CBCharacteristicWriteType = .withResponse
  private var pendingServices = 0
  private var discovered: [String: [String: GnssCharCaps]] = [:]
  private var backoff = GnssBackoff()
  private var restoredPeripheral: CBPeripheral?

  private struct PendingWrite {
    let payload: Int
    let bytes: Data
    let last: Bool
    let done: ((GnssError?) -> Void)?
  }
  private var writes: [PendingWrite] = []
  private var writeInFlight: PendingWrite?
  private var nextPayload = 0
  private var writeStallGeneration = 0

  private var rssiTimer: DispatchSourceTimer?
  private var fakeTimer: DispatchSourceTimer?
  private var fakeCursor: GnssFrameCursor?

  private var ring = GnssByteRing(capacity: GnssLink.ringBytes)
  private var pacer = GnssFlushPacer(minIntervalMs: 100)
  private var flushScheduled = false

  let fakeAllowed: Bool = {
    #if DEBUG
      return true
    #else
      // Release builds only with the flag plugins/withGnss.js writes for
      // E2E builds (GNSS_FAKE_DEVICE=1).
      return Bundle.main.object(forInfoDictionaryKey: "InukshukGnssFakeDevice") as? Bool == true
    #endif
  }()

  static let hasBluetoothBackgroundMode: Bool = {
    let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
    return modes.contains("bluetooth-central")
  }()

  private static func nowMs() -> Int64 {
    Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
  }

  // MARK: Sinks

  func attach(_ sink: GnssEventSink) {
    lock.lock()
    sinks[ObjectIdentifier(sink)] = WeakSink(sink)
    lock.unlock()
  }

  func detach(_ sink: GnssEventSink) {
    lock.lock()
    sinks[ObjectIdentifier(sink)] = nil
    lock.unlock()
  }

  func setListening(_ sink: GnssEventSink, _ listening: Bool) {
    lock.lock()
    sinks[ObjectIdentifier(sink)]?.listening = listening
    lock.unlock()
    if listening { queue.async { self.scheduleFlush() } }
  }

  private func anyListening() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return sinks.values.contains { $0.listening && $0.sink != nil }
  }

  private func emit(_ name: String, _ body: [String: Any?]) {
    lock.lock()
    let targets = sinks.values.compactMap { $0.sink }
    lock.unlock()
    for s in targets { s.emit(name, body) }
  }

  private func emitError(_ e: GnssError, _ deviceId: String?) {
    emit("onError", ["code": e.code, "message": e.message, "deviceId": deviceId, "fatal": e.fatal])
  }

  func snapshot() -> [String: Any?] {
    lock.lock()
    defer { lock.unlock() }
    return snapshotValue
  }

  // MARK: Central lifecycle

  /// Called by the app delegate subscriber when iOS relaunched the app for a
  /// Bluetooth event of our central: recreate it at once with the same
  /// restore identifier so `willRestoreState` fires.
  func restoreAtLaunch() {
    queue.async { _ = self.ensureCentral() }
  }

  @discardableResult
  private func ensureCentral() -> CBCentralManager {
    if let c = central { return c }
    // Creating the manager is what shows the Bluetooth permission prompt when
    // the user has not decided yet; callers only get here on an explicit
    // request (permission, scan, connect) or a restoration.
    var options: [String: Any] = [CBCentralManagerOptionShowPowerAlertKey: false]
    // CoreBluetooth raises an exception when a restore identifier is used
    // without the bluetooth-central background mode, so restoration is only
    // requested when the build declares it (plugins/withGnss.js does, unless
    // `iosBackgroundMode: false`).
    if GnssLink.hasBluetoothBackgroundMode {
      options[CBCentralManagerOptionRestoreIdentifierKey] = GnssLink.restoreIdentifier
    }
    let c = CBCentralManager(delegate: self, queue: queue, options: options)
    central = c
    return c
  }

  private static func permissionStatus() -> String {
    switch CBManager.authorization {
    case .allowedAlways: return "granted"
    case .notDetermined: return "undetermined"
    default: return "denied"
    }
  }

  static func permissionResponse() -> [String: Any] {
    let status = permissionStatus()
    return [
      "status": status,
      "granted": status == "granted",
      "canAskAgain": status == "undetermined",
      "expires": "never",
    ]
  }

  func requestPermission(_ done: @escaping ([String: Any]) -> Void) {
    queue.async {
      if CBManager.authorization != .notDetermined {
        done(GnssLink.permissionResponse())
        return
      }
      self.permissionWaiters.append { done(GnssLink.permissionResponse()) }
      self.ensureCentral()
    }
  }

  func availability(_ done: @escaping ([String: Any?]) -> Void) {
    queue.async {
      var transports = ["ble"]
      if self.fakeAllowed { transports.append("fake") }
      let powered: Bool? = {
        guard let c = self.central, c.state != .unknown, c.state != .resetting else { return nil }
        return c.state == .poweredOn
      }()
      done([
        "supported": self.central?.state != .unsupported,
        "ble": self.central?.state != .unsupported,
        "classic": false,
        // nil until the central exists (creating it could prompt).
        "poweredOn": powered,
        "transports": transports,
        "fakeDevice": self.fakeAllowed,
      ])
    }
  }

  /// Runs `work` once the central is powered on, or fails it.
  private func whenPoweredOn(_ work: @escaping (GnssError?) -> Void) {
    let c = ensureCentral()
    switch c.state {
    case .poweredOn: work(nil)
    case .unknown, .resetting: whenReady.append(work)
    default: work(GnssLink.stateError(c.state))
    }
  }

  private static func stateError(_ state: CBManagerState) -> GnssError {
    switch state {
    case .unauthorized:
      return GnssError(code: "E_GNSS_PERMISSION", message: "Bluetooth permission denied", fatal: true)
    case .unsupported:
      return GnssError(code: "E_GNSS_UNAVAILABLE", message: "This device has no Bluetooth LE", fatal: true)
    default:
      return GnssError(code: "E_GNSS_BLUETOOTH_OFF", message: "Bluetooth is off")
    }
  }

  // MARK: Scanning

  func startScan(durationMs: Int64, _ done: @escaping (GnssError?) -> Void) {
    queue.async {
      self.whenPoweredOn { error in
        if let error { return done(error) }
        guard let c = self.central else { return done(GnssLink.stateError(.unknown)) }
        self.stopScanNow(reason: nil)
        self.scanThrottle.clear()
        // Unfiltered: many serial receivers do not advertise their 128-bit
        // service (JS ranks results by what they do advertise). Foreground
        // only, which suits a pairing screen.
        c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        self.scanning = true
        self.scanGeneration += 1
        let gen = self.scanGeneration
        self.emit("onScanState", ["scanning": true, "reason": nil])
        if self.fakeAllowed { self.emit("onDevice", self.fakeDevice()) }
        let ms = durationMs <= 0 ? 15_000 : min(durationMs, 60_000)
        self.queue.asyncAfter(deadline: .now() + .milliseconds(Int(ms))) {
          if self.scanGeneration == gen { self.stopScanNow(reason: "timeout") }
        }
        done(nil)
      }
    }
  }

  func stopScan(reason: String?, _ done: (() -> Void)? = nil) {
    queue.async {
      self.stopScanNow(reason: reason)
      done?()
    }
  }

  private func stopScanNow(reason: String?) {
    guard scanning else { return }
    scanning = false
    scanGeneration += 1
    if central?.state == .poweredOn { central?.stopScan() }
    if let reason { emit("onScanState", ["scanning": false, "reason": reason]) }
  }

  /// Peripherals already connected to iOS with one of the given services
  /// (e.g. through another app), plus the fake receiver when allowed. Never
  /// prompts: without a decided permission it returns only the fake.
  func knownDevices(serviceUuids: [String], _ done: @escaping ([[String: Any?]], GnssError?) -> Void) {
    queue.async {
      var out: [[String: Any?]] = []
      if self.fakeAllowed { out.append(self.fakeDevice()) }
      let uuids = serviceUuids.compactMap(gnssNormalizeUuid).map { CBUUID(string: $0) }
      guard CBManager.authorization == .allowedAlways, !uuids.isEmpty else { return done(out, nil) }
      self.whenPoweredOn { error in
        if let error { return done(out, error.code == "E_GNSS_BLUETOOTH_OFF" ? nil : error) }
        guard let c = self.central else { return done(out, nil) }
        for p in c.retrieveConnectedPeripherals(withServices: uuids) {
          let id = p.identifier.uuidString
          self.known[id] = p
          out.append([
            "id": id, "name": p.name, "transport": "ble", "rssi": nil,
            "serviceUuids": (p.services ?? []).compactMap { gnssNormalizeUuid($0.uuid.uuidString) },
            "bonded": false,
          ])
        }
        done(out, nil)
      }
    }
  }

  private func fakeDevice() -> [String: Any?] {
    ["id": gnssFakeDeviceId, "name": gnssFakeDeviceName, "transport": "fake", "rssi": nil,
     "serviceUuids": [String](), "bonded": false]
  }

  // MARK: Link lifecycle

  func connect(_ t: GnssTarget, _ done: @escaping (GnssError?) -> Void) {
    queue.async {
      if t.transport == "fake" {
        guard self.fakeAllowed else {
          return done(GnssError(code: "E_GNSS_FAKE_DISABLED", message: "The simulated receiver is not enabled in this build", fatal: true))
        }
      }
      self.closeLink()
      self.ring.clear()
      _ = self.ring.takeDropped()
      self.target = t
      self.backoff.reset()
      self.stopScanNow(reason: "connecting")
      if t.transport == "ble" {
        self.persist(t)
        self.ensureCentral()
      } else {
        self.persist(nil)
      }
      self.openCurrent()
      done(nil)
    }
  }

  func disconnect(_ done: @escaping () -> Void) {
    queue.async {
      let t = self.target
      self.target = nil
      self.persist(nil)
      self.closeLink()
      self.flushNow()
      self.setState("disconnected", t, reason: "user")
      done()
    }
  }

  func write(_ data: Data, _ done: @escaping (GnssError?) -> Void) {
    queue.async {
      guard self.opened, let t = self.target else {
        return done(GnssError(code: "E_GNSS_NOT_CONNECTED", message: "The receiver is not connected"))
      }
      if t.transport == "fake" { return done(nil) }  // accepted and discarded
      guard let p = self.peripheral, self.writeChar != nil else {
        return done(GnssError(code: "E_GNSS_NOT_WRITABLE", message: "This receiver offers no writable serial characteristic"))
      }
      if data.isEmpty { return done(nil) }
      let queued = self.writes.reduce(0) { $0 + $1.bytes.count } + (self.writeInFlight?.bytes.count ?? 0)
      if queued + data.count > GnssLink.maxPendingWriteBytes {
        return done(GnssError(code: "E_GNSS_WRITE_OVERFLOW", message: "The receiver is not accepting data fast enough"))
      }
      let max = Swift.max(20, p.maximumWriteValueLength(for: self.writeType))
      let parts = gnssSplitForWrite(data, max: max)
      let payload = self.nextPayload
      self.nextPayload += 1
      for (i, part) in parts.enumerated() {
        let last = i == parts.count - 1
        self.writes.append(PendingWrite(payload: payload, bytes: part, last: last, done: last ? done : nil))
      }
      self.pumpWrites()
    }
  }

  private func persist(_ t: GnssTarget?) {
    if let t, let data = try? JSONEncoder().encode(t) {
      UserDefaults.standard.set(data, forKey: GnssLink.targetKey)
    } else {
      UserDefaults.standard.removeObject(forKey: GnssLink.targetKey)
    }
  }

  private func savedTarget() -> GnssTarget? {
    guard let data = UserDefaults.standard.data(forKey: GnssLink.targetKey) else { return nil }
    return try? JSONDecoder().decode(GnssTarget.self, from: data)
  }

  private func openCurrent() {
    guard let t = target else { return }
    generation += 1
    if t.transport == "fake" {
      openFake(t)
      return
    }
    let c = ensureCentral()
    switch c.state {
    case .poweredOn: break
    case .unknown, .resetting:
      setState("connecting", t)  // centralManagerDidUpdateState resumes
      return
    case .poweredOff:
      setState("reconnecting", t, reason: "bluetooth-off")
      return
    default:
      linkFailed(GnssLink.stateError(c.state))
      return
    }
    let p: CBPeripheral
    if let restored = restoredPeripheral, restored.identifier.uuidString == t.deviceId {
      p = restored
      restoredPeripheral = nil
    } else if let k = known[t.deviceId] {
      p = k
    } else if let uuid = UUID(uuidString: t.deviceId), let r = c.retrievePeripherals(withIdentifiers: [uuid]).first {
      p = r
    } else {
      linkFailed(GnssError(code: "E_GNSS_UNKNOWN_DEVICE", message: "Unknown receiver: scan for it first", fatal: true))
      return
    }
    peripheral = p
    p.delegate = self
    setState("connecting", t)
    if p.state == .connected {
      // Restored (or connected through iOS already): go straight to setup.
      startSetup(p)
    } else {
      // A pending connect never times out on iOS: it completes whenever the
      // receiver comes into range, also in the background.
      c.connect(p, options: nil)
    }
  }

  private func startSetup(_ p: CBPeripheral) {
    guard let t = target else { return }
    discovered = [:]
    pendingServices = 0
    let gen = generation
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(GnssLink.setupTimeoutMs))) {
      if gen == self.generation, !self.opened, self.peripheral === p {
        self.linkFailed(GnssError(code: "E_GNSS_CONNECT_TIMEOUT", message: "The receiver did not finish setting up"))
      }
    }
    let services = Array(Set(t.profiles.map { $0.service })).map { CBUUID(string: $0) }
    p.discoverServices(services)
  }

  private func openFake(_ t: GnssTarget) {
    setState("connecting", t)
    fakeCursor = GnssFrameCursor(frames: t.fakeFrames, loop: t.fakeLoop)
    let gen = generation
    queue.asyncAfter(deadline: .now() + .milliseconds(250)) {
      guard gen == self.generation else { return }
      self.markOpened(mtu: nil, profile: "fake", writable: true)
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now(), repeating: .milliseconds(Int(t.fakeIntervalMs)))
      // The link is a process-lifetime singleton: strong captures are fine,
      // and cancel() releases the handler.
      timer.setEventHandler {
        guard gen == self.generation else { return }
        if let frame = self.fakeCursor?.next() {
          self.received(frame)
        } else {
          self.linkFailed(GnssError(code: "E_GNSS_FAKE_ENDED", message: "The simulated receiver reached the end of its recording", fatal: true))
        }
      }
      self.fakeTimer = timer
      timer.resume()
    }
  }

  private func markOpened(mtu: Int?, profile: String?, writable: Bool) {
    guard !opened, let t = target else { return }
    opened = true
    self.mtu = mtu
    backoff.onConnected(GnssLink.nowMs())
    setState("connected", t, profile: profile, writable: writable)
    if t.transport == "ble" { startRssi() }
  }

  /// Tears the current link down without reporting it.
  private func closeLink() {
    generation += 1
    stopTimers()
    if opened { backoff.onDisconnected(GnssLink.nowMs()) }
    opened = false
    failAllWrites(GnssError(code: "E_GNSS_NOT_CONNECTED", message: "The receiver was disconnected"))
    if let p = peripheral {
      p.delegate = nil
      if let ch = notifyChar, p.state == .connected { p.setNotifyValue(false, for: ch) }
      central?.cancelPeripheralConnection(p)
    }
    peripheral = nil
    notifyChar = nil
    writeChar = nil
    choice = nil
    mtu = nil
  }

  /// A link failed or dropped: retry (pending connect / backoff) or give up.
  private func linkFailed(_ error: GnssError) {
    guard let t = target else {
      closeLink()
      return
    }
    let wasOpen = opened
    let p = peripheral
    closeLink()
    emitError(error, t.deviceId)
    if error.fatal || !t.autoReconnect {
      target = nil
      persist(nil)
      setState("disconnected", t, reason: error.code)
      return
    }
    if t.transport != "fake", central?.state != .poweredOn {
      setState("reconnecting", t, reason: "bluetooth-off")
      return
    }
    // First retry after a working link: immediately, as a pending connect
    // that iOS completes even while the app is suspended. Later retries
    // (the link keeps failing) back off.
    // Only when iOS itself reports the peripheral gone: after a link WE
    // cancelled (stalled write, timeout) a disconnect callback is still due.
    let first = wasOpen && backoff.attempt == 0 && p?.state == .disconnected
    let delay = backoff.nextDelayMs()
    if first, let p, t.transport == "ble" {
      generation += 1
      peripheral = p
      p.delegate = self
      setState("reconnecting", t, reason: error.code)
      central?.connect(p, options: nil)
      return
    }
    setState("reconnecting", t, reason: error.code, retryInMs: delay)
    let gen = generation
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(delay))) {
      if gen == self.generation, self.target != nil, self.peripheral == nil { self.openCurrent() }
    }
  }

  private func stopTimers() {
    rssiTimer?.cancel()
    rssiTimer = nil
    fakeTimer?.cancel()
    fakeTimer = nil
    fakeCursor = nil
  }

  private func startRssi() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    let interval = DispatchTimeInterval.milliseconds(Int(GnssLink.rssiIntervalMs))
    timer.schedule(deadline: .now() + interval, repeating: interval)
    timer.setEventHandler {
      guard self.opened, let p = self.peripheral, p.state == .connected else { return }
      p.readRSSI()
    }
    rssiTimer = timer
    timer.resume()
  }

  // MARK: Writes

  private func pumpWrites() {
    guard opened, let p = peripheral, let ch = writeChar else { return }
    if writeType == .withoutResponse {
      // CoreBluetooth flow control: send while the peripheral's queue has
      // room; peripheralIsReady(toSendWriteWithoutResponse:) resumes.
      while !writes.isEmpty, p.canSendWriteWithoutResponse {
        let w = writes.removeFirst()
        p.writeValue(w.bytes, for: ch, type: .withoutResponse)
        if w.last { w.done?(nil) }
      }
      return
    }
    guard writeInFlight == nil, !writes.isEmpty else { return }
    let w = writes.removeFirst()
    writeInFlight = w
    p.writeValue(w.bytes, for: ch, type: .withResponse)
    writeStallGeneration += 1
    let gen = writeStallGeneration
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(GnssLink.writeStallMs))) {
      if gen == self.writeStallGeneration, self.writeInFlight != nil {
        self.linkFailed(GnssError(code: "E_GNSS_WRITE_STALLED", message: "The receiver stopped acknowledging writes"))
      }
    }
  }

  private func failPayload(_ w: PendingWrite, _ error: GnssError) {
    var done = w.last ? w.done : nil
    writes.removeAll { other in
      guard other.payload == w.payload else { return false }
      if other.last { done = other.done }
      return true
    }
    done?(error)
  }

  private func failAllWrites(_ error: GnssError) {
    writeStallGeneration += 1
    if let w = writeInFlight { failPayload(w, error) }
    writeInFlight = nil
    while let w = writes.first {
      writes.removeFirst()
      failPayload(w, error)
    }
  }

  // MARK: Bytes → JS

  private func received(_ data: Data) {
    ring.append(data)
    scheduleFlush()
  }

  private func scheduleFlush() {
    guard !flushScheduled, ring.size > 0, anyListening() else { return }
    flushScheduled = true
    let delay = pacer.delayMs(GnssLink.nowMs())
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(delay))) { self.flushNow() }
  }

  private func flushNow() {
    flushScheduled = false
    guard ring.size > 0, anyListening() else { return }
    let deviceId = target?.deviceId ?? (snapshot()["deviceId"] ?? nil) as? String
    var dropped = ring.takeDropped()
    while ring.size > 0 {
      let chunk = ring.take(GnssLink.maxEventBytes)
      emit("onBytes", [
        "deviceId": deviceId,
        "data": chunk.base64EncodedString(),
        "length": chunk.count,
        "dropped": Double(dropped),
      ])
      dropped = 0
    }
    pacer.flushed(GnssLink.nowMs())
  }

  // MARK: State

  private static func stateBody(
    _ state: String, _ t: GnssTarget?, _ mtu: Int?, _ profile: String?, _ writable: Bool
  ) -> [String: Any?] {
    [
      "state": state, "deviceId": t?.deviceId, "transport": t?.transport, "mtu": mtu,
      "profile": profile, "writable": writable, "attempt": 0, "reason": nil, "retryInMs": nil,
    ]
  }

  private func setState(
    _ state: String, _ t: GnssTarget?, reason: String? = nil, retryInMs: Int64? = nil,
    profile: String? = nil, writable: Bool = false
  ) {
    var body = GnssLink.stateBody(state, t, opened ? mtu : nil, opened ? profile : nil, opened && writable)
    body["attempt"] = backoff.attempt
    body["reason"] = reason
    body["retryInMs"] = retryInMs.map { Double($0) }
    lock.lock()
    snapshotValue = body
    lock.unlock()
    emit("onState", body)
  }
}

// MARK: - CBCentralManagerDelegate

extension GnssLink: CBCentralManagerDelegate {
  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    // Called before centralManagerDidUpdateState after a background
    // relaunch. Re-adopt the peripheral we were linked to; the rest happens
    // once the central is powered on.
    let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
    guard let saved = savedTarget(), saved.transport == "ble",
      let p = peripherals.first(where: { $0.identifier.uuidString == saved.deviceId })
    else { return }
    restoredPeripheral = p
    known[saved.deviceId] = p
    if target == nil { target = saved }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    let state = central.state
    let waiters = permissionWaiters
    if CBManager.authorization != .notDetermined {
      permissionWaiters = []
      waiters.forEach { $0() }
    }
    if state == .unknown || state == .resetting { return }
    let ready = whenReady
    whenReady = []
    let error: GnssError? = state == .poweredOn ? nil : GnssLink.stateError(state)
    ready.forEach { $0(error) }
    availability { body in self.emit("onAvailability", body) }
    if state != .poweredOn {
      stopScanNow(reason: state == .poweredOff ? "bluetooth-off" : nil)
      if let t = target, t.transport == "ble" {
        if state == .poweredOff {
          // Peripherals are invalidated: drop the link, keep the target.
          let wasOpen = opened
          closeLink()
          if wasOpen { emitError(GnssError(code: "E_GNSS_LINK_LOST", message: "Bluetooth was turned off"), t.deviceId) }
          setState("reconnecting", t, reason: "bluetooth-off")
        } else {
          linkFailed(GnssLink.stateError(state))
        }
      }
      return
    }
    // Powered on: resume a wanted link that is not running.
    if let t = target, t.transport == "ble", peripheral == nil {
      backoff.reset()
      openCurrent()
    }
  }

  func centralManager(
    _ central: CBCentralManager, didDiscover p: CBPeripheral,
    advertisementData: [String: Any], rssi RSSI: NSNumber
  ) {
    guard scanning else { return }
    let id = p.identifier.uuidString
    known[id] = p
    guard scanThrottle.shouldReport(id, GnssLink.nowMs()) else { return }
    var services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
    services += (advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID]) ?? []
    let rssi = RSSI.intValue
    emit("onDevice", [
      "id": id,
      "name": (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? p.name,
      "transport": "ble",
      // 127 means "not available" in CoreBluetooth.
      "rssi": rssi == 127 ? nil : rssi,
      "serviceUuids": services.compactMap { gnssNormalizeUuid($0.uuidString) },
      "bonded": false,
      "connectable": advertisementData[CBAdvertisementDataIsConnectable] as? Bool,
    ])
  }

  func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
    guard p === peripheral, target != nil else { return }
    startSetup(p)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
    guard p === peripheral else { return }
    linkFailed(GnssError(code: "E_GNSS_CONNECT_FAILED", message: error?.localizedDescription ?? "Could not connect"))
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
    guard p === peripheral else { return }
    let code = opened ? "E_GNSS_LINK_LOST" : "E_GNSS_CONNECT_FAILED"
    linkFailed(GnssError(code: code, message: error?.localizedDescription ?? "The receiver disconnected"))
  }
}

// MARK: - CBPeripheralDelegate

extension GnssLink: CBPeripheralDelegate {
  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    guard p === peripheral, let t = target else { return }
    if let error {
      linkFailed(GnssError(code: "E_GNSS_CONNECT_FAILED", message: "Service discovery failed: \(error.localizedDescription)"))
      return
    }
    let wanted = Set(t.profiles.map { $0.service })
    let matching = (p.services ?? []).filter { s in gnssNormalizeUuid(s.uuid.uuidString).map(wanted.contains) == true }
    if matching.isEmpty {
      let offered = (p.services ?? []).compactMap { gnssNormalizeUuid($0.uuid.uuidString) }.sorted()
      linkFailed(GnssError(
        code: "E_GNSS_NO_SERIAL_SERVICE",
        message: "No known serial service on this device. Services: \(offered.joined(separator: ", "))",
        fatal: true))
      return
    }
    pendingServices = matching.count
    for s in matching { p.discoverCharacteristics(nil, for: s) }
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard p === peripheral, let t = target, !opened else { return }
    if error == nil, let sid = gnssNormalizeUuid(service.uuid.uuidString) {
      var chars: [String: GnssCharCaps] = [:]
      for ch in service.characteristics ?? [] {
        guard let cid = gnssNormalizeUuid(ch.uuid.uuidString) else { continue }
        chars[cid] = GnssCharCaps(
          canNotify: !ch.properties.isDisjoint(with: [.notify, .indicate]),
          canWrite: !ch.properties.isDisjoint(with: [.write, .writeWithoutResponse]))
      }
      discovered[sid] = chars
    }
    pendingServices -= 1
    guard pendingServices <= 0 else { return }
    guard let picked = gnssSelectProfile(t.profiles, discovered) else {
      linkFailed(GnssError(code: "E_GNSS_NO_SERIAL_SERVICE", message: "No usable serial characteristics on this device", fatal: true))
      return
    }
    choice = picked
    func find(_ uuid: String?) -> CBCharacteristic? {
      guard let uuid else { return nil }
      let svc = p.services?.first { gnssNormalizeUuid($0.uuid.uuidString) == picked.profile.service }
      return svc?.characteristics?.first { gnssNormalizeUuid($0.uuid.uuidString) == uuid }
    }
    guard let out = find(picked.profile.notify) else {
      linkFailed(GnssError(code: "E_GNSS_CONNECT_FAILED", message: "The serial characteristic vanished during setup"))
      return
    }
    notifyChar = out
    if picked.writable, let w = find(picked.profile.write) {
      writeChar = w
      writeType = w.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
    }
    if out.isNotifying {
      markOpenedBle(p)
    } else {
      p.setNotifyValue(true, for: out)
    }
  }

  private func markOpenedBle(_ p: CBPeripheral) {
    let writable = choice?.writable == true && writeChar != nil
    // The ATT MTU is negotiated by iOS; report it as max write + 3 header bytes.
    markOpened(mtu: p.maximumWriteValueLength(for: .withoutResponse) + 3, profile: choice?.profile.name, writable: writable)
  }

  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
    guard p === peripheral, ch === notifyChar, !opened else { return }
    if let error {
      linkFailed(GnssError(code: "E_GNSS_NOTIFY_FAILED", message: "The receiver refused notifications: \(error.localizedDescription)"))
      return
    }
    if ch.isNotifying { markOpenedBle(p) }
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
    guard p === peripheral, ch === notifyChar, error == nil, let value = ch.value, !value.isEmpty else { return }
    received(value)
  }

  func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
    guard p === peripheral, let w = writeInFlight else { return }
    writeInFlight = nil
    writeStallGeneration += 1
    if let error {
      failPayload(w, GnssError(code: "E_GNSS_WRITE_FAILED", message: "The receiver rejected a write: \(error.localizedDescription)"))
    } else if w.last {
      w.done?(nil)
    }
    pumpWrites()
  }

  func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
    guard p === peripheral else { return }
    pumpWrites()
  }

  func peripheral(_ p: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
    guard p === peripheral, error == nil else { return }
    emit("onRssi", ["deviceId": target?.deviceId, "rssi": RSSI.intValue])
  }

  func peripheral(_ p: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
    // The receiver's firmware changed its GATT table (e.g. a reboot into
    // another mode): rebuild the link.
    guard p === peripheral, invalidatedServices.contains(where: { s in s.characteristics?.contains { $0 === notifyChar } == true }) else { return }
    linkFailed(GnssError(code: "E_GNSS_LINK_LOST", message: "The receiver changed its Bluetooth services"))
  }
}
