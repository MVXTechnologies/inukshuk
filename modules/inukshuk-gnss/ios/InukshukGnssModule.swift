import ExpoModulesCore
import Foundation

struct GattProfileRecord: Record {
  @Field var name: String = ""
  @Field var service: String = ""
  @Field var notify: String = ""
  @Field var write: String?
}

struct FakeDeviceRecord: Record {
  /// Base64 frames (e.g. one NMEA epoch each), replayed in order.
  @Field var frames: [String] = []
  @Field var intervalMs: Double = 1000
  @Field var loop: Bool = true
}

struct ConnectOptions: Record {
  @Field var deviceId: String = ""
  @Field var transport: String = ""
  @Field var profiles: [GattProfileRecord] = []
  @Field var autoReconnect: Bool = true
  /// Android only: iOS negotiates the ATT MTU itself.
  @Field var mtu: Double = 517
  @Field var fake: FakeDeviceRecord?
}

struct ScanOptions: Record {
  @Field var durationMs: Double = 15_000
}

struct KnownDevicesOptions: Record {
  @Field var serviceUuids: [String] = []
}

/// JS surface of the GNSS receiver transport (contract in
/// src/lib/gnss/nativeGnss.ts). Thin: validation and handing off to the
/// process-wide `GnssLink`.
public final class InukshukGnssModule: Module, GnssEventSink {
  public func definition() -> ModuleDefinition {
    Name("InukshukGnss")

    Events("onBytes", "onState", "onDevice", "onScanState", "onRssi", "onError", "onAvailability")

    OnCreate {
      GnssLink.shared.attach(self)
    }

    OnDestroy {
      // The link outlives this React instance on purpose; a scan does not.
      GnssLink.shared.detach(self)
      GnssLink.shared.stopScan(reason: nil)
    }

    OnStartObserving("onBytes") {
      GnssLink.shared.setListening(self, true)
    }

    OnStopObserving("onBytes") {
      GnssLink.shared.setListening(self, false)
    }

    AsyncFunction("getAvailability") { (promise: Promise) in
      GnssLink.shared.availability { promise.resolve($0) }
    }

    AsyncFunction("getPermissionsAsync") { () -> [String: Any] in
      GnssLink.permissionResponse()
    }

    AsyncFunction("requestPermissionsAsync") { (promise: Promise) in
      GnssLink.shared.requestPermission { promise.resolve($0) }
    }

    AsyncFunction("startScan") { (options: ScanOptions, promise: Promise) in
      GnssLink.shared.startScan(durationMs: Int64(options.durationMs)) { error in
        if let error { promise.reject(error.code, error.message) } else { promise.resolve(nil) }
      }
    }

    AsyncFunction("stopScan") { (promise: Promise) in
      GnssLink.shared.stopScan(reason: "stopped") { promise.resolve(nil) }
    }

    AsyncFunction("getKnownDevices") { (options: KnownDevicesOptions, promise: Promise) in
      GnssLink.shared.knownDevices(serviceUuids: options.serviceUuids) { devices, error in
        if let error { promise.reject(error.code, error.message) } else { promise.resolve(devices) }
      }
    }

    AsyncFunction("connect") { (options: ConnectOptions, promise: Promise) in
      let target: GnssTarget
      switch Self.parseTarget(options) {
      case .success(let t): target = t
      case .failure(let e): return promise.reject(e.code, e.message)
      }
      GnssLink.shared.connect(target) { error in
        if let error { promise.reject(error.code, error.message) } else { promise.resolve(nil) }
      }
    }

    AsyncFunction("disconnect") { (promise: Promise) in
      GnssLink.shared.disconnect { promise.resolve(nil) }
    }

    AsyncFunction("write") { (data: Data, promise: Promise) in
      GnssLink.shared.write(data) { error in
        if let error { promise.reject(error.code, error.message) } else { promise.resolve(nil) }
      }
    }

    Function("getState") { () -> [String: Any?] in
      GnssLink.shared.snapshot()
    }
  }

  func emit(_ name: String, _ body: [String: Any?]) {
    sendEvent(name, body)
  }

  private static func parseTarget(_ o: ConnectOptions) -> Result<GnssTarget, GnssError> {
    func bad(_ message: String) -> Result<GnssTarget, GnssError> {
      .failure(GnssError(code: "E_GNSS_BAD_ARGUMENT", message: message, fatal: true))
    }
    if o.deviceId.trimmingCharacters(in: .whitespaces).isEmpty { return bad("deviceId is required") }
    switch o.transport {
    case "ble":
      var profiles: [GnssGattProfile] = []
      for r in o.profiles {
        guard let p = GnssGattProfile(name: r.name, service: r.service, notify: r.notify, write: r.write) else {
          return bad("Invalid GATT profile '\(r.name)'")
        }
        profiles.append(p)
      }
      if profiles.isEmpty { return bad("A BLE connection needs at least one GATT profile") }
      return .success(GnssTarget(deviceId: o.deviceId, transport: "ble", profiles: profiles, autoReconnect: o.autoReconnect))
    case "fake":
      guard let f = o.fake else { return bad("The simulated receiver needs its frames") }
      var frames: [Data] = []
      for s in f.frames {
        guard let d = Data(base64Encoded: s) else { return bad("A simulated frame is not base64") }
        frames.append(d)
      }
      if frames.isEmpty { return bad("The simulated receiver needs at least one frame") }
      var t = GnssTarget(deviceId: o.deviceId, transport: "fake", profiles: [], autoReconnect: o.autoReconnect)
      t.fakeFrames = frames
      t.fakeIntervalMs = Int64(min(max(f.intervalMs, 20), 60_000))
      t.fakeLoop = f.loop
      return .success(t)
    case "spp":
      // No public Bluetooth Classic API on iOS (MFi External Accessory only).
      return .failure(GnssError(code: "E_GNSS_UNSUPPORTED_TRANSPORT", message: "Bluetooth Classic is not available on iOS", fatal: true))
    default:
      // "ea" (External Accessory, P3) and "tcp" are reserved names.
      return .failure(GnssError(code: "E_GNSS_UNSUPPORTED_TRANSPORT", message: "Unsupported transport '\(o.transport)'", fatal: true))
    }
  }
}
