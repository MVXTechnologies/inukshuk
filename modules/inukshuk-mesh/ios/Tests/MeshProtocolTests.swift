import Foundation

// Host test for MeshProtocol.swift. Mirrors android/src/test/.../MeshProtocolTest.kt.

var checks = 0
func expect(_ value: @autoclosure () -> Bool, _ label: String, file: StaticString = #file, line: UInt = #line) {
  checks += 1
  if !value() { fatalError("FAILED: \(label)", file: file, line: line) }
}

/// SplitMix64: deterministic across runs and platforms.
struct SeededRandom: RandomNumberGenerator {
  var state: UInt64
  init(_ seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
  mutating func bytes(_ n: Int) -> Data { Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &self) }) }
}

func stream(_ frames: [Data]) -> Data {
  var out = MeshWire.preamble()
  for f in frames { out.append(f.isEmpty ? MeshWire.keepalive() : MeshWire.encode(f)) }
  return out
}

func header(_ len: UInt64) -> Data {
  Data([UInt8(len >> 24 & 0xFF), UInt8(len >> 16 & 0xFF), UInt8(len >> 8 & 0xFF), UInt8(len & 0xFF)])
}

func decodeAll(_ bytes: Data, cap: Int, chunk: (Int) -> Int) -> (DecodeStatus, [Data]) {
  let d = FrameDecoder(maxFrameBytes: cap)
  var out: [Data] = []
  var i = 0
  var status = DecodeStatus.ok
  while i < bytes.count {
    let n = max(1, min(chunk(i), bytes.count - i))
    status = d.feed(bytes.subdata(in: i..<(i + n)), into: &out)
    if status != .ok { break }
    i += n
  }
  return (status, out)
}

func wireTests() {
  let a = Data("hello".utf8)
  let b = Data((0..<70_000).map { UInt8($0 % 251) })
  let s = stream([a, Data(), b])
  for chunking: (Int) -> Int in [{ _ in s.count }, { _ in 1 }, { _ in 3 }, { _ in 4096 }] {
    let (status, frames) = decodeAll(s, cap: 512 * 1024, chunk: chunking)
    expect(status == .ok, "roundtrip status")
    expect(frames.count == 2, "keepalive is not delivered")
    expect(frames[0] == a && frames[1] == b, "roundtrip content")
  }
  let d = FrameDecoder(maxFrameBytes: 1024)
  var out: [Data] = []
  _ = d.feed(s.subdata(in: 0..<(8 + 4 + 5 + 4)), into: &out)
  expect(d.keepalives == 1 && out.count == 1, "keepalive counted")

  expect(FrameDecoder(maxFrameBytes: 1024).feed(Data("G".utf8), into: &out) == .badMagic, "bad magic early")
  expect(decodeAll(Data("GET / HTTP/1.1\r\n\r\n".utf8), cap: 1024, chunk: { _ in 64 }).0 == .badMagic, "http probe")
  var v2 = MeshWire.preamble()
  v2[4] = 2
  expect(FrameDecoder(maxFrameBytes: 1024).feed(v2, into: &out) == .incompatible, "other version")

  let cap = 2048
  expect(decodeAll(MeshWire.preamble() + header(UInt64(cap) + 1), cap: cap, chunk: { _ in 64 }).0 == .oversize, "cap + 1")
  expect(decodeAll(MeshWire.preamble() + header(0xFFFF_FFFF), cap: cap, chunk: { _ in 64 }).0 == .oversize, "u32 max")
  expect(decodeAll(MeshWire.preamble() + header(0x8000_0000), cap: cap, chunk: { _ in 64 }).0 == .oversize, "sign bit")
  let exact = decodeAll(stream([Data(repeating: 7, count: cap)]), cap: cap, chunk: { _ in 100 })
  expect(exact.0 == .ok && exact.1.count == 1 && exact.1[0].count == cap, "exact cap")

  let dead = FrameDecoder(maxFrameBytes: cap)
  _ = dead.feed(MeshWire.preamble() + header(UInt64(cap) + 1), into: &out)
  expect(dead.feed(stream([a]).subdata(in: 8..<17), into: &out) == .oversize, "stays dead")

  let trickle = FrameDecoder(maxFrameBytes: MeshWire.maxFrameCeiling)
  _ = trickle.feed(MeshWire.preamble() + header(UInt64(MeshWire.maxFrameCeiling)) + Data(count: 10), into: &out)
  expect(trickle.peakAllocation <= MeshWire.minBodyAlloc, "no allocation from an untrusted length")
  expect(trickle.buffered <= MeshWire.minBodyAlloc, "buffered follows arrival")

  expect(MeshWire.encode(a).count == 9 && MeshWire.encode(a)[3] == 5, "header")
  expect(MeshWire.keepalive() == Data(count: 4), "keepalive bytes")
  // Cross-platform vector: the same bytes the Kotlin test builds.
  expect(MeshWire.preamble() + MeshWire.encode(Data([1, 2, 3])) ==
    Data([0x49, 0x4E, 0x4B, 0x4D, 1, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]), "wire vector")
}

func fuzzValid(seed: UInt64, rounds: Int) {
  var rnd = SeededRandom(seed)
  for _ in 0..<rounds {
    let cap = 1024 + Int.random(in: 0..<(64 * 1024), using: &rnd)
    let frames: [Data] = (0..<(1 + Int.random(in: 0..<12, using: &rnd))).map { _ in
      let size: Int
      switch Int.random(in: 0..<4, using: &rnd) {
      case 0: size = 0
      case 1: size = cap
      default: size = Int.random(in: 0...cap, using: &rnd)
      }
      return rnd.bytes(size)
    }
    let bytes = stream(frames)
    let maxChunk = 1 + Int.random(in: 0..<9000, using: &rnd)
    let d = FrameDecoder(maxFrameBytes: cap)
    var out: [Data] = []
    var i = 0
    while i < bytes.count {
      let n = min(1 + Int.random(in: 0..<maxChunk, using: &rnd), bytes.count - i)
      expect(d.feed(bytes.subdata(in: i..<(i + n)), into: &out) == .ok, "fuzz valid status")
      i += n
    }
    let expected = frames.filter { !$0.isEmpty }
    expect(out == expected, "fuzz frames")
    expect(d.peakAllocation <= cap, "fuzz allocation within cap")
    expect(d.buffered == 0, "nothing left over")
  }
}

func fuzzGarbage(seed: UInt64, rounds: Int) {
  var rnd = SeededRandom(seed)
  for _ in 0..<rounds {
    let cap = 1024 + Int.random(in: 0..<(MeshWire.maxFrameCeiling - 1024), using: &rnd)
    var garbage = rnd.bytes(Int.random(in: 0..<20_000, using: &rnd))
    if garbage.count >= 4 && Bool.random(using: &rnd) {
      garbage.replaceSubrange(0..<4, with: header(UInt64(Int.random(in: 0...cap, using: &rnd))))
    }
    let bytes = Int.random(in: 0..<5, using: &rnd) == 0 ? garbage : MeshWire.preamble() + garbage
    let d = FrameDecoder(maxFrameBytes: cap)
    var out: [Data] = []
    var i = 0
    var fed = 0
    while i < bytes.count {
      let n = min(1 + Int.random(in: 0..<5000, using: &rnd), bytes.count - i)
      let status = d.feed(bytes.subdata(in: i..<(i + n)), into: &out)
      fed += n
      expect(d.peakAllocation <= max(MeshWire.minBodyAlloc, 2 * fed), "garbage allocation follows arrival")
      expect(d.peakAllocation <= cap, "garbage allocation within cap")
      if status != .ok { break }
      i += n
    }
    for f in out { expect(f.count >= 1 && f.count <= cap, "garbage frames within cap") }
  }
}

func bucketTests() {
  let b = DebtBucket(ratePerSec: 10, burst: 20)
  b.charge(20, nowMs: 0)
  expect(b.waitMs(nowMs: 0) == 0, "burst is free")
  b.charge(10, nowMs: 0)
  expect(b.waitMs(nowMs: 0) == 1000, "10 over at 10/s waits 1 s")
  expect(b.waitMs(nowMs: 500) == 500, "refills over time")
  expect(b.waitMs(nowMs: 1000) == 0, "out of debt")
  expect(b.waitMs(nowMs: 100_000) == 0, "capped at burst")
  b.charge(20, nowMs: 100_000)
  expect(b.waitMs(nowMs: 100_000) == 0, "burst after long idle, not more")
  b.charge(1, nowMs: 100_000)
  expect(b.waitMs(nowMs: 100_000) > 0, "burst is the ceiling")
}

func backoffTests() {
  expect(Backoff.delayMs(attempt: 0, unit: 0.5) == 1000, "first delay")
  expect(Backoff.delayMs(attempt: 1, unit: 0.5) == 2000, "doubles")
  expect(Backoff.delayMs(attempt: 3, unit: 0.0) == 6400, "jitter low")
  expect(Backoff.delayMs(attempt: 3, unit: 1.0) == 9600, "jitter high")
  expect(Backoff.delayMs(attempt: 30, unit: 0.99) <= Backoff.maxMs, "capped")
  expect(Backoff.delayMs(attempt: -5, unit: 0.5) == 1000, "negative attempt")
}

func banTests() {
  let bans = BanList(capacity: 4, strikesToBan: 3, strikeWindowMs: 1000, strikeBanMs: 5000)
  expect(!bans.strike("a", nowMs: 0) && !bans.strike("a", nowMs: 10), "two strikes are not a ban")
  expect(bans.strike("a", nowMs: 20) && bans.isBanned("a", nowMs: 21), "third strike bans")
  expect(!bans.isBanned("a", nowMs: 5021), "ban expires")
  expect(!bans.strike("b", nowMs: 0) && !bans.strike("b", nowMs: 1500) && !bans.strike("b", nowMs: 1600), "window")
  for i in 0..<100 { bans.ban("ip\(i)", untilMs: 10_000 + Int64(i), nowMs: 0) }
  expect(bans.activeCount(nowMs: 0) <= 4, "bounded")
  expect(bans.isBanned("ip99", nowMs: 0), "newest ban kept")
  bans.ban("ip99", untilMs: 5, nowMs: 0)
  expect(bans.isBanned("ip99", nowMs: 50), "a shorter ban never shortens a longer one")
  for i in 0..<1000 { bans.strike("s\(i)", nowMs: 0) }
  expect(bans.activeCount(nowMs: 0) <= 4, "strike flood stays bounded")

  let rate = AcceptRate(perMinute: 3, capacity: 4)
  expect(rate.admit("x", nowMs: 0) && rate.admit("x", nowMs: 1) && rate.admit("x", nowMs: 2), "under rate")
  expect(!rate.admit("x", nowMs: 3), "over rate")
  expect(rate.admit("x", nowMs: 60_001), "window slides")
  for i in 0..<1000 { _ = rate.admit("y\(i)", nowMs: 0) }
}

func configTests() {
  let d = MeshConfig.from(nil)
  expect(d == MeshConfig(), "defaults")
  expect(d.preferredPort == 47321, "well-known port")
  let c = MeshConfig.from([
    "maxFrameBytes": 1e12, "maxPeers": -3.0, "maxInboundPerIp": 99.0, "bytesPerSec": Double.nan,
    "keepaliveMs": 30_000.0, "idleTimeoutMs": 1.0, "maxQueuedBytes": 1.0, "preferredPort": "x",
  ])
  expect(c.maxFrameBytes == MeshWire.maxFrameCeiling, "frame ceiling")
  expect(c.maxPeers == 1, "peers floor")
  expect(c.maxInboundPerIp == 4, "per-ip ceiling")
  expect(c.bytesPerSec == d.bytesPerSec, "NaN keeps the default")
  expect(c.idleTimeoutMs >= 2 * c.keepaliveMs, "idle outlasts two keepalives")
  expect(c.maxQueuedBytes >= 2 * (c.maxFrameBytes + 4), "queue holds two frames")
  expect(c.preferredPort == 47321, "non-number ignored")
  expect(MeshConfig.from(["maxPeers": true]).maxPeers == d.maxPeers, "a boolean is not a number")
}

func tagTests() {
  expect(MeshTags.isValid("abcdEFGH_-12"), "base64url tag")
  expect(!MeshTags.isValid("short") && !MeshTags.isValid(nil), "too short")
  expect(!MeshTags.isValid(String(repeating: "a", count: 44)), "too long")
  expect(!MeshTags.isValid("My Team Name"), "no names")
  expect(!MeshTags.isValid("abcdefgh=,"), "no TXT separators")
  expect(!MeshTags.isValid("abcdéfghij"), "ASCII only")
  var rnd = SeededRandom(1)
  let name = MeshTags.instanceName(using: &rnd)
  expect(name.hasPrefix("ink-") && name.count == 16, "instance name")
  expect(name.dropFirst(4).allSatisfy { "abcdefghijklmnopqrstuvwxyz234567".contains($0) }, "instance alphabet")
  expect(MeshTags.serviceType == "_inukshuk-team._tcp", "service type")
}

func runProtocolTests(rounds: Int) {
  wireTests()
  fuzzValid(seed: 589, rounds: rounds)
  fuzzGarbage(seed: 590, rounds: rounds * 2)
  bucketTests()
  backoffTests()
  banTests()
  configTests()
  tagTests()
  print("MeshProtocolTests: passed \(checks) checks")
}
