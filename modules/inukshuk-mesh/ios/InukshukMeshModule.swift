import ExpoModulesCore
import Foundation
import UIKit

/// Team mesh transport (#589): LAN / phone-hotspot TCP with Bonjour discovery.
/// Moves opaque frames between peers; identity, crypto and sync stay in JS
/// (src/core/team). JS binding: src/data/team/meshNative.ts. Design, limits
/// and the background story: docs/design/team-mesh.md.
public final class InukshukMeshModule: Module, MeshEngineDelegate {
  private let lock = NSLock()
  private var engine: MeshEngine?
  private var statsTimer: DispatchSourceTimer?
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var backgroundedAt: Date?

  public func definition() -> ModuleDefinition {
    Name("InukshukMesh")

    Events(
      "onPeerFound", "onPeerLost", "onConnected", "onDisconnected", "onFramesAvailable",
      "onWritable", "onError", "onStateChanged", "onStats"
    )

    Constant("defaultPort") { MeshConfig.defaultPort }
    Constant("serviceType") { MeshTags.serviceType }
    Constant("maxFrameCeiling") { MeshWire.maxFrameCeiling }

    AsyncFunction("start") { (config: [String: Any]?) throws -> [String: Any] in
      if let running = self.current(), running.isRunning {
        return ["port": running.port, "alreadyRunning": true]
      }
      let e = MeshEngine(config: MeshConfig.from(config))
      e.delegate = self
      let port: Int
      do { port = try e.start() } catch let error as MeshError { throw Self.coded(error) }
      self.lock.lock()
      self.engine = e
      self.lock.unlock()
      self.startStatsTimer(e)
      self.emit("onStateChanged", self.state())
      return ["port": port, "alreadyRunning": false]
    }

    AsyncFunction("stop") {
      self.stopAll()
      self.emit("onStateChanged", self.state())
    }

    AsyncFunction("startAdvertising") { (tag: String) throws in
      guard MeshTags.isValid(tag) else { throw Self.coded(MeshError(code: "E_MESH_ARGUMENT", message: "Invalid discovery tag")) }
      do { try self.requireEngine().startAdvertising(tag: tag) } catch let error as MeshError { throw Self.coded(error) }
    }

    Function("stopAdvertising") {
      self.current()?.stopAdvertising()
    }

    AsyncFunction("startBrowsing") { (tag: String?) throws in
      if let tag, !MeshTags.isValid(tag) {
        throw Self.coded(MeshError(code: "E_MESH_ARGUMENT", message: "Invalid discovery tag"))
      }
      do { try self.requireEngine().startBrowsing(tag: tag) } catch let error as MeshError { throw Self.coded(error) }
    }

    Function("stopBrowsing") {
      self.current()?.stopBrowsing()
    }

    Function("connect") { (host: String, port: Int, reconnect: Bool) throws -> String in
      do { return try self.requireEngine().connect(host: host, port: port, reconnect: reconnect) } catch let error as MeshError {
        throw Self.coded(error)
      }
    }

    Function("connectService") { (serviceId: String, reconnect: Bool) throws -> String in
      do { return try self.requireEngine().connectService(serviceId, reconnect: reconnect) } catch let error as MeshError {
        throw Self.coded(error)
      }
    }

    Function("disconnect") { (id: String) in
      self.current()?.disconnect(id)
    }

    Function("send") { (peerId: String, data: Data) throws -> Double in
      do { return Double(try self.requireEngine().send(peerId, data)) } catch let error as MeshError { throw Self.coded(error) }
    }

    Function("takeFrames") { (max: Int) -> [[String: Any]] in
      guard let e = self.current() else { return [] }
      return e.takeFrames(max: min(Swift.max(max, 1), 1024)).map { ["peerId": $0.peerId, "data": $0.data] }
    }

    Function("ban") { (peerId: String, durationMs: Double) in
      let ms = durationMs.isFinite ? Int64(Swift.min(Swift.max(durationMs, 0), Double(MeshConfig.maxBanMs))) : MeshConfig.maxBanMs
      self.current()?.ban(peerId, durationMs: ms)
    }

    Function("getStats") { () -> [String: Any] in
      guard let e = self.current() else { return ["running": false, "peers": [Any]()] }
      return Self.clean(e.stats())
    }

    Function("getState") { () -> [String: Any] in
      self.state()
    }

    Function("getNetworkInfo") { () -> [String: Any] in
      var info = MeshInterfaces.read()
      if let e = self.current(), e.isRunning { info["port"] = e.port } else { info["port"] = NSNull() }
      return info
    }

    // iOS gives a backgrounded app a few seconds before suspending it, and
    // reclaims its listening sockets while suspended (docs/design/team-mesh.md
    // §Background). Ask for a short background task while frames are still
    // queued, so a message typed just before locking the phone goes out;
    // nothing else runs in the background unless the app is already kept
    // alive by an active trail recording (UIBackgroundModes: location).
    OnAppEntersBackground {
      self.backgroundedAt = Date()
      self.flushInBackground()
    }

    OnAppEntersForeground {
      let away = self.backgroundedAt.map { Date().timeIntervalSince($0) } ?? 0
      self.backgroundedAt = nil
      self.endBackgroundTask()
      self.current()?.resume(afterSuspension: away >= 5)
    }

    OnDestroy {
      self.stopAll()
    }
  }

  // MARK: Helpers

  private func current() -> MeshEngine? {
    lock.lock()
    defer { lock.unlock() }
    return engine
  }

  private func requireEngine() throws -> MeshEngine {
    guard let e = current(), e.isRunning else {
      throw MeshError(code: "E_MESH_NOT_RUNNING", message: "The mesh is not started")
    }
    return e
  }

  private static func coded(_ error: MeshError) -> Exception {
    Exception(name: error.code, description: error.message, code: error.code)
  }

  private func state() -> [String: Any] {
    guard let e = current() else {
      return ["running": false, "port": NSNull(), "advertising": false, "browsing": false, "localNetwork": "unknown"]
    }
    let running = e.isRunning
    return [
      "running": running,
      "port": running && e.port > 0 ? e.port : NSNull(),
      "advertising": e.isAdvertising,
      "browsing": e.isBrowsing,
      "localNetwork": e.localNetworkState.rawValue,
    ]
  }

  private func stopAll() {
    lock.lock()
    let e = engine
    engine = nil
    lock.unlock()
    statsTimer?.cancel()
    statsTimer = nil
    e?.delegate = nil
    e?.stop()
    endBackgroundTask()
  }

  private func startStatsTimer(_ e: MeshEngine) {
    statsTimer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    t.schedule(deadline: .now() + 5, repeating: 5)
    t.setEventHandler { [weak self, weak e] in
      guard let self, let e, e.isRunning else { return }
      self.emit("onStats", Self.clean(e.stats()))
    }
    statsTimer = t
    t.resume()
  }

  private func flushInBackground() {
    guard let e = current(), e.isRunning, e.pendingSendBytes() > 0 else { return }
    DispatchQueue.main.async {
      guard self.backgroundTask == .invalid else { return }
      self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "inukshuk-mesh-flush") {
        self.endBackgroundTask()
      }
      self.pollFlush(deadline: Date().addingTimeInterval(20))
    }
  }

  private func pollFlush(deadline: Date) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      guard self.backgroundTask != .invalid else { return }
      let pending = self.current()?.pendingSendBytes() ?? 0
      if pending == 0 || Date() > deadline {
        self.endBackgroundTask()
      } else {
        self.pollFlush(deadline: deadline)
      }
    }
  }

  private func endBackgroundTask() {
    let finish = {
      if self.backgroundTask != .invalid {
        UIApplication.shared.endBackgroundTask(self.backgroundTask)
        self.backgroundTask = .invalid
      }
    }
    if Thread.isMainThread { finish() } else { DispatchQueue.main.async(execute: finish) }
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    sendEvent(name, body)
  }

  /// Optionals become NSNull so every value crosses the bridge as JSON.
  static func clean(_ dict: [String: Any?]) -> [String: Any] {
    var out: [String: Any] = [:]
    for (k, v) in dict {
      switch v {
      case .none: out[k] = NSNull()
      case .some(let inner as [String: Any?]): out[k] = clean(inner)
      case .some(let list as [[String: Any?]]): out[k] = list.map { clean($0) }
      case .some(let value): out[k] = value
      }
    }
    return out
  }

  // MARK: MeshEngineDelegate (engine queue)

  func meshConnected(_ peer: [String: Any?]) { emit("onConnected", Self.clean(peer)) }

  func meshDisconnected(peerId: String?, dialId: String?, reason: String, retryInMs: Int64?) {
    emit("onDisconnected", Self.clean([
      "peerId": peerId, "dialId": dialId, "reason": reason, "retryInMs": retryInMs.map { Double($0) },
    ]))
  }

  func meshFramesAvailable() { emit("onFramesAvailable", [:]) }
  func meshWritable(peerId: String) { emit("onWritable", ["peerId": peerId]) }
  func meshPeerFound(_ service: [String: Any?]) { emit("onPeerFound", Self.clean(service)) }
  func meshPeerLost(serviceId: String) { emit("onPeerLost", ["serviceId": serviceId]) }
  func meshError(code: String, message: String) { emit("onError", ["code": code, "message": message]) }

  func meshStateChanged() {
    // Called on the engine queue: read the state off it, never sync back into it.
    DispatchQueue.global(qos: .utility).async { self.emit("onStateChanged", self.state()) }
  }
}
