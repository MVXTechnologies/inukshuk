import Foundation

// Host tests for GnssCore.swift (no simulator): ios/Tests/run.sh.
// Same cases as android/src/test/.../LinkCoreTest.kt.

var failures = 0
var checks = 0

func check(_ name: String, _ condition: Bool) {
  checks += 1
  if !condition {
    failures += 1
    FileHandle.standardError.write("FAIL: \(name)\n".data(using: .utf8)!)
  }
}

func bytes(_ v: UInt8...) -> Data { Data(v) }

func backoffTests() {
  var b = GnssBackoff(initialMs: 1_000, maxMs: 30_000, stableMs: 10_000)
  let delays = (1...8).map { _ in b.nextDelayMs() }
  check("backoff doubles then caps", delays == [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  check("backoff counts attempts", b.attempt == 8)
  b.onConnected(0)
  b.onDisconnected(2_000)
  check("short link keeps backoff", b.nextDelayMs() == 30_000)
  b.onConnected(10_000)
  b.onDisconnected(25_000)
  check("stable link resets backoff", b.attempt == 0 && b.nextDelayMs() == 1_000)
  b.onDisconnected(99_000)
  check("disconnect without connect keeps attempt", b.attempt == 1)
  b.reset()
  check("reset", b.attempt == 0)
  var big = GnssBackoff()
  for _ in 0..<200 { _ = big.nextDelayMs() }
  check("no overflow after many attempts", big.nextDelayMs() == 30_000)
}

func ringTests() {
  var r = GnssByteRing(capacity: 8)
  r.append(bytes(1, 2, 3))
  check("ring size", r.size == 3)
  check("ring take partial", r.take(2) == bytes(1, 2))
  r.append(bytes(4, 5, 6, 7, 8, 9, 10))
  check("ring wraps without loss", r.size == 8 && r.takeDropped() == 0)
  check("ring order after wrap", r.take(100) == bytes(3, 4, 5, 6, 7, 8, 9, 10))
  check("ring empty", r.size == 0 && r.take(4).isEmpty)

  r.append(bytes(1, 2, 3, 4, 5, 6))
  r.append(bytes(7, 8, 9, 10))
  check("overflow drop count", r.takeDropped() == 2)
  check("overflow keeps newest", r.take(8) == bytes(3, 4, 5, 6, 7, 8, 9, 10))
  check("dropped resets after read", r.takeDropped() == 0)

  r.append(bytes(1, 2))
  r.append(Data((0..<20).map { UInt8($0) }))
  check("huge append drop count", r.takeDropped() == 14)
  check("huge append keeps tail", r.take(8) == Data((12..<20).map { UInt8($0) }))

  r.append(bytes(1, 2, 3))
  r.clear()
  check("clear counts as dropped", r.size == 0 && r.takeDropped() == 3)
}

func pacerTests() {
  var p = GnssFlushPacer(minIntervalMs: 100)
  check("first flush immediate", p.delayMs(1_000) == 0)
  p.flushed(1_000)
  check("second flush waits", p.delayMs(1_030) == 70)
  check("after interval immediate", p.delayMs(1_100) == 0)
}

func splitTests() {
  let parts = gnssSplitForWrite(Data((0..<10).map { UInt8($0) }), max: 4)
  check("split sizes", parts.map { $0.count } == [4, 4, 2])
  check("split content", parts[2] == bytes(8, 9))
  check("split empty", gnssSplitForWrite(Data(), max: 20).isEmpty)
  check("split exact", gnssSplitForWrite(Data(count: 20), max: 20).count == 1)
  // A slice whose indices do not start at 0.
  let slice = Data((0..<10).map { UInt8($0) })[3..<10]
  check("split slice", gnssSplitForWrite(slice, max: 4) == [bytes(3, 4, 5, 6), bytes(7, 8, 9)])
}

func throttleTests() {
  var t = GnssScanThrottle(minIntervalMs: 1_000)
  check("first sighting reported", t.shouldReport("a", 0))
  check("refresh throttled", !t.shouldReport("a", 500))
  check("other device reported", t.shouldReport("b", 500))
  check("refresh after interval", t.shouldReport("a", 1_000))
  t.clear()
  check("cleared reports again", t.shouldReport("a", 1_001))
}

func cursorTests() {
  var c = GnssFrameCursor(frames: [bytes(1), bytes(2)], loop: true)
  check("cursor loops", [c.next(), c.next(), c.next()] == [bytes(1), bytes(2), bytes(1)])
  var once = GnssFrameCursor(frames: [bytes(1)], loop: false)
  _ = once.next()
  check("cursor ends without loop", once.next() == nil)
  var empty = GnssFrameCursor(frames: [], loop: true)
  check("empty cursor", empty.next() == nil)
}

let nus = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
let nusRx = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
let nusTx = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

func profileTests() {
  check("normalize full", gnssNormalizeUuid(" 6E400001-B5A3-F393-E0A9-E50E24DCCA9E ") == nus)
  check("normalize 16-bit", gnssNormalizeUuid("FFE0") == "0000ffe0-0000-1000-8000-00805f9b34fb")
  check("normalize 32-bit", gnssNormalizeUuid("0000ffe1") == "0000ffe1-0000-1000-8000-00805f9b34fb")
  check("reject junk", gnssNormalizeUuid("nus") == nil && gnssNormalizeUuid("") == nil && gnssNormalizeUuid("12345") == nil)
  check("reject bad groups", gnssNormalizeUuid("6e40000-1b5a3-f393-e0a9-e50e24dcca9e") == nil)

  let nusP = GnssGattProfile(name: "nus", service: nus, notify: nusTx, write: nusRx)!
  let hm10 = GnssGattProfile(name: "hm10", service: "ffe0", notify: "ffe1", write: "ffe1")!
  let readOnly = GnssGattProfile(name: "ro", service: nus, notify: nusTx, write: nil)!
  check("profile parse", nusP.service == nus && hm10.write == "0000ffe1-0000-1000-8000-00805f9b34fb")
  check("profile rejects bad uuid", GnssGattProfile(name: "x", service: "zz", notify: nusTx, write: nil) == nil)
  check("profile rejects bad write uuid", GnssGattProfile(name: "x", service: nus, notify: nusTx, write: "nope") == nil)
  check("profile rejects empty name", GnssGattProfile(name: " ", service: nus, notify: nusTx, write: nil) == nil)
  check("profile without write", readOnly.write == nil)

  let full = [nus: [nusTx: GnssCharCaps(canNotify: true, canWrite: false), nusRx: GnssCharCaps(canNotify: false, canWrite: true)]]
  check("nus selected writable", gnssSelectProfile([hm10, nusP], full) == GnssProfileChoice(profile: nusP, writable: true))
  let hmFound = [hm10.service: [hm10.notify: GnssCharCaps(canNotify: true, canWrite: true)]]
  check("same-char profile", gnssSelectProfile([nusP, hm10], hmFound) == GnssProfileChoice(profile: hm10, writable: true))
  let noWrite = [nus: [nusTx: GnssCharCaps(canNotify: true, canWrite: false)]]
  check("falls back to read-only", gnssSelectProfile([nusP], noWrite) == GnssProfileChoice(profile: nusP, writable: false))
  check("read-only profile never writable", gnssSelectProfile([readOnly], full) == GnssProfileChoice(profile: readOnly, writable: false))
  let both = noWrite.merging(hmFound) { a, _ in a }
  check("full match preferred", gnssSelectProfile([nusP, hm10], both) == GnssProfileChoice(profile: hm10, writable: true))
  let cannotNotify = [nus: [nusTx: GnssCharCaps(canNotify: false, canWrite: true)]]
  check("no notify, no profile", gnssSelectProfile([nusP], cannotNotify) == nil)
  check("unknown service", gnssSelectProfile([nusP], [:]) == nil)

  // Persisted across a state restoration.
  let encoded = try? JSONEncoder().encode([nusP, readOnly])
  let decoded = encoded.flatMap { try? JSONDecoder().decode([GnssGattProfile].self, from: $0) }
  check("profiles round-trip through Codable", decoded == [nusP, readOnly])
}

backoffTests()
ringTests()
pacerTests()
splitTests()
throttleTests()
cursorTests()
profileTests()
tcpTests()
if failures > 0 {
  print("\(failures) of \(checks) checks failed")
  exit(1)
}
print("inukshuk-gnss core (Swift): \(checks) checks passed")
