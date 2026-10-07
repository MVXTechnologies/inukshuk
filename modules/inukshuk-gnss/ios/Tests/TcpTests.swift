import Foundation
import Network

// Host tests for GnssTcpPipe.swift against a local NWListener echo server
// (same cases as android/src/test/.../TcpPipeTest.kt).

/// Echo server on loopback; "BYE" makes it close the connection.
final class EchoServer {
  let listener: NWListener
  private let queue = DispatchQueue(label: "echo")
  private var connections: [NWConnection] = []
  var silent = false

  init() throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: params)
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
    listener.newConnectionHandler = { [self] c in
      self.connections.append(c)
      c.start(queue: self.queue)
      if !self.silent { self.pump(c) }
    }
    listener.start(queue: queue)
    _ = ready.wait(timeout: .now() + 5)
  }

  var port: UInt16 { listener.port?.rawValue ?? 0 }

  private func pump(_ c: NWConnection) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] data, _, done, error in
      if let data, !data.isEmpty {
        if String(decoding: data, as: UTF8.self).contains("BYE") {
          c.cancel()
          return
        }
        c.send(content: data, completion: .contentProcessed { _ in })
      }
      if done || error != nil { c.cancel() } else { self.pump(c) }
    }
  }

  func stop() { listener.cancel() }
}

final class TcpRecorder {
  private let lock = NSLock()
  private(set) var data = Data()
  private(set) var events = 0
  private(set) var maxEvent = 0
  var closeError: String?? = .none
  let closed = DispatchSemaphore(value: 0)

  func onData(_ d: Data) {
    lock.lock()
    data.append(d)
    events += 1
    maxEvent = max(maxEvent, d.count)
    lock.unlock()
  }

  func onClose(_ e: String?) {
    closeError = .some(e)
    closed.signal()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return data.count
  }
}

let tcpQueue = DispatchQueue(label: "tcp-test")

func makePipe(_ port: UInt16, _ rec: TcpRecorder, tls: Bool = false, readTimeoutMs: Int = 60_000, maxBuffered: Int = 256 * 1024, maxEventBytes: Int = 64 * 1024) -> GnssTcpPipe {
  GnssTcpPipe(
    host: "127.0.0.1", port: port, tls: tls, queue: tcpQueue, connectTimeoutMs: 3_000,
    readTimeoutMs: readTimeoutMs, maxBuffered: maxBuffered, flushIntervalMs: 20, maxEventBytes: maxEventBytes,
    onData: rec.onData, onClose: rec.onClose)
}

func openSync(_ p: GnssTcpPipe) -> String?? {
  let s = DispatchSemaphore(value: 0)
  var result: String?? = .none
  p.open { result = .some($0); s.signal() }
  _ = s.wait(timeout: .now() + 10)
  return result
}

func writeSync(_ p: GnssTcpPipe, _ d: Data) -> String?? {
  let s = DispatchSemaphore(value: 0)
  var result: String?? = .none
  p.write(d) { result = .some($0); s.signal() }
  _ = s.wait(timeout: .now() + 10)
  return result
}

func waitFor(_ ms: Int, _ cond: () -> Bool) -> Bool {
  let end = Date().addingTimeInterval(Double(ms) / 1000)
  while Date() < end {
    if cond() { return true }
    Thread.sleep(forTimeInterval: 0.01)
  }
  return cond()
}

func tcpTests() {
  guard let server = try? EchoServer() else {
    check("echo server starts", false)
    return
  }
  // Echo, then a remote close reported once as a normal end.
  do {
    let rec = TcpRecorder()
    let p = makePipe(server.port, rec)
    p.setListening(true)
    check("tcp connects", openSync(p) == .some(nil))
    check("tcp writes", writeSync(p, Data("GET / HTTP/1.0\r\n\r\n".utf8)) == .some(nil))
    check("tcp echo arrives", waitFor(3_000) { rec.data == Data("GET / HTTP/1.0\r\n\r\n".utf8) })
    _ = writeSync(p, Data("BYE".utf8))
    check("tcp remote close reported", rec.closed.wait(timeout: .now() + 3) == .success && rec.closeError == .some(nil))
    check("tcp write after close fails", writeSync(p, Data("x".utf8)) != .some(nil))
  }
  // Large echo arrives in bounded events, in order; close() is silent.
  do {
    let rec = TcpRecorder()
    let p = makePipe(server.port, rec, maxEventBytes: 1024)
    p.setListening(true)
    check("chunk connects", openSync(p) == .some(nil))
    let payload = Data((0..<20_000).map { UInt8(97 + $0 % 26) })
    check("chunk writes", writeSync(p, payload) == .some(nil))
    check("chunk all bytes", waitFor(5_000) { rec.count == payload.count })
    check("chunk in order", rec.data == payload)
    check("chunk events bounded", rec.maxEvent <= 1024 && rec.events >= 20)
    p.close()
    check("chunk no close event after close()", rec.closed.wait(timeout: .now() + 0.3) == .timedOut)
  }
  // Backpressure: nothing delivered while not listening, nothing lost after.
  do {
    let rec = TcpRecorder()
    let p = makePipe(server.port, rec, maxBuffered: 4096)
    check("bp connects", openSync(p) == .some(nil))
    let payload = Data((0..<64_000).map { UInt8($0 % 251) })
    _ = writeSync(p, payload)
    Thread.sleep(forTimeInterval: 0.3)
    check("bp nothing while not listening", rec.events == 0)
    p.setListening(true)
    check("bp everything once listening", waitFor(5_000) { rec.count == payload.count })
    check("bp nothing lost or reordered", rec.data == payload)
    p.close()
  }
  // Refused connect.
  do {
    let gone = try? EchoServer()
    let port = gone?.port ?? 1
    gone?.stop()
    Thread.sleep(forTimeInterval: 0.2)
    let r = openSync(makePipe(port, TcpRecorder()))
    if case .some(.some(let msg)) = r { check("refused connect reports an error", msg.hasPrefix("connect")) } else {
      check("refused connect reports an error", false)
    }
  }
  // TLS to a plain server fails.
  do {
    let r = openSync(makePipe(server.port, TcpRecorder(), tls: true))
    if case .some(.some) = r { check("tls to plain fails", true) } else { check("tls to plain fails", false) }
  }
  // Read timeout against a silent server.
  if let silent = try? EchoServer() {
    silent.silent = true
    let rec = TcpRecorder()
    let p = makePipe(silent.port, rec, readTimeoutMs: 300)
    p.setListening(true)
    check("silent connects", openSync(p) == .some(nil))
    check("silent times out", rec.closed.wait(timeout: .now() + 3) == .success && rec.closeError == .some("the caster stopped sending"))
    silent.stop()
  }
  server.stop()
}
