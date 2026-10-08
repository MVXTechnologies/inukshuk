import Foundation
import Network

/// What the engine reports. Called on the engine's queue; must not block.
protocol MeshEngineDelegate: AnyObject {
  func meshConnected(_ peer: [String: Any?])
  func meshDisconnected(peerId: String?, dialId: String?, reason: String, retryInMs: Int64?)
  func meshFramesAvailable()
  func meshWritable(peerId: String)
  func meshPeerFound(_ service: [String: Any?])
  func meshPeerLost(serviceId: String)
  func meshError(code: String, message: String)
  func meshStateChanged()
}

struct MeshError: Error {
  let code: String
  let message: String
}

struct InFrame {
  let peerId: String
  let data: Data
}

/// Local-network privacy state as far as iOS lets an app observe it: there is
/// no query API, only a browser or listener that fails with PolicyDenied.
enum LocalNetworkState: String { case unknown, granted, denied }

/// The team mesh transport on Network.framework (#589): one NWListener (which
/// also carries the Bonjour advert), an NWBrowser, outgoing NWConnections with
/// reconnect, length-prefixed frames, send accounting with backpressure,
/// read throttling, connection limits, timeouts and bans.
///
/// Every piece of state lives on `queue`. The public methods hop onto it
/// (`queue.sync` for the few that return a value), so they may be called from
/// any thread except `queue` itself. No UIKit: the host test drives two
/// engines over 127.0.0.1 on macOS.
final class MeshEngine {
  private enum Target {
    case hostPort(String, Int)
    case service(NWEndpoint)
  }

  private final class Dial {
    let id: String
    let target: Target
    let reconnect: Bool
    var attempt = 0
    var conn: Conn?
    var cancelled = false
    var retry: DispatchWorkItem?
    init(id: String, target: Target, reconnect: Bool) {
      self.id = id
      self.target = target
      self.reconnect = reconnect
    }
  }

  private final class Conn {
    let id: String
    let connection: NWConnection
    let outbound: Bool
    let dial: Dial?
    var ip: String
    var port: Int
    let decoder: FrameDecoder
    let created: Int64
    var ready = false
    var established = false
    var establishedAt: Int64 = 0
    var lastRecv: Int64
    var lastSend: Int64
    var closed = false
    var receiving = false
    var queuedBytes = 0
    var wantWritable = false
    let bytesBucket: DebtBucket
    let framesBucket: DebtBucket
    var throttledUntil: Int64 = 0
    var inboxPaused = false
    var inboxBytes = 0
    var bytesIn = 0
    var bytesOut = 0
    var framesIn = 0
    var framesOut = 0

    init(id: String, connection: NWConnection, outbound: Bool, dial: Dial?, ip: String, port: Int, config: MeshConfig, now: Int64) {
      self.id = id
      self.connection = connection
      self.outbound = outbound
      self.dial = dial
      self.ip = ip
      self.port = port
      decoder = FrameDecoder(maxFrameBytes: config.maxFrameBytes)
      created = now
      lastRecv = now
      lastSend = now
      bytesBucket = DebtBucket(ratePerSec: Double(config.bytesPerSec), burst: Double(config.bytesPerSec) * 2)
      framesBucket = DebtBucket(ratePerSec: Double(config.framesPerSec), burst: Double(config.framesPerSec) * 2)
    }
  }

  let config: MeshConfig
  weak var delegate: MeshEngineDelegate?
  private let queue = DispatchQueue(label: "app.inukshuk.mesh", qos: .userInitiated)
  private let queueKey = DispatchSpecificKey<Bool>()

  private var running = false
  private var listener: NWListener?
  private var wantPort: UInt16 = 0
  private(set) var port: Int = -1
  /// The listener is bound and accepting (false while it is being reopened).
  private var listening = false
  private var listenerRestartAttempt = 0
  private var listenerRestart: DispatchWorkItem?

  private var advertTag: String?
  private var advertName: String?
  private var ownNames = Set<String>()
  private var browser: NWBrowser?
  private var browseTag: String?
  /// serviceId → (endpoints seen on each interface, tag)
  private var services: [String: (endpoints: [NWEndpoint], tag: String)] = [:]
  private var reported = Set<String>()
  private(set) var localNetwork: LocalNetworkState = .unknown

  private var conns: [String: Conn] = [:]
  private var dials: [String: Dial] = [:]
  private let bans: BanList
  private let acceptRate: AcceptRate
  private var inbox: [InFrame] = []
  private var inboxHead = 0
  private var inboxBytes = 0
  private var notifyPending = false
  private var nextId = 0
  private var timer: DispatchSourceTimer?
  private var rejected = 0
  private var violations = 0
  private var rng = SystemRandomNumberGenerator()

  static let maxServices = 256

  init(config: MeshConfig) {
    self.config = config
    bans = BanList(strikeBanMs: config.defaultBanMs)
    acceptRate = AcceptRate(perMinute: config.acceptsPerMinutePerIp)
    queue.setSpecific(key: queueKey, value: true)
  }

  private func nowMs() -> Int64 { Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000) }

  private func onQueue<T>(_ body: () throws -> T) rethrows -> T {
    if DispatchQueue.getSpecific(key: queueKey) == true { return try body() }
    return try queue.sync(execute: body)
  }

  private func makeId(_ prefix: String) -> String {
    nextId += 1
    return prefix + String(nextId)
  }

  private static func parameters() -> NWParameters {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.enableKeepalive = true
    tcp.connectionTimeout = 10
    let params = NWParameters(tls: nil, tcp: tcp)
    // LAN only: never let a team frame leave over cellular.
    params.prohibitedInterfaceTypes = [.cellular]
    params.includePeerToPeer = false
    return params
  }

  // MARK: Lifecycle

  /// Binds the listener (preferred port, else any). Blocks the caller (never
  /// the engine queue) until the listener is ready; returns the port.
  func start(timeout: TimeInterval = 5) throws -> Int {
    if onQueue({ running }) { return port }
    var result: Result<Int, MeshError>?
    let done = DispatchSemaphore(value: 0)
    queue.async {
      self.running = true
      self.wantPort = UInt16(clamping: self.config.preferredPort)
      self.openListener { outcome in
        if result == nil {
          result = outcome
          done.signal()
        }
      }
    }
    if done.wait(timeout: .now() + timeout) == .timedOut {
      stop()
      throw MeshError(code: "E_MESH_LISTEN", message: "Listener did not become ready")
    }
    switch onQueue({ result! }) {
    case .success(let p):
      onQueue { startTimer() }
      return p
    case .failure(let e):
      stop()
      throw e
    }
  }

  func stop() {
    onQueue {
      guard running || listener != nil else { return }
      running = false
      timer?.cancel()
      timer = nil
      listenerRestart?.cancel()
      listenerRestart = nil
      for c in Array(conns.values) { close(c, reason: "stopped", strike: false, allowRetry: false) }
      for d in dials.values { d.retry?.cancel() }
      dials.removeAll()
      browser?.cancel()
      browser = nil
      services.removeAll()
      reported.removeAll()
      listener?.cancel()
      listener = nil
      listening = false
      advertTag = nil
      advertName = nil
      port = -1
      inbox.removeAll()
      inboxHead = 0
      inboxBytes = 0
      notifyPending = false
    }
  }

  var isRunning: Bool { onQueue { running } }

  /// Opens (or reopens) the listener on `wantPort`; falls back to any port
  /// only on the first open (a reopen must keep the advertised port).
  private func openListener(fallbackAllowed: Bool = true, _ completion: ((Result<Int, MeshError>) -> Void)? = nil) {
    let params = Self.parameters()
    params.allowLocalEndpointReuse = true
    let l: NWListener
    do {
      if wantPort == 0 {
        l = try NWListener(using: params)
      } else {
        l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: wantPort)!)
      }
    } catch {
      completion?(.failure(MeshError(code: "E_MESH_LISTEN", message: "Cannot listen: \(error)")))
      return
    }
    listener = l
    var reported = false
    l.stateUpdateHandler = { [weak self, weak l] state in
      guard let self, let l, self.listener === l else { return }
      switch state {
      case .ready:
        self.listening = true
        self.port = Int(l.port?.rawValue ?? 0)
        self.wantPort = l.port?.rawValue ?? self.wantPort
        self.listenerRestartAttempt = 0
        if !reported { reported = true; completion?(.success(self.port)) }
        self.applyService()
        self.delegate?.meshStateChanged()
      case .waiting(let error), .failed(let error):
        if Self.isPolicyDenied(error) { self.setLocalNetwork(.denied) }
        if case .failed = state {
          l.cancel()
          self.listener = nil
          self.listening = false
          if !reported, fallbackAllowed, case .posix(let code) = error, code == .EADDRINUSE, self.wantPort != 0 {
            // Someone holds the well-known port: take any; the advert and
            // the invite carry the real one.
            reported = true
            self.wantPort = 0
            self.openListener(fallbackAllowed: false, completion)
            return
          }
          if !reported, let completion {
            reported = true
            completion(.failure(MeshError(code: "E_MESH_LISTEN", message: "Listener failed: \(error)")))
            return
          }
          reported = true
          // iOS reclaims a suspended app's listening sockets: reopen on the
          // same port with backoff (and at once on foreground, see resume()).
          self.delegate?.meshError(code: "E_MESH_LISTENER", message: "Listener failed: \(error)")
          self.scheduleListenerRestart()
          self.delegate?.meshStateChanged()
        }
      default:
        break
      }
    }
    l.newConnectionHandler = { [weak self] nw in self?.accept(nw) }
    l.serviceRegistrationUpdateHandler = { [weak self] change in
      guard let self else { return }
      if case .add(let endpoint) = change, case .service(let name, _, _, _) = endpoint {
        // Bonjour may rename us on a collision: remember the real name.
        self.ownNames.insert(name)
        self.advertName = name
        self.delegate?.meshStateChanged()
      }
    }
    l.start(queue: queue)
  }

  private func scheduleListenerRestart() {
    guard running, listenerRestart == nil else { return }
    let delay = Backoff.delayMs(attempt: listenerRestartAttempt, unit: Double.random(in: 0..<1, using: &rng))
    listenerRestartAttempt += 1
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.listenerRestart = nil
      guard self.running, self.listener == nil else { return }
      self.openListener(fallbackAllowed: false)
    }
    listenerRestart = work
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(delay)), execute: work)
  }

  /// Back in the foreground: a listener or browser the OS tore down while
  /// suspended is reopened now (same port, same advert, same browse filter).
  /// After a real suspension (`afterSuspension`) the listener is replaced
  /// even if it still claims to be ready: iOS reclaims a suspended app's
  /// listening sockets and the object does not always notice (the loopback
  /// server in src/data/localServer.ts hit exactly that). Accepted
  /// connections are independent of the listener and are left alone.
  func resume(afterSuspension: Bool) {
    onQueue {
      guard running else { return }
      var dead = listener == nil || afterSuspension
      if case .cancelled? = listener?.state { dead = true }
      if case .failed? = listener?.state { dead = true }
      if dead {
        listenerRestart?.cancel()
        listenerRestart = nil
        listenerRestartAttempt = 0
        listening = false
        if let old = listener {
          // Reopen once the old socket is really gone, or the bind races it.
          listener = nil
          old.newConnectionHandler = nil
          old.stateUpdateHandler = { [weak self] state in
            guard let self, case .cancelled = state, self.running, self.listener == nil else { return }
            self.openListener(fallbackAllowed: false)
          }
          old.cancel()
        } else {
          openListener(fallbackAllowed: false)
        }
      }
      var browserDead = afterSuspension
      if let b = browser, case .failed = b.state { browserDead = true }
      if let b = browser, browserDead {
        b.stateUpdateHandler = nil
        b.browseResultsChangedHandler = nil
        b.cancel()
        browser = nil
        startBrowserLocked(tag: browseTag)
      }
    }
  }

  /// Bytes handed to sockets but not yet sent: the module keeps a background
  /// task alive while this is above zero.
  func pendingSendBytes() -> Int { onQueue { conns.values.reduce(0) { $0 + $1.queuedBytes } } }

  // MARK: Discovery

  func startAdvertising(tag: String) throws {
    try onQueue {
      guard running else { throw MeshError(code: "E_MESH_NOT_RUNNING", message: "The mesh is not started") }
      advertTag = tag
      advertName = MeshTags.instanceName(using: &rng)
      ownNames.insert(advertName!)
      applyService()
      delegate?.meshStateChanged()
    }
  }

  func stopAdvertising() {
    onQueue {
      advertTag = nil
      advertName = nil
      applyService()
      delegate?.meshStateChanged()
    }
  }

  private func applyService() {
    guard let l = listener else { return }
    if let tag = advertTag, let name = advertName {
      let txt = NWTXTRecord(["v": "1", "t": tag])
      l.service = NWListener.Service(name: name, type: MeshTags.serviceType, domain: nil, txtRecord: txt.data)
    } else {
      l.service = nil
    }
  }

  var isAdvertising: Bool { onQueue { advertTag != nil } }
  var localNetworkState: LocalNetworkState { onQueue { localNetwork } }
  var isBrowsing: Bool { onQueue { browser != nil } }

  func startBrowsing(tag: String?) throws {
    try onQueue {
      guard running else { throw MeshError(code: "E_MESH_NOT_RUNNING", message: "The mesh is not started") }
      browseTag = tag
      if browser != nil {
        // Same browse, new filter: re-report what we know under it.
        reported.removeAll()
        for (name, s) in services where tag == nil || s.tag == tag { report(name, s.tag) }
        return
      }
      startBrowserLocked(tag: tag)
      delegate?.meshStateChanged()
    }
  }

  private func startBrowserLocked(tag: String?) {
    let b = NWBrowser(for: .bonjourWithTXTRecord(type: MeshTags.serviceType, domain: nil), using: Self.parameters())
    browser = b
    b.stateUpdateHandler = { [weak self, weak b] state in
      guard let self, let b, self.browser === b else { return }
      switch state {
      case .ready:
        if self.localNetwork != .granted { self.setLocalNetwork(.granted) }
      case .waiting(let error), .failed(let error):
        if Self.isPolicyDenied(error) {
          self.setLocalNetwork(.denied)
        } else {
          self.delegate?.meshError(code: "E_MESH_BROWSE", message: "Browsing: \(error)")
        }
      default:
        break
      }
    }
    b.browseResultsChangedHandler = { [weak self, weak b] results, _ in
      guard let self, let b, self.browser === b else { return }
      self.updateServices(results)
    }
    b.start(queue: queue)
  }

  func stopBrowsing() {
    onQueue {
      browser?.cancel()
      browser = nil
      services.removeAll()
      reported.removeAll()
      delegate?.meshStateChanged()
    }
  }

  private func updateServices(_ results: Set<NWBrowser.Result>) {
    var next: [String: (endpoints: [NWEndpoint], tag: String)] = [:]
    for r in results {
      guard case .service(let name, _, _, _) = r.endpoint, !ownNames.contains(name) else { continue }
      guard case .bonjour(let txt) = r.metadata, txt["v"] == "1", let tag = txt["t"], MeshTags.isValid(tag) else { continue }
      if next[name] == nil && next.count >= Self.maxServices { continue }
      var entry = next[name] ?? (endpoints: [], tag: tag)
      entry.endpoints.append(r.endpoint)
      next[name] = entry
    }
    for name in services.keys where next[name] == nil {
      if reported.remove(name) != nil { delegate?.meshPeerLost(serviceId: name) }
    }
    services = next
    for (name, s) in next where !reported.contains(name) && (browseTag == nil || s.tag == browseTag) {
      report(name, s.tag)
    }
  }

  private func report(_ name: String, _ tag: String) {
    reported.insert(name)
    // iOS resolves a service only when connecting: no host or port here.
    delegate?.meshPeerFound(["serviceId": name, "tag": tag, "host": nil, "port": nil])
  }

  private func setLocalNetwork(_ state: LocalNetworkState) {
    guard localNetwork != state else { return }
    localNetwork = state
    if state == .denied {
      delegate?.meshError(code: "E_MESH_LOCAL_NETWORK_DENIED",
        message: "Local Network access is off for Inukshuk (Settings › Privacy & Security › Local Network)")
    }
    delegate?.meshStateChanged()
  }

  static func isPolicyDenied(_ error: NWError) -> Bool {
    // kDNSServiceErr_PolicyDenied: the user declined (or has not yet granted) Local Network.
    if case .dns(let code) = error, code == -65570 { return true }
    return false
  }

  // MARK: Commands

  func connect(host: String, port: Int, reconnect: Bool) throws -> String {
    guard !host.isEmpty, host.utf8.count <= 255 else { throw MeshError(code: "E_MESH_ARGUMENT", message: "Invalid host") }
    guard (1...65535).contains(port) else { throw MeshError(code: "E_MESH_ARGUMENT", message: "Invalid port") }
    return try onQueue {
      guard running else { throw MeshError(code: "E_MESH_NOT_RUNNING", message: "The mesh is not started") }
      let dial = Dial(id: makeId("d"), target: .hostPort(host, port), reconnect: reconnect)
      dials[dial.id] = dial
      queue.async { self.attempt(dial) }
      return dial.id
    }
  }

  func connectService(_ serviceId: String, reconnect: Bool) throws -> String {
    try onQueue {
      guard running else { throw MeshError(code: "E_MESH_NOT_RUNNING", message: "The mesh is not started") }
      guard let endpoint = services[serviceId]?.endpoints.first else {
        throw MeshError(code: "E_MESH_UNKNOWN_SERVICE", message: "No discovered service \(serviceId)")
      }
      let dial = Dial(id: makeId("d"), target: .service(endpoint), reconnect: reconnect)
      dials[dial.id] = dial
      queue.async { self.attempt(dial) }
      return dial.id
    }
  }

  /// Closes a peer (by peer id) or cancels a dial and its retries (by dial id).
  func disconnect(_ id: String) {
    onQueue {
      if let dial = dials.removeValue(forKey: id) {
        dial.cancelled = true
        dial.retry?.cancel()
        if let c = dial.conn { close(c, reason: "local", strike: false, allowRetry: false) }
      }
      if let c = conns[id] {
        if let d = c.dial { d.cancelled = true; d.retry?.cancel(); dials[d.id] = nil }
        close(c, reason: "local", strike: false, allowRetry: false)
      }
    }
  }

  /// Bans the peer's address for `durationMs` (capped at 24 h) and closes it.
  func ban(_ peerId: String, durationMs: Int64) {
    let ms = min(max(durationMs, 1_000), MeshConfig.maxBanMs)
    onQueue {
      guard let c = conns[peerId] else { return }
      let now = nowMs()
      bans.ban(c.ip, untilMs: now + ms, nowMs: now)
      if let d = c.dial { d.cancelled = true; d.retry?.cancel(); dials[d.id] = nil }
      close(c, reason: "banned", strike: false, allowRetry: false)
    }
  }

  /// Queues one frame; returns the peer's queued bytes after it. Throws
  /// E_MESH_NO_PEER, E_MESH_FRAME_TOO_LARGE or E_MESH_BACKPRESSURE (not
  /// queued; an onWritable event follows once the queue has drained).
  func send(_ peerId: String, _ payload: Data) throws -> Int {
    if payload.isEmpty { throw MeshError(code: "E_MESH_ARGUMENT", message: "Empty frames are reserved for keepalives") }
    if payload.count > config.maxFrameBytes {
      throw MeshError(code: "E_MESH_FRAME_TOO_LARGE", message: "Frame of \(payload.count) bytes exceeds \(config.maxFrameBytes)")
    }
    return try onQueue {
      guard let c = conns[peerId], c.established, !c.closed else {
        throw MeshError(code: "E_MESH_NO_PEER", message: "No connected peer \(peerId)")
      }
      let wire = MeshWire.encode(payload)
      if c.queuedBytes + wire.count > config.maxQueuedBytes {
        c.wantWritable = true
        throw MeshError(code: "E_MESH_BACKPRESSURE", message: "Send queue for \(peerId) is full")
      }
      c.framesOut += 1
      write(c, wire)
      return c.queuedBytes
    }
  }

  func takeFrames(max: Int) -> [InFrame] {
    onQueue {
      let n = min(max, inbox.count - inboxHead)
      guard n > 0 else { notifyPending = false; return [] }
      let out = Array(inbox[inboxHead..<(inboxHead + n)])
      inboxHead += n
      if inboxHead > 1024 && inboxHead * 2 > inbox.count {
        inbox.removeFirst(inboxHead)
        inboxHead = 0
      }
      for f in out {
        inboxBytes -= f.data.count
        if let c = conns[f.peerId] { c.inboxBytes -= f.data.count }
      }
      if inboxHead == inbox.count {
        inbox.removeAll(keepingCapacity: true)
        inboxHead = 0
        notifyPending = false
      }
      resumeInboxPaused()
      return out
    }
  }

  func stats() -> [String: Any?] {
    onQueue {
      let now = nowMs()
      let peers: [[String: Any?]] = conns.values.filter { !$0.closed }.map { c in
        [
          "peerId": c.id, "dialId": c.dial?.id, "host": c.ip, "port": c.port,
          "direction": c.outbound ? "out" : "in", "established": c.established,
          "queuedBytes": Double(c.queuedBytes), "inboxBytes": Double(c.inboxBytes),
          "bytesIn": Double(c.bytesIn), "bytesOut": Double(c.bytesOut),
          "framesIn": Double(c.framesIn), "framesOut": Double(c.framesOut),
          "keepalivesIn": Double(c.decoder.keepalives),
          "throttled": c.throttledUntil > now || c.inboxPaused,
        ]
      }
      return [
        "running": running, "listening": listening, "port": port > 0 ? port : nil, "peers": peers,
        "inboxBytes": Double(inboxBytes), "inboxFrames": inbox.count - inboxHead,
        "activeBans": bans.activeCount(nowMs: now), "rejectedConnections": Double(rejected),
        "violations": Double(violations),
      ]
    }
  }

  // MARK: Connections (queue only)

  private static func hostString(_ host: NWEndpoint.Host) -> String {
    switch host {
    case .ipv4(let a):
      let b = [UInt8](a.rawValue)
      return b.count == 4 ? "\(b[0]).\(b[1]).\(b[2]).\(b[3])" : "\(a)"
    case .ipv6(let a):
      // An IPv4-mapped address is the IPv4 peer it maps.
      if let v4 = a.asIPv4 { return hostString(.ipv4(v4)) }
      return "\(a)".components(separatedBy: "%").first ?? "\(a)"
    case .name(let n, _):
      return n
    @unknown default:
      return "\(host)"
    }
  }

  private static func hostPort(_ endpoint: NWEndpoint?) -> (String, Int)? {
    guard case .hostPort(let h, let p)? = endpoint else { return nil }
    return (hostString(h), Int(p.rawValue))
  }

  private func accept(_ nw: NWConnection) {
    guard running else { nw.cancel(); return }
    let (ip, rport) = Self.hostPort(nw.endpoint) ?? ("?", 0)
    let now = nowMs()
    var reject: String?
    if bans.isBanned(ip, nowMs: now) {
      reject = "banned"
    } else if !acceptRate.admit(ip, nowMs: now) {
      bans.strike(ip, nowMs: now)
      reject = "rate"
    } else if conns.count >= config.maxPeers {
      reject = "limit"
    } else if conns.values.filter({ !$0.outbound && $0.ip == ip }).count >= config.maxInboundPerIp {
      reject = "per-ip"
    } else if conns.values.filter({ !$0.outbound && !$0.established }).count >= config.maxPendingInbound {
      reject = "pending"
    }
    if reject != nil {
      rejected += 1
      nw.cancel()
      return
    }
    let c = Conn(id: makeId("p"), connection: nw, outbound: false, dial: nil, ip: ip, port: rport, config: config, now: now)
    conns[c.id] = c
    run(c)
  }

  private func attempt(_ dial: Dial) {
    guard running, !dial.cancelled, dials[dial.id] === dial else { return }
    let endpoint: NWEndpoint
    var ip = "?"
    var rport = 0
    switch dial.target {
    case .hostPort(let host, let port):
      ip = host
      rport = port
      if bans.isBanned(host, nowMs: nowMs()) {
        dials[dial.id] = nil
        delegate?.meshDisconnected(peerId: nil, dialId: dial.id, reason: "banned", retryInMs: nil)
        return
      }
      endpoint = .hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: UInt16(port))!)
    case .service(let e):
      endpoint = e
    }
    if conns.count >= config.maxPeers {
      scheduleRetry(dial, report: "limit")
      return
    }
    let nw = NWConnection(to: endpoint, using: Self.parameters())
    let c = Conn(id: makeId("p"), connection: nw, outbound: true, dial: dial, ip: ip, port: rport, config: config, now: nowMs())
    dial.conn = c
    conns[c.id] = c
    run(c)
  }

  private func run(_ c: Conn) {
    c.connection.stateUpdateHandler = { [weak self] state in
      guard let self, !c.closed else { return }
      switch state {
      case .ready:
        guard !c.ready else { return }
        c.ready = true
        if let (h, p) = Self.hostPort(c.connection.currentPath?.remoteEndpoint) {
          c.ip = h
          c.port = p
        }
        if self.bans.isBanned(c.ip, nowMs: self.nowMs()) {
          self.close(c, reason: "banned", strike: false, allowRetry: false)
          return
        }
        if c.outbound && self.localNetwork != .granted { self.setLocalNetwork(.granted) }
        c.lastRecv = self.nowMs()
        self.write(c, MeshWire.preamble())
        self.receive(c)
      case .waiting(let error):
        if Self.isPolicyDenied(error) { self.setLocalNetwork(.denied) }
        // A dial waits for a route forever; the connect timeout ends it.
      case .failed:
        self.close(c, reason: c.ready ? "io-error" : "connect-failed", strike: false, allowRetry: true)
      default:
        break
      }
    }
    c.connection.start(queue: queue)
  }

  private func receive(_ c: Conn) {
    guard !c.closed, !c.receiving, !c.inboxPaused, c.throttledUntil == 0 else { return }
    c.receiving = true
    // One receive (at most 64 KB) per inbox check: consume() pauses the peer
    // once the inbox is past its bound, so it can overshoot by one receive and
    // the frame the decoder was finishing, never more (the bound the tests hold).
    c.connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      c.receiving = false
      if c.closed { return }
      if let data, !data.isEmpty { self.consume(c, data) }
      if c.closed { return }
      if isComplete {
        self.close(c, reason: "remote-closed", strike: false, allowRetry: true)
      } else if error != nil {
        self.close(c, reason: "io-error", strike: false, allowRetry: true)
      } else {
        self.receive(c)
      }
    }
  }

  private func consume(_ c: Conn, _ data: Data) {
    let now = nowMs()
    var frames: [Data] = []
    let keepalivesBefore = c.decoder.keepalives
    let status = c.decoder.feed(data, into: &frames)
    c.bytesIn += data.count
    c.lastRecv = now
    if status != .ok {
      violations += 1
      let reason: String
      switch status {
      case .badMagic: reason = "bad-magic"
      case .incompatible: reason = "incompatible"
      case .oversize: reason = "oversize"
      case .ok: reason = "io-error"
      }
      // A newer app version is not an attacker: close without a strike.
      close(c, reason: reason, strike: status != .incompatible, allowRetry: false)
      return
    }
    if !c.established && c.decoder.preambleDone { establish(c) }
    c.bytesBucket.charge(Double(data.count), nowMs: now)
    c.framesBucket.charge(Double(frames.count + c.decoder.keepalives - keepalivesBefore), nowMs: now)
    if !frames.isEmpty {
      var size = 0
      for f in frames {
        inbox.append(InFrame(peerId: c.id, data: f))
        size += f.count
      }
      c.framesIn += frames.count
      c.inboxBytes += size
      inboxBytes += size
      if !notifyPending {
        notifyPending = true
        delegate?.meshFramesAvailable()
      }
      if c.inboxBytes > config.maxInboxBytesPerPeer || inboxBytes > config.maxInboxBytes {
        // JS is not keeping up: stop reading this peer until it does.
        c.inboxPaused = true
      }
    }
    let wait = max(c.bytesBucket.waitMs(nowMs: now), c.framesBucket.waitMs(nowMs: now))
    if wait > 0 {
      c.throttledUntil = now + wait
      queue.asyncAfter(deadline: .now() + .milliseconds(Int(wait))) { [weak self] in
        guard let self, !c.closed else { return }
        c.throttledUntil = 0
        c.lastRecv = self.nowMs()
        self.receive(c)
      }
    }
  }

  private func resumeInboxPaused() {
    guard inboxBytes <= config.maxInboxBytes / 2 else { return }
    for c in conns.values where c.inboxPaused && c.inboxBytes <= config.maxInboxBytesPerPeer / 2 {
      c.inboxPaused = false
      c.lastRecv = nowMs()
      receive(c)
    }
  }

  private func write(_ c: Conn, _ wire: Data) {
    let n = wire.count
    c.queuedBytes += n
    c.lastSend = nowMs()
    c.connection.send(content: wire, completion: .contentProcessed { [weak self] error in
      guard let self, !c.closed else { return }
      c.queuedBytes -= n
      c.bytesOut += n
      if error != nil {
        self.close(c, reason: "io-error", strike: false, allowRetry: true)
        return
      }
      if c.wantWritable && c.queuedBytes <= self.config.maxQueuedBytes / 4 {
        c.wantWritable = false
        if c.established { self.delegate?.meshWritable(peerId: c.id) }
      }
    })
  }

  private func establish(_ c: Conn) {
    c.established = true
    c.establishedAt = nowMs()
    delegate?.meshConnected([
      "peerId": c.id, "dialId": c.dial?.id, "host": c.ip, "port": c.port,
      "direction": c.outbound ? "out" : "in",
    ])
  }

  private func close(_ c: Conn, reason: String, strike: Bool, allowRetry: Bool) {
    guard !c.closed else { return }
    c.closed = true
    conns[c.id] = nil
    c.connection.stateUpdateHandler = nil
    c.connection.cancel()
    c.queuedBytes = 0
    if strike { bans.strike(c.ip, nowMs: nowMs()) }
    var retryIn: Int64?
    let dial = c.dial
    if let dial, dial.conn === c {
      dial.conn = nil
      if allowRetry && dial.reconnect && !dial.cancelled && running {
        if c.established && nowMs() - c.establishedAt >= Backoff.stableMs { dial.attempt = 0 }
        retryIn = scheduleRetry(dial, report: nil)
      } else {
        dials[dial.id] = nil
      }
    }
    // A connection that never finished its preamble was never announced.
    if c.established {
      delegate?.meshDisconnected(peerId: c.id, dialId: dial?.id, reason: reason, retryInMs: retryIn)
    } else if let dial {
      delegate?.meshDisconnected(peerId: nil, dialId: dial.id, reason: reason, retryInMs: retryIn)
    }
  }

  @discardableResult
  private func scheduleRetry(_ dial: Dial, report: String?) -> Int64? {
    guard dial.reconnect, !dial.cancelled, running else {
      dials[dial.id] = nil
      if let report { delegate?.meshDisconnected(peerId: nil, dialId: dial.id, reason: report, retryInMs: nil) }
      return nil
    }
    let delay = Backoff.delayMs(attempt: dial.attempt, unit: Double.random(in: 0..<1, using: &rng))
    dial.attempt += 1
    let work = DispatchWorkItem { [weak self] in self?.attempt(dial) }
    dial.retry = work
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(delay)), execute: work)
    if let report { delegate?.meshDisconnected(peerId: nil, dialId: dial.id, reason: report, retryInMs: delay) }
    return delay
  }

  private func startTimer() {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
    t.setEventHandler { [weak self] in self?.timers() }
    timer = t
    t.resume()
  }

  private func timers() {
    guard running else { return }
    let now = nowMs()
    for c in Array(conns.values) where !c.closed {
      if !c.ready {
        if now - c.created > config.connectTimeoutMs {
          close(c, reason: "connect-timeout", strike: false, allowRetry: true)
        }
        continue
      }
      if !c.established {
        if now - c.created > config.handshakeTimeoutMs {
          // An inbound socket that never says hello is a probe or a slowloris.
          close(c, reason: "handshake-timeout", strike: !c.outbound, allowRetry: true)
        }
        continue
      }
      let reading = !c.inboxPaused && c.throttledUntil == 0
      if reading && now - c.lastRecv > config.idleTimeoutMs {
        close(c, reason: "idle", strike: false, allowRetry: true)
        continue
      }
      if now - c.lastSend > config.keepaliveMs && c.queuedBytes == 0 {
        write(c, MeshWire.keepalive())
      }
    }
  }
}
