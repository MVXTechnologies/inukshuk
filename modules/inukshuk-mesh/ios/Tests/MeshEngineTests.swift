import Darwin
import Foundation

// Real sockets on 127.0.0.1 (macOS host): two engines, and BSD sockets
// playing a hostile peer. Mirrors android/src/test/.../MeshEngineTest.kt.

final class Recorder: MeshEngineDelegate {
  private let lock = NSLock()
  private var _connected: [[String: Any?]] = []
  private var _disconnected: [(String?, String?, String, Int64?)] = []
  private var _writable: [String] = []
  private var _errors: [String] = []

  var connected: [[String: Any?]] { lock.lock(); defer { lock.unlock() }; return _connected }
  var disconnected: [(String?, String?, String, Int64?)] { lock.lock(); defer { lock.unlock() }; return _disconnected }
  var writable: [String] { lock.lock(); defer { lock.unlock() }; return _writable }
  var reasons: [String] { disconnected.map { $0.2 } }
  var errors: [String] { lock.lock(); defer { lock.unlock() }; return _errors }

  func meshConnected(_ peer: [String: Any?]) { lock.lock(); _connected.append(peer); lock.unlock() }
  func meshDisconnected(peerId: String?, dialId: String?, reason: String, retryInMs: Int64?) {
    lock.lock(); _disconnected.append((peerId, dialId, reason, retryInMs)); lock.unlock()
  }
  func meshFramesAvailable() {}
  func meshWritable(peerId: String) { lock.lock(); _writable.append(peerId); lock.unlock() }
  func meshPeerFound(_ service: [String: Any?]) {}
  func meshPeerLost(serviceId: String) {}
  func meshError(code: String, message: String) { lock.lock(); _errors.append("\(code) \(message)"); lock.unlock() }
  func meshStateChanged() {}
}

func waitFor(_ label: String, timeout: TimeInterval = 5, _ cond: () -> Bool) {
  let end = Date().addingTimeInterval(timeout)
  while Date() < end {
    if cond() { expect(true, label); return }
    usleep(10_000)
  }
  expect(false, "timed out: \(label)")
}

func engine(_ rec: Recorder, _ config: MeshConfig = { var c = MeshConfig(); c.preferredPort = 0; return c }()) -> MeshEngine {
  let e = MeshEngine(config: config)
  e.delegate = rec
  _ = try! e.start()
  return e
}

func cfg(_ edit: (inout MeshConfig) -> Void) -> MeshConfig {
  var c = MeshConfig()
  c.preferredPort = 0
  edit(&c)
  return c
}

/// A blocking BSD socket to 127.0.0.1:port.
final class RawSocket {
  let fd: Int32
  init(port: Int) {
    fd = socket(AF_INET, SOCK_STREAM, 0)
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let r = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    precondition(r == 0, "raw connect failed")
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
  }
  func write(_ data: Data) { _ = data.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, data.count, 0) } }
  /// Reads exactly n bytes, or fewer on EOF/timeout.
  func read(_ n: Int, timeout: TimeInterval) -> Data {
    setTimeout(timeout)
    var out = Data()
    var buf = [UInt8](repeating: 0, count: n)
    while out.count < n {
      let r = recv(fd, &buf, n - out.count, 0)
      if r <= 0 { break }
      out.append(contentsOf: buf[0..<r])
    }
    return out
  }
  /// True when the server closed the socket (EOF or reset) within the timeout.
  func closedByPeer(timeout: TimeInterval = 3) -> Bool {
    setTimeout(timeout)
    var buf = [UInt8](repeating: 0, count: 4096)
    while true {
      let r = recv(fd, &buf, buf.count, 0)
      if r == 0 { return true }
      if r < 0 { return errno != EAGAIN && errno != EWOULDBLOCK }
    }
  }
  private func setTimeout(_ t: TimeInterval) {
    var tv = timeval(tv_sec: Int(t), tv_usec: Int32((t - Double(Int(t))) * 1_000_000))
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
  }
  deinit { Darwin.close(fd) }
}

func exchange() {
  let ra = Recorder(), rb = Recorder()
  let a = engine(ra), b = engine(rb)
  defer { a.stop(); b.stop() }
  let dial = try! b.connect(host: "127.0.0.1", port: a.port, reconnect: false)
  waitFor("both sides connected") { ra.connected.count == 1 && rb.connected.count == 1 }
  expect(rb.connected[0]["dialId"] as? String == dial && rb.connected[0]["direction"] as? String == "out", "outbound peer")
  expect(ra.connected[0]["direction"] as? String == "in", "inbound peer")
  let toA = rb.connected[0]["peerId"] as! String
  let toB = ra.connected[0]["peerId"] as! String
  let payload = Data((0..<300_000).map { UInt8(truncatingIfNeeded: $0 &* 7) })
  _ = try! b.send(toA, Data("hi".utf8))
  _ = try! b.send(toA, payload)
  var got: [InFrame] = []
  waitFor("frames arrive in order") { got += a.takeFrames(max: 10); return got.count == 2 }
  expect(got[0].peerId == toB && got[0].data == Data("hi".utf8), "first frame")
  expect(got[1].data == payload, "large frame intact")
  _ = try! a.send(toB, Data("back".utf8))
  waitFor("reply") { b.takeFrames(max: 10).contains { $0.data == Data("back".utf8) } }

  func code(_ f: () throws -> Void) -> String {
    do { try f(); return "" } catch let e as MeshError { return e.code } catch { return "?" }
  }
  expect(code { _ = try b.send(toA, Data(count: b.config.maxFrameBytes + 1)) } == "E_MESH_FRAME_TOO_LARGE", "oversize send")
  expect(code { _ = try b.send("nope", Data([1])) } == "E_MESH_NO_PEER", "unknown peer")
  expect(code { _ = try b.send(toA, Data()) } == "E_MESH_ARGUMENT", "empty frame")

  let peers = a.stats()["peers"] as! [[String: Any?]]
  expect(peers.count == 1 && (peers[0]["bytesIn"] as! Double) > 300_000, "stats count bytes")

  b.disconnect(toA)
  waitFor("disconnect seen on both sides") { ra.reasons.contains("remote-closed") && rb.reasons.contains("local") }
}

func hostilePeers() {
  let ra = Recorder()
  let a = engine(ra, cfg { $0.maxFrameBytes = 4096; $0.handshakeTimeoutMs = 1_000; $0.maxInboundPerIp = 4 })
  defer { a.stop() }
  do {
    let s = RawSocket(port: a.port)
    s.write(Data("GET / HTTP/1.1\r\n\r\n".utf8))
    expect(s.closedByPeer(), "garbage preamble closed")
  }
  do {
    let s = RawSocket(port: a.port)
    s.write(MeshWire.preamble() + Data([0, 0, 0x10, 0x01]))
    expect(s.closedByPeer(), "oversize frame closed")
  }
  do {
    let s = RawSocket(port: a.port)
    expect(s.closedByPeer(timeout: 4), "silent socket closed")
  }
  waitFor("ban recorded") { (a.stats()["activeBans"] as! Int) >= 1 }
  do {
    let s = RawSocket(port: a.port)
    s.write(MeshWire.preamble())
    expect(s.closedByPeer(), "banned address refused at accept")
  }
  expect((a.stats()["violations"] as! Double) >= 2, "violations counted")
}

func perIpLimit() {
  let ra = Recorder()
  let a = engine(ra, cfg { $0.maxInboundPerIp = 1 })
  defer { a.stop() }
  let first = RawSocket(port: a.port)
  first.write(MeshWire.preamble())
  waitFor("first accepted") { ra.connected.count == 1 }
  let second = RawSocket(port: a.port)
  expect(second.closedByPeer(), "second from the same address refused")
  _ = first
}

func idleAndKeepalive() {
  let ra = Recorder()
  let a = engine(ra, cfg { $0.keepaliveMs = 1_000; $0.idleTimeoutMs = 3_000 })
  defer { a.stop() }
  let s = RawSocket(port: a.port)
  s.write(MeshWire.preamble())
  waitFor("connected") { ra.connected.count == 1 }
  let got = s.read(12, timeout: 2.5)
  expect(got.count == 12 && got.subdata(in: 8..<12) == Data(count: 4), "keepalive after the preamble")
  waitFor("idle peer closed", timeout: 6) { ra.reasons.contains("idle") }
}

func backpressure() {
  let ra = Recorder(), rb = Recorder()
  let frame = 64 * 1024
  let small = cfg {
    $0.maxFrameBytes = frame; $0.maxQueuedBytes = 4 * (frame + 4)
    $0.maxInboxBytesPerPeer = 2 * frame; $0.maxInboxBytes = 4 * frame
  }
  let a = engine(ra, small), b = engine(rb, small)
  defer { a.stop(); b.stop() }
  _ = try! b.connect(host: "127.0.0.1", port: a.port, reconnect: false)
  waitFor("connected") { ra.connected.count == 1 && rb.connected.count == 1 }
  let toA = rb.connected[0]["peerId"] as! String
  var stalled = false
  var sent = 0
  let end = Date().addingTimeInterval(20)
  while !stalled && Date() < end {
    do {
      _ = try b.send(toA, Data(count: frame))
      sent += 1
    } catch let e as MeshError {
      expect(e.code == "E_MESH_BACKPRESSURE", "backpressure code")
      let before = rb.writable.count
      let wait = Date().addingTimeInterval(1.5)
      while rb.writable.count == before && Date() < wait { usleep(10_000) }
      stalled = rb.writable.count == before
    } catch { expect(false, "unexpected error") }
  }
  expect(stalled, "sender stalls while the receiver does not read")
  let aPeers = a.stats()["peers"] as! [[String: Any?]]
  expect(aPeers[0]["throttled"] as? Bool == true, "receiver paused reading")
  expect((a.stats()["inboxBytes"] as! Double) <= Double(5 * frame), "receiver inbox bounded")
  let writableBefore = rb.writable.count
  var received = 0
  waitFor("all frames delivered after draining", timeout: 20) {
    received += a.takeFrames(max: 64).count
    return received >= sent
  }
  expect(received == sent, "no frame lost or duplicated")
  waitFor("writable announced after the stall") { rb.writable.count > writableBefore }
}

func throttle() {
  let ra = Recorder()
  let a = engine(ra, cfg { $0.framesPerSec = 10 })
  defer { a.stop() }
  let s = RawSocket(port: a.port)
  var burst = MeshWire.preamble()
  for _ in 0..<100 { burst.append(MeshWire.encode(Data([1]))) }
  s.write(burst)
  var got = 0
  waitFor("burst delivered") { got += a.takeFrames(max: 1000).count; return got == 100 }
  s.write(MeshWire.encode(Data([2])))
  usleep(1_500_000)
  expect(a.takeFrames(max: 10).isEmpty, "over-rate peer is not read")
  let peers = a.stats()["peers"] as! [[String: Any?]]
  expect(peers[0]["throttled"] as? Bool == true, "throttled in stats")
}

func reconnect() {
  let ra = Recorder(), rb = Recorder()
  let a = engine(ra)
  let port = a.port
  let b = engine(rb)
  defer { b.stop() }
  let dial = try! b.connect(host: "127.0.0.1", port: port, reconnect: true)
  waitFor("connected") { rb.connected.count == 1 }
  a.stop()
  waitFor("drop reported with a retry") { rb.disconnected.contains { $0.1 == dial && $0.3 != nil } }
  let a2 = MeshEngine(config: cfg { $0.preferredPort = port })
  let r2 = Recorder()
  a2.delegate = r2
  _ = try! a2.start()
  defer { a2.stop() }
  expect(a2.port == port, "listener back on the same port")
  waitFor("redialled with backoff", timeout: 15) { rb.connected.count == 2 && rb.connected[1]["dialId"] as? String == dial }
  b.disconnect(dial)
  waitFor("cancelled") { rb.reasons.contains("local") }
  _ = r2

  let once = try! b.connect(host: "127.0.0.1", port: 1, reconnect: false)
  waitFor("single attempt fails", timeout: 15) { rb.disconnected.contains { $0.1 == once && $0.3 == nil } }
}

func banByCore() {
  let ra = Recorder(), rb = Recorder()
  let a = engine(ra), b = engine(rb)
  defer { a.stop(); b.stop() }
  let dial = try! b.connect(host: "127.0.0.1", port: a.port, reconnect: true)
  waitFor("connected") { ra.connected.count == 1 }
  a.ban(ra.connected[0]["peerId"] as! String, durationMs: 60_000)
  waitFor("banned close") { ra.reasons.contains("banned") }
  usleep(2_500_000)
  expect(ra.connected.count == 1, "a banned address cannot come back")
  b.disconnect(dial)
  a.stop()
  var code = ""
  do { _ = try a.connect(host: "127.0.0.1", port: 1, reconnect: false) } catch let e as MeshError { code = e.code } catch {}
  expect(code == "E_MESH_NOT_RUNNING", "commands need a running mesh")
}

func resumeReplacesListener() {
  let ra = Recorder(), rb = Recorder()
  let a = engine(ra), b = engine(rb)
  defer { a.stop(); b.stop() }
  let port = a.port
  a.resume(afterSuspension: true)
  waitFor("listener back after a suspension") { a.stats()["listening"] as? Bool == true && a.stats()["port"] as? Int == port }
  _ = try! b.connect(host: "127.0.0.1", port: port, reconnect: false)
  waitFor("reachable on the same port") { ra.connected.count == 1 }
}

func interfaces() {
  let info = MeshInterfaces.read()
  let list = info["interfaces"] as! [[String: Any]]
  for i in list {
    let parts = (i["address"] as! String).split(separator: ".")
    expect(parts.count == 4 && parts.allSatisfy { UInt8($0) != nil }, "dotted IPv4")
    expect((0...32).contains(i["prefixLength"] as! Int), "prefix length")
  }
  expect((info["gateways"] as! [String]).isEmpty, "no gateway API on Apple platforms")
}

func runEngineTests() {
  interfaces()
  exchange()
  hostilePeers()
  perIpLimit()
  idleAndKeepalive()
  backpressure()
  throttle()
  reconnect()
  banByCore()
  resumeReplacesListener()
  print("MeshEngineTests: passed (\(checks) checks in total)")
}
