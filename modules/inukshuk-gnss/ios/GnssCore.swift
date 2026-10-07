import Foundation

// Pure transport bookkeeping (Foundation only): compiled on the host by
// ios/Tests/run.sh. Mirrors android/.../core/LinkCore.kt + GattProfiles.kt;
// the two are tested against the same cases.
//
// The module moves bytes and nothing else. NMEA/UBX/RTCM framing and parsing
// live in TypeScript (src/core/gnss).

/// Reconnect delays: 1 s, 2 s, 4 s … capped at 30 s. Resets only after a link
/// stayed up for `stableMs`, so a receiver that drops every connection at
/// once is not hammered every second.
struct GnssBackoff {
  let initialMs: Int64
  let maxMs: Int64
  let stableMs: Int64
  private(set) var attempt = 0
  private var connectedAt: Int64?

  init(initialMs: Int64 = 1_000, maxMs: Int64 = 30_000, stableMs: Int64 = 10_000) {
    self.initialMs = initialMs
    self.maxMs = maxMs
    self.stableMs = stableMs
  }

  mutating func nextDelayMs() -> Int64 {
    let shift = Int64(min(attempt, 20))
    attempt += 1
    let delay = initialMs << shift
    return (delay <= 0 || delay > maxMs) ? maxMs : delay
  }

  mutating func onConnected(_ nowMs: Int64) {
    connectedAt = nowMs
  }

  mutating func onDisconnected(_ nowMs: Int64) {
    if let since = connectedAt, nowMs - since >= stableMs { attempt = 0 }
    connectedAt = nil
  }

  mutating func reset() {
    attempt = 0
    connectedAt = nil
  }
}

/// Bounded FIFO of received bytes; when full the OLDEST bytes go and are
/// counted, so JS knows to resynchronise its framer.
struct GnssByteRing {
  let capacity: Int
  private var buf: [UInt8]
  private var head = 0
  private(set) var size = 0
  private var dropped: Int64 = 0

  init(capacity: Int) {
    precondition(capacity > 0, "capacity must be positive")
    self.capacity = capacity
    buf = [UInt8](repeating: 0, count: capacity)
  }

  mutating func append(_ data: Data) {
    append([UInt8](data))
  }

  mutating func append(_ bytes: [UInt8]) {
    var src = bytes[...]
    if src.isEmpty { return }
    if src.count >= capacity {
      dropped += Int64(size + (src.count - capacity))
      head = 0
      size = 0
      src = src.suffix(capacity)
    }
    let overflow = size + src.count - capacity
    if overflow > 0 {
      head = (head + overflow) % capacity
      size -= overflow
      dropped += Int64(overflow)
    }
    var tail = (head + size) % capacity
    for b in src {
      buf[tail] = b
      tail = (tail + 1) % capacity
    }
    size += src.count
  }

  /// Removes and returns up to `max` of the oldest bytes.
  mutating func take(_ max: Int) -> Data {
    let n = Swift.min(Swift.max(max, 0), size)
    var out = Data(capacity: n)
    var copied = 0
    while copied < n {
      let chunk = Swift.min(n - copied, capacity - head)
      out.append(contentsOf: buf[head..<(head + chunk)])
      head = (head + chunk) % capacity
      copied += chunk
    }
    size -= n
    if size == 0 { head = 0 }
    return out
  }

  /// Bytes discarded since the last call (then resets to 0).
  mutating func takeDropped() -> Int64 {
    let d = dropped
    dropped = 0
    return d
  }

  mutating func clear() {
    dropped += Int64(size)
    head = 0
    size = 0
  }
}

/// At most one `onBytes` event per `minIntervalMs`.
struct GnssFlushPacer {
  let minIntervalMs: Int64
  private var lastFlushAt: Int64?

  init(minIntervalMs: Int64 = 100) {
    self.minIntervalMs = minIntervalMs
  }

  func delayMs(_ nowMs: Int64) -> Int64 {
    guard let last = lastFlushAt else { return 0 }
    return Swift.max(0, last + minIntervalMs - nowMs)
  }

  mutating func flushed(_ nowMs: Int64) {
    lastFlushAt = nowMs
  }
}

/// Splits a write into pieces of at most `max` bytes.
func gnssSplitForWrite(_ data: Data, max: Int) -> [Data] {
  precondition(max > 0, "chunk size must be positive")
  var out: [Data] = []
  var i = data.startIndex
  while i < data.endIndex {
    let end = data.index(i, offsetBy: max, limitedBy: data.endIndex) ?? data.endIndex
    out.append(Data(data[i..<end]))
    i = end
  }
  return out
}

/// Reports a scanned device when first seen, then at most once per interval.
struct GnssScanThrottle {
  let minIntervalMs: Int64
  private var lastAt: [String: Int64] = [:]

  init(minIntervalMs: Int64 = 1_000) {
    self.minIntervalMs = minIntervalMs
  }

  mutating func shouldReport(_ id: String, _ nowMs: Int64) -> Bool {
    if let last = lastAt[id], nowMs - last < minIntervalMs { return false }
    lastAt[id] = nowMs
    return true
  }

  mutating func clear() {
    lastAt.removeAll()
  }
}

/// Replays pre-split frames for the fake receiver.
struct GnssFrameCursor {
  private let frames: [Data]
  private let loop: Bool
  private var index = 0

  init(frames: [Data], loop: Bool) {
    self.frames = frames
    self.loop = loop
  }

  mutating func next() -> Data? {
    if frames.isEmpty { return nil }
    if index >= frames.count {
      if !loop { return nil }
      index = 0
    }
    defer { index += 1 }
    return frames[index]
  }
}

// MARK: - GATT profiles

/// A serial-over-BLE profile: service, the characteristic the receiver
/// NOTIFIES on, and the one we WRITE to. Data from JS
/// (src/lib/gnss/bleProfiles.ts), never hard-coded natively. UUIDs normalised.
struct GnssGattProfile: Codable, Equatable {
  let name: String
  let service: String
  let notify: String
  let write: String?

  /// nil when a UUID is malformed or the name is empty.
  init?(name: String, service: String, notify: String, write: String?) {
    guard !name.trimmingCharacters(in: .whitespaces).isEmpty,
      let s = gnssNormalizeUuid(service),
      let n = gnssNormalizeUuid(notify)
    else { return nil }
    var w: String?
    if let raw = write, !raw.trimmingCharacters(in: .whitespaces).isEmpty {
      guard let parsed = gnssNormalizeUuid(raw) else { return nil }
      w = parsed
    }
    self.name = name
    self.service = s
    self.notify = n
    self.write = w
  }
}

private let baseSuffix = "-0000-1000-8000-00805f9b34fb"

/// Lower-case 128-bit form; 16/32-bit short forms expand on the Bluetooth
/// base UUID (CoreBluetooth prints 16-bit UUIDs as "FFE0").
func gnssNormalizeUuid(_ raw: String) -> String? {
  let s = raw.trimmingCharacters(in: .whitespaces).lowercased()
  let hex = CharacterSet(charactersIn: "0123456789abcdef")
  func isHex(_ part: Substring) -> Bool {
    !part.isEmpty && part.unicodeScalars.allSatisfy { hex.contains($0) }
  }
  let parts = s.split(separator: "-", omittingEmptySubsequences: false)
  if parts.count == 5, zip(parts, [8, 4, 4, 4, 12]).allSatisfy({ $0.count == $1 && isHex($0) }) {
    return s
  }
  if parts.count == 1 && isHex(parts[0]) {
    if s.count == 4 { return "0000\(s)\(baseSuffix)" }
    if s.count == 8 { return "\(s)\(baseSuffix)" }
  }
  return nil
}

struct GnssCharCaps: Equatable {
  let canNotify: Bool
  let canWrite: Bool
}

struct GnssProfileChoice: Equatable {
  let profile: GnssGattProfile
  let writable: Bool
}

/// First profile (caller's order) that streams AND writes; failing that,
/// the first that streams, flagged read-only.
func gnssSelectProfile(
  _ profiles: [GnssGattProfile],
  _ found: [String: [String: GnssCharCaps]]
) -> GnssProfileChoice? {
  func streams(_ p: GnssGattProfile) -> Bool { found[p.service]?[p.notify]?.canNotify == true }
  func writes(_ p: GnssGattProfile) -> Bool {
    guard let w = p.write else { return false }
    return found[p.service]?[w]?.canWrite == true
  }
  if let p = profiles.first(where: { streams($0) && writes($0) }) {
    return GnssProfileChoice(profile: p, writable: true)
  }
  if let p = profiles.first(where: streams) {
    return GnssProfileChoice(profile: p, writable: false)
  }
  return nil
}
