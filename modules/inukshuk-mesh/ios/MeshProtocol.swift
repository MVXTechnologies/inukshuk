import Foundation

// Pure transport-layer logic for the team mesh (#589): wire framing, rate
// buckets, bans, admission, backoff and config clamping. Foundation only,
// so the host test (ios/Tests/run.sh) compiles it with plain swiftc.
// android/.../MeshProtocol.kt mirrors it line for line; keep the two in step.
//
// Wire format (docs/design/team-mesh.md §Wire):
//   preamble  "INKM" 0x01 0x00 0x00 0x00          (8 bytes, each side, once)
//   frame     u32 big-endian length L, then L bytes (L == 0 is a keepalive)

enum MeshWire {
  static let magic: [UInt8] = [0x49, 0x4E, 0x4B, 0x4D] // "INKM"
  static let version: UInt8 = 1
  static let preambleBytes = 8
  static let headerBytes = 4
  /// No configuration may raise the frame cap above this.
  static let maxFrameCeiling = 1024 * 1024
  /// The first allocation for a frame body; it then doubles as bytes really arrive.
  static let minBodyAlloc = 4096

  static func preamble() -> Data { Data([0x49, 0x4E, 0x4B, 0x4D, version, 0, 0, 0]) }

  /// Header + payload. The caller has checked the size cap.
  static func encode(_ payload: Data) -> Data {
    let n = UInt32(payload.count)
    var out = Data(capacity: headerBytes + payload.count)
    out.append(contentsOf: [UInt8(n >> 24 & 0xFF), UInt8(n >> 16 & 0xFF), UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF)])
    out.append(payload)
    return out
  }

  static func keepalive() -> Data { Data(count: headerBytes) }
}

enum DecodeStatus { case ok, badMagic, incompatible, oversize }

/// Incremental decoder for one connection's inbound byte stream.
///
/// Never trusts the peer's length beyond `maxFrameBytes`: a header above the
/// cap is a violation before anything is allocated, and a body buffer grows
/// only as its bytes actually arrive (at most twice what was received, never
/// more than the declared length). After a violation the decoder is dead.
final class FrameDecoder {
  private let maxFrameBytes: Int
  private var preamble = [UInt8](repeating: 0, count: MeshWire.preambleBytes)
  private var preambleSeen = 0
  private var header = [UInt8](repeating: 0, count: MeshWire.headerBytes)
  private var headerSeen = 0
  private var bodyLength = -1
  private var body: [UInt8]? = nil
  private var bodyFilled = 0
  private var failed: DecodeStatus? = nil

  private(set) var preambleDone = false
  private(set) var keepalives = 0
  /// Largest body buffer ever allocated (tests: proves no over-allocation).
  private(set) var peakAllocation = 0
  var buffered: Int { body?.count ?? 0 }

  init(maxFrameBytes: Int) {
    precondition(maxFrameBytes >= 1 && maxFrameBytes <= MeshWire.maxFrameCeiling, "maxFrameBytes out of range")
    self.maxFrameBytes = maxFrameBytes
  }

  /// Feeds bytes; complete non-empty frames are appended to `out`.
  func feed(_ src: UnsafeRawBufferPointer, into out: inout [Data]) -> DecodeStatus {
    if let failed { return failed }
    let bytes = src.bindMemory(to: UInt8.self)
    var i = 0
    let end = bytes.count
    while i < end {
      if !preambleDone {
        let take = min(MeshWire.preambleBytes - preambleSeen, end - i)
        for k in 0..<take { preamble[preambleSeen + k] = bytes[i + k] }
        preambleSeen += take
        i += take
        for k in 0..<min(preambleSeen, 4) where preamble[k] != MeshWire.magic[k] {
          return fail(.badMagic)
        }
        if preambleSeen == MeshWire.preambleBytes {
          if preamble[4] != MeshWire.version { return fail(.incompatible) }
          preambleDone = true
        }
        continue
      }
      if bodyLength < 0 {
        let take = min(MeshWire.headerBytes - headerSeen, end - i)
        for k in 0..<take { header[headerSeen + k] = bytes[i + k] }
        headerSeen += take
        i += take
        if headerSeen < MeshWire.headerBytes { continue }
        headerSeen = 0
        let length = UInt64(header[0]) << 24 | UInt64(header[1]) << 16 | UInt64(header[2]) << 8 | UInt64(header[3])
        if length > UInt64(maxFrameBytes) { return fail(.oversize) }
        if length == 0 {
          keepalives += 1
          continue
        }
        bodyLength = Int(length)
        bodyFilled = 0
        continue
      }
      let take = min(bodyLength - bodyFilled, end - i)
      ensureCapacity(bodyFilled + take)
      let at = bodyFilled
      body!.withUnsafeMutableBufferPointer { dst in
        UnsafeMutableRawPointer(dst.baseAddress! + at).copyMemory(from: bytes.baseAddress! + i, byteCount: take)
      }
      bodyFilled += take
      i += take
      if bodyFilled == bodyLength {
        let buf = body!
        out.append(buf.count == bodyLength ? Data(buf) : Data(buf[0..<bodyLength]))
        body = nil
        bodyLength = -1
        bodyFilled = 0
      }
    }
    return .ok
  }

  func feed(_ data: Data, into out: inout [Data]) -> DecodeStatus {
    data.withUnsafeBytes { feed($0, into: &out) }
  }

  private func ensureCapacity(_ needed: Int) {
    let current = body?.count ?? 0
    if body != nil && current >= needed { return }
    var cap = max(current, MeshWire.minBodyAlloc)
    while cap < needed { cap = cap > Int.max / 2 ? needed : cap * 2 }
    cap = min(cap, bodyLength)
    var next = [UInt8](repeating: 0, count: cap)
    if let body, bodyFilled > 0 { next.replaceSubrange(0..<bodyFilled, with: body[0..<bodyFilled]) }
    body = next
    if cap > peakAllocation { peakAllocation = cap }
  }

  private func fail(_ status: DecodeStatus) -> DecodeStatus {
    failed = status
    body = nil
    return status
  }
}

/// A token bucket that may go into debt: while in debt the connection stops
/// reading, so an over-rate peer is throttled by TCP's own flow control.
final class DebtBucket {
  private let ratePerSec: Double
  private let burst: Double
  private var tokens: Double
  private var last: Int64? = nil

  init(ratePerSec: Double, burst: Double) {
    self.ratePerSec = ratePerSec
    self.burst = burst
    tokens = burst
  }

  func charge(_ n: Double, nowMs: Int64) {
    refill(nowMs)
    tokens -= n
  }

  /// Milliseconds until the bucket is out of debt (0 = may read now).
  func waitMs(nowMs: Int64) -> Int64 {
    refill(nowMs)
    if tokens >= 0 { return 0 }
    return max(1, Int64((-tokens / ratePerSec * 1000.0).rounded(.up)))
  }

  private func refill(_ nowMs: Int64) {
    if let last, nowMs > last {
      tokens = min(burst, tokens + Double(nowMs - last) / 1000.0 * ratePerSec)
    }
    if last == nil || nowMs > last! { last = nowMs }
  }
}

/// Exponential reconnect delay with ±20 % jitter. `unit` is a random number in [0, 1).
enum Backoff {
  static let baseMs: Int64 = 1000
  static let maxMs: Int64 = 60_000
  /// A connection that lived this long resets the attempt counter.
  static let stableMs: Int64 = 30_000

  static func delayMs(attempt: Int, unit: Double) -> Int64 {
    let exp = min(max(attempt, 0), 16)
    let raw = min(Double(maxMs), Double(baseMs) * pow(2.0, Double(exp)))
    let jitter = 0.8 + 0.4 * min(max(unit, 0), 1)
    return max(1, min(maxMs, Int64(raw * jitter)))
  }
}

/// Temporary IP bans and the strikes that lead to them. Bounded: at most
/// `capacity` addresses are tracked, so a flood of sources cannot grow it.
final class BanList {
  private let capacity: Int
  private let strikesToBan: Int
  private let strikeWindowMs: Int64
  private let strikeBanMs: Int64
  private var bans: [String: Int64] = [:]
  private var strikes: [String: [Int64]] = [:]

  init(capacity: Int = 256, strikesToBan: Int = 3, strikeWindowMs: Int64 = 600_000, strikeBanMs: Int64 = 600_000) {
    self.capacity = capacity
    self.strikesToBan = strikesToBan
    self.strikeWindowMs = strikeWindowMs
    self.strikeBanMs = strikeBanMs
  }

  func isBanned(_ ip: String, nowMs: Int64) -> Bool {
    guard let until = bans[ip] else { return false }
    if until > nowMs { return true }
    bans[ip] = nil
    return false
  }

  func ban(_ ip: String, untilMs: Int64, nowMs: Int64) {
    if let existing = bans[ip], existing >= untilMs { return }
    if bans[ip] == nil && bans.count >= capacity { evict(nowMs) }
    bans[ip] = untilMs
    strikes[ip] = nil
  }

  /// Records a violation; returns true when it bans the address.
  @discardableResult
  func strike(_ ip: String, nowMs: Int64) -> Bool {
    if isBanned(ip, nowMs: nowMs) { return true }
    if strikes[ip] == nil && strikes.count >= capacity {
      strikes = strikes.filter { _, times in
        guard let last = times.last else { return false }
        return nowMs - last < strikeWindowMs
      }
      if strikes.count >= capacity, let first = strikes.keys.first { strikes[first] = nil }
    }
    var times = (strikes[ip] ?? []).filter { nowMs - $0 < strikeWindowMs }
    times.append(nowMs)
    if times.count >= strikesToBan {
      ban(ip, untilMs: nowMs + strikeBanMs, nowMs: nowMs)
      return true
    }
    strikes[ip] = times
    return false
  }

  func activeCount(nowMs: Int64) -> Int { bans.values.filter { $0 > nowMs }.count }

  func clear() {
    bans.removeAll()
    strikes.removeAll()
  }

  private func evict(_ nowMs: Int64) {
    bans = bans.filter { $0.value > nowMs }
    if bans.count >= capacity, let soonest = bans.min(by: { $0.value < $1.value })?.key { bans[soonest] = nil }
  }
}

/// Inbound-connection rate per source address: a sliding one-minute count, bounded.
final class AcceptRate {
  private let perMinute: Int
  private let capacity: Int
  private var seen: [String: [Int64]] = [:]

  init(perMinute: Int, capacity: Int = 256) {
    self.perMinute = perMinute
    self.capacity = capacity
  }

  /// Records an accept; false when this address is over its rate.
  func admit(_ ip: String, nowMs: Int64) -> Bool {
    if seen[ip] == nil && seen.count >= capacity {
      seen = seen.filter { _, times in times.last.map { nowMs - $0 < 60_000 } ?? false }
      if seen.count >= capacity, let first = seen.keys.first { seen[first] = nil }
    }
    var times = (seen[ip] ?? []).filter { nowMs - $0 < 60_000 }
    if times.count >= perMinute {
      seen[ip] = times
      return false
    }
    times.append(nowMs)
    seen[ip] = times
    return true
  }
}

/// Effective limits after clamping what JS asked for into the safe ranges.
struct MeshConfig: Equatable {
  /// Well-known listening port, so a hotspot host is reachable at gateway:47321.
  static let defaultPort = 47321
  static let maxBanMs: Int64 = 24 * 3_600_000

  var preferredPort = MeshConfig.defaultPort
  var maxFrameBytes = 512 * 1024
  var maxPeers = 16
  var maxInboundPerIp = 2
  var maxPendingInbound = 8
  var acceptsPerMinutePerIp = 20
  var bytesPerSec = 8 * 1024 * 1024
  var framesPerSec = 400
  var maxQueuedBytes = 4 * 1024 * 1024
  var maxInboxBytesPerPeer = 2 * 1024 * 1024
  var maxInboxBytes = 16 * 1024 * 1024
  var idleTimeoutMs: Int64 = 45_000
  var keepaliveMs: Int64 = 15_000
  var handshakeTimeoutMs: Int64 = 5_000
  var connectTimeoutMs: Int64 = 10_000
  var defaultBanMs: Int64 = 600_000

  /// Missing or non-numeric keys keep the default; numbers are clamped, never rejected.
  static func from(_ raw: [String: Any]?) -> MeshConfig {
    let d = MeshConfig()
    guard let raw else { return d }
    func num(_ key: String) -> Double? {
      guard let n = raw[key] as? NSNumber, !(raw[key] is Bool) else { return nil }
      let v = n.doubleValue
      return v.isFinite ? v : nil
    }
    func int(_ key: String, _ def: Int, _ lo: Int, _ hi: Int) -> Int {
      guard let v = num(key) else { return def }
      return Int(min(max(v.rounded(.towardZero), Double(lo)), Double(hi)))
    }
    func long(_ key: String, _ def: Int64, _ lo: Int64, _ hi: Int64) -> Int64 {
      guard let v = num(key) else { return def }
      return Int64(min(max(v.rounded(.towardZero), Double(lo)), Double(hi)))
    }
    var c = MeshConfig()
    let maxFrame = int("maxFrameBytes", d.maxFrameBytes, 1024, MeshWire.maxFrameCeiling)
    let keepalive = long("keepaliveMs", d.keepaliveMs, 1_000, 120_000)
    c.preferredPort = int("preferredPort", d.preferredPort, 0, 65535)
    c.maxFrameBytes = maxFrame
    c.maxPeers = int("maxPeers", d.maxPeers, 1, 64)
    c.maxInboundPerIp = int("maxInboundPerIp", d.maxInboundPerIp, 1, 4)
    c.maxPendingInbound = int("maxPendingInbound", d.maxPendingInbound, 1, 32)
    c.acceptsPerMinutePerIp = int("acceptsPerMinutePerIp", d.acceptsPerMinutePerIp, 1, 120)
    c.bytesPerSec = int("bytesPerSec", d.bytesPerSec, 64 * 1024, 64 * 1024 * 1024)
    c.framesPerSec = int("framesPerSec", d.framesPerSec, 10, 5_000)
    c.maxQueuedBytes = int("maxQueuedBytes", d.maxQueuedBytes, 2 * (maxFrame + MeshWire.headerBytes), 64 * 1024 * 1024)
    c.maxInboxBytesPerPeer = int("maxInboxBytesPerPeer", d.maxInboxBytesPerPeer, 2 * maxFrame, 64 * 1024 * 1024)
    c.maxInboxBytes = int("maxInboxBytes", d.maxInboxBytes, 4 * maxFrame, 256 * 1024 * 1024)
    c.idleTimeoutMs = max(long("idleTimeoutMs", d.idleTimeoutMs, 3_000, 600_000), keepalive * 2 + 1_000)
    c.keepaliveMs = keepalive
    c.handshakeTimeoutMs = long("handshakeTimeoutMs", d.handshakeTimeoutMs, 1_000, 60_000)
    c.connectTimeoutMs = long("connectTimeoutMs", d.connectTimeoutMs, 1_000, 60_000)
    c.defaultBanMs = long("defaultBanMs", d.defaultBanMs, 1_000, maxBanMs)
    return c
  }
}

/// Discovery tags: base64url, 8–43 characters (≤ 32 bytes). Never a team name.
enum MeshTags {
  static let serviceType = "_inukshuk-team._tcp"

  static func isValid(_ tag: String?) -> Bool {
    guard let tag, (8...43).contains(tag.utf8.count) else { return false }
    return tag.utf8.allSatisfy { c in
      (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x2D || c == 0x5F
    }
  }

  /// A random DNS-SD instance name: no device or user name ever goes on the air.
  static func instanceName<G: RandomNumberGenerator>(using rng: inout G) -> String {
    let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
    var s = "ink-"
    for _ in 0..<12 { s.append(alphabet[Int.random(in: 0..<alphabet.count, using: &rng)]) }
    return s
  }
}
