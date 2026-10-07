import Foundation
import Network

/// A raw TCP (optionally TLS) byte pipe for NTRIP casters, on
/// Network.framework. Mirrors android/.../core/TcpPipe.kt; host-tested by
/// Tests/run.sh against a local NWListener echo server.
///
/// - Connect timeout `connectTimeoutMs` (NWConnection would otherwise sit in
///   `.waiting` forever without a network); read timeout `readTimeoutMs`.
/// - Backpressure: received bytes wait in a buffer of `maxBuffered` bytes and
///   leave as at most one `onData` per `flushIntervalMs`. The next receive is
///   only issued while the buffer has room, so TCP flow control pushes back
///   on the caster instead of bytes being dropped.
/// - TLS uses the system trust store and host-name validation (default
///   `NWProtocolTLS.Options`).
/// - `onClose` fires exactly once for a pipe that opened, never after
///   `close()`. All state lives on `queue`.
final class GnssTcpPipe {
  static let maxPendingWrite = 64 * 1024

  private let connection: NWConnection
  private let queue: DispatchQueue
  private let connectTimeoutMs: Int
  private let readTimeoutMs: Int
  private let flushIntervalMs: Int
  private let maxEventBytes: Int
  private let onData: (Data) -> Void
  private let onClose: (String?) -> Void

  private var ring: GnssByteRing
  private var listening = false
  private var opened = false
  private var closed = false
  private var receiving = false
  private var ended = false
  private var endReason: String?
  private var openDone: ((String?) -> Void)?
  private var pendingWrite = 0
  private var lastDataAt = DispatchTime.now()
  private var timer: DispatchSourceTimer?

  init(
    host: String, port: UInt16, tls: Bool, queue: DispatchQueue,
    connectTimeoutMs: Int = 15_000, readTimeoutMs: Int = 60_000,
    maxBuffered: Int = 256 * 1024, flushIntervalMs: Int = 100, maxEventBytes: Int = 64 * 1024,
    onData: @escaping (Data) -> Void, onClose: @escaping (String?) -> Void
  ) {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.connectionTimeout = max(1, connectTimeoutMs / 1000)
    let params = tls ? NWParameters(tls: NWProtocolTLS.Options(), tcp: tcp) : NWParameters(tls: nil, tcp: tcp)
    connection = NWConnection(
      host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? .any, using: params)
    self.queue = queue
    self.connectTimeoutMs = connectTimeoutMs
    self.readTimeoutMs = readTimeoutMs
    self.flushIntervalMs = flushIntervalMs
    self.maxEventBytes = maxEventBytes
    self.onData = onData
    self.onClose = onClose
    ring = GnssByteRing(capacity: maxBuffered)
  }

  /// `done` runs once on `queue`: nil when connected, else the error.
  func open(_ done: @escaping (String?) -> Void) {
    queue.async {
      self.openDone = done
      self.connection.stateUpdateHandler = { [self] state in self.stateChanged(state) }
      self.connection.start(queue: self.queue)
      self.queue.asyncAfter(deadline: .now() + .milliseconds(self.connectTimeoutMs)) {
        if !self.opened { self.failOpen("connect timed out") }
      }
    }
  }

  func setListening(_ on: Bool) {
    queue.async {
      self.listening = on
      if on { self.flush() }
    }
  }

  func write(_ data: Data, _ done: @escaping (String?) -> Void) {
    queue.async {
      guard self.opened, !self.closed else { return done("closed") }
      guard self.pendingWrite + data.count <= GnssTcpPipe.maxPendingWrite else { return done("write buffer full") }
      self.pendingWrite += data.count
      self.connection.send(content: data, completion: .contentProcessed { error in
        self.pendingWrite -= data.count
        done(error.map { "write failed: \($0)" })
      })
    }
  }

  /// Closes without reporting `onClose`. Idempotent.
  func close() {
    queue.async { self.shutdown() }
  }

  private func stateChanged(_ state: NWConnection.State) {
    switch state {
    case .ready:
      guard !opened, !closed else { return }
      opened = true
      lastDataAt = .now()
      startTimer()
      receive()
      openDone?(nil)
      openDone = nil
    case .failed(let error):
      if opened { end("connection failed: \(error)") } else { failOpen("connect failed: \(error)") }
    case .waiting(let error):
      // No route / refused: NWConnection would retry forever; an NTRIP
      // client should hear about it now.
      if !opened { failOpen("connect failed: \(error)") }
    case .cancelled:
      if opened { end(nil) }
    default:
      break
    }
  }

  private func failOpen(_ message: String) {
    guard !opened, let done = openDone else { return }
    openDone = nil
    shutdown()
    done(message)
  }

  private func receive() {
    guard opened, !closed, !ended, !receiving else { return }
    let room = ring.capacity - ring.size
    guard room > 0 else { return }  // resumed by flush()
    receiving = true
    connection.receive(minimumIncompleteLength: 1, maximumLength: min(room, 16 * 1024)) {
      [self] data, _, isComplete, error in
      self.receiving = false
      if self.closed { return }
      if let data, !data.isEmpty {
        self.ring.append(data)
        self.lastDataAt = .now()
      }
      if let error {
        self.end("read failed: \(error)")
      } else if isComplete {
        self.end(nil)
      } else {
        self.receive()
      }
    }
  }

  private func startTimer() {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + .milliseconds(flushIntervalMs), repeating: .milliseconds(flushIntervalMs))
    t.setEventHandler { [self] in
      let silentMs = (DispatchTime.now().uptimeNanoseconds - self.lastDataAt.uptimeNanoseconds) / 1_000_000
      // Only while reading: a full buffer (nobody listening) is not silence.
      if !self.ended, self.receiving, silentMs > UInt64(self.readTimeoutMs) { self.end("the caster stopped sending") }
      self.flush()
    }
    timer = t
    t.resume()
  }

  private func end(_ reason: String?) {
    guard !ended else { return }
    ended = true
    endReason = reason
    flush()
  }

  private func flush() {
    guard !closed else { return }
    if listening {
      while ring.size > 0 {
        onData(ring.take(maxEventBytes))
        if closed { return }
      }
      receive()
    }
    // An ended stream finishes once delivered, or at once with no listener.
    if ended, ring.size == 0 || !listening {
      let reason = endReason
      shutdown()
      onClose(reason)
    }
  }

  private func shutdown() {
    guard !closed else { return }
    closed = true
    timer?.cancel()
    timer = nil
    connection.stateUpdateHandler = nil
    connection.cancel()
  }
}
