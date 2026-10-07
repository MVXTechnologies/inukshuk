package expo.modules.inukshukmesh

// Pure transport-layer logic for the team mesh (#589): wire framing, rate
// buckets, bans, admission, backoff and config clamping. No Android imports,
// so the host test (scripts/test-android.sh) compiles it with plain kotlinc.
// ios/MeshProtocol.swift mirrors it line for line; keep the two in step.
//
// Wire format (docs/design/team-mesh.md §Wire):
//   preamble  "INKM" 0x01 0x00 0x00 0x00          (8 bytes, each side, once)
//   frame     u32 big-endian length L, then L bytes (L == 0 is a keepalive)
// The payload is opaque here: the sync core seals and authenticates it.

object MeshWire {
  val MAGIC = byteArrayOf(0x49, 0x4E, 0x4B, 0x4D) // "INKM"
  const val VERSION: Byte = 1
  const val PREAMBLE_BYTES = 8
  const val HEADER_BYTES = 4
  /** No configuration may raise the frame cap above this. */
  const val MAX_FRAME_CEILING = 1024 * 1024
  /** The first allocation for a frame body; it then doubles as bytes really arrive. */
  const val MIN_BODY_ALLOC = 4096

  fun preamble(): ByteArray = byteArrayOf(0x49, 0x4E, 0x4B, 0x4D, VERSION, 0, 0, 0)

  /** Header + payload in one array. The caller has checked the size cap. */
  fun encode(payload: ByteArray): ByteArray {
    val out = ByteArray(HEADER_BYTES + payload.size)
    val n = payload.size
    out[0] = (n ushr 24).toByte()
    out[1] = (n ushr 16).toByte()
    out[2] = (n ushr 8).toByte()
    out[3] = n.toByte()
    System.arraycopy(payload, 0, out, HEADER_BYTES, n)
    return out
  }

  fun keepalive(): ByteArray = ByteArray(HEADER_BYTES)
}

enum class DecodeStatus { OK, BAD_MAGIC, INCOMPATIBLE, OVERSIZE }

/**
 * Incremental decoder for one connection's inbound byte stream.
 *
 * Never trusts the peer's length beyond [maxFrameBytes]: a header above the
 * cap is a violation before anything is allocated, and a body buffer grows
 * only as its bytes actually arrive (at most twice what was received, never
 * more than the declared length), so a peer that announces 1 MiB and sends
 * 10 bytes costs 4 KiB. After a violation the decoder is dead: every later
 * feed returns the same status and consumes nothing.
 */
class FrameDecoder(private val maxFrameBytes: Int) {
  private var preambleSeen = 0
  private val preamble = ByteArray(MeshWire.PREAMBLE_BYTES)
  private val header = ByteArray(MeshWire.HEADER_BYTES)
  private var headerSeen = 0
  private var bodyLength = -1
  private var body: ByteArray? = null
  private var bodyFilled = 0
  private var failed: DecodeStatus? = null

  /** Whether the peer's preamble has been read and accepted. */
  var preambleDone = false
    private set
  var keepalives = 0L
    private set
  /** Largest body buffer ever allocated (tests: proves no over-allocation). */
  var peakAllocation = 0
    private set
  /** Bytes currently held for a partial frame. */
  val buffered: Int get() = body?.size ?: 0

  init {
    require(maxFrameBytes in 1..MeshWire.MAX_FRAME_CEILING) { "maxFrameBytes out of range" }
  }

  /** Feeds `len` bytes; complete non-empty frames are appended to [out]. */
  fun feed(src: ByteArray, off: Int, len: Int, out: MutableList<ByteArray>): DecodeStatus {
    failed?.let { return it }
    require(off >= 0 && len >= 0 && off + len <= src.size) { "bad slice" }
    var i = off
    val end = off + len
    while (i < end) {
      if (!preambleDone) {
        val take = minOf(MeshWire.PREAMBLE_BYTES - preambleSeen, end - i)
        System.arraycopy(src, i, preamble, preambleSeen, take)
        preambleSeen += take
        i += take
        // Reject a wrong magic as soon as its bytes are in, not after 8.
        for (k in 0 until minOf(preambleSeen, 4)) {
          if (preamble[k] != MeshWire.MAGIC[k]) return fail(DecodeStatus.BAD_MAGIC)
        }
        if (preambleSeen == MeshWire.PREAMBLE_BYTES) {
          if (preamble[4] != MeshWire.VERSION) return fail(DecodeStatus.INCOMPATIBLE)
          preambleDone = true
        }
        continue
      }
      if (bodyLength < 0) {
        val take = minOf(MeshWire.HEADER_BYTES - headerSeen, end - i)
        System.arraycopy(src, i, header, headerSeen, take)
        headerSeen += take
        i += take
        if (headerSeen < MeshWire.HEADER_BYTES) continue
        headerSeen = 0
        // Unsigned: a length with the top bit set is simply too large.
        val length = ((header[0].toLong() and 0xFF) shl 24) or ((header[1].toLong() and 0xFF) shl 16) or
          ((header[2].toLong() and 0xFF) shl 8) or (header[3].toLong() and 0xFF)
        if (length > maxFrameBytes) return fail(DecodeStatus.OVERSIZE)
        if (length == 0L) {
          keepalives++
          continue
        }
        bodyLength = length.toInt()
        bodyFilled = 0
        continue
      }
      val take = minOf(bodyLength - bodyFilled, end - i)
      ensureCapacity(bodyFilled + take)
      System.arraycopy(src, i, body!!, bodyFilled, take)
      bodyFilled += take
      i += take
      if (bodyFilled == bodyLength) {
        val buf = body!!
        out.add(if (buf.size == bodyLength) buf else buf.copyOf(bodyLength))
        body = null
        bodyLength = -1
        bodyFilled = 0
      }
    }
    return DecodeStatus.OK
  }

  private fun ensureCapacity(needed: Int) {
    val current = body
    if (current != null && current.size >= needed) return
    var cap = maxOf(current?.size ?: 0, MeshWire.MIN_BODY_ALLOC)
    while (cap < needed) cap = if (cap > Int.MAX_VALUE / 2) needed else cap * 2
    cap = minOf(cap, bodyLength)
    val next = ByteArray(cap)
    if (current != null) System.arraycopy(current, 0, next, 0, bodyFilled)
    body = next
    if (cap > peakAllocation) peakAllocation = cap
  }

  private fun fail(status: DecodeStatus): DecodeStatus {
    failed = status
    body = null
    return status
  }
}

/**
 * A token bucket that may go into debt: we only learn how many frames a read
 * carried after reading it. While in debt the connection stops reading, so an
 * over-rate peer is throttled by TCP's own flow control instead of being
 * buffered by us.
 */
class DebtBucket(private val ratePerSec: Double, private val burst: Double) {
  private var tokens = burst
  private var last = Long.MIN_VALUE

  fun charge(n: Double, nowMs: Long) {
    refill(nowMs)
    tokens -= n
  }

  /** Milliseconds until the bucket is out of debt (0 = may read now). */
  fun waitMs(nowMs: Long): Long {
    refill(nowMs)
    if (tokens >= 0) return 0
    return Math.ceil(-tokens / ratePerSec * 1000.0).toLong().coerceAtLeast(1)
  }

  private fun refill(nowMs: Long) {
    if (last != Long.MIN_VALUE && nowMs > last) {
      tokens = minOf(burst, tokens + (nowMs - last) / 1000.0 * ratePerSec)
    }
    if (last == Long.MIN_VALUE || nowMs > last) last = nowMs
  }
}

/** Exponential reconnect delay with ±20 % jitter. `unit` is a random number in [0, 1). */
object Backoff {
  const val BASE_MS = 1000L
  const val MAX_MS = 60_000L
  /** A connection that lived this long resets the attempt counter. */
  const val STABLE_MS = 30_000L

  fun delayMs(attempt: Int, unit: Double): Long {
    val exp = minOf(attempt.coerceAtLeast(0), 16)
    val raw = minOf(MAX_MS.toDouble(), BASE_MS * Math.pow(2.0, exp.toDouble()))
    val jitter = 0.8 + 0.4 * unit.coerceIn(0.0, 1.0)
    return minOf(MAX_MS, (raw * jitter).toLong()).coerceAtLeast(1)
  }
}

/**
 * Temporary IP bans and the strikes that lead to them. Bounded: at most
 * [capacity] addresses are tracked, so a flood of spoofed sources cannot grow
 * it. When full, expired entries go first, then the one ending soonest.
 * Thread-safe: discovery asks from its own thread whether to skip an address.
 */
class BanList(
  private val capacity: Int = 256,
  private val strikesToBan: Int = 3,
  private val strikeWindowMs: Long = 10 * 60_000L,
  private val strikeBanMs: Long = 10 * 60_000L,
) {
  private val bans = HashMap<String, Long>()
  private val strikes = HashMap<String, ArrayDeque<Long>>()

  @Synchronized fun isBanned(ip: String, nowMs: Long): Boolean {
    val until = bans[ip] ?: return false
    if (until > nowMs) return true
    bans.remove(ip)
    return false
  }

  @Synchronized fun ban(ip: String, untilMs: Long, nowMs: Long) {
    val existing = bans[ip]
    if (existing != null && existing >= untilMs) return
    if (existing == null && bans.size >= capacity) evict(nowMs)
    bans[ip] = untilMs
    strikes.remove(ip)
  }

  /** Records a violation; returns true when it bans the address. */
  @Synchronized fun strike(ip: String, nowMs: Long): Boolean {
    if (isBanned(ip, nowMs)) return true
    if (!strikes.containsKey(ip) && strikes.size >= capacity) {
      strikes.entries.removeAll { (_, times) -> times.isEmpty() || nowMs - times.last() >= strikeWindowMs }
      if (strikes.size >= capacity) strikes.remove(strikes.keys.first())
    }
    val times = strikes.getOrPut(ip) { ArrayDeque() }
    while (times.isNotEmpty() && nowMs - times.first() >= strikeWindowMs) times.removeFirst()
    times.addLast(nowMs)
    if (times.size >= strikesToBan) {
      ban(ip, nowMs + strikeBanMs, nowMs)
      return true
    }
    return false
  }

  @Synchronized fun activeCount(nowMs: Long): Int = bans.values.count { it > nowMs }

  @Synchronized fun clear() {
    bans.clear()
    strikes.clear()
  }

  private fun evict(nowMs: Long) {
    bans.entries.removeAll { it.value <= nowMs }
    if (bans.size >= capacity) {
      val soonest = bans.minByOrNull { it.value }?.key
      if (soonest != null) bans.remove(soonest)
    }
  }
}

/**
 * Inbound-connection rate per source address: a sliding one-minute count,
 * bounded like [BanList].
 */
class AcceptRate(private val perMinute: Int, private val capacity: Int = 256) {
  private val seen = HashMap<String, ArrayDeque<Long>>()

  /** Records an accept; false when this address is over its rate. */
  fun admit(ip: String, nowMs: Long): Boolean {
    if (!seen.containsKey(ip) && seen.size >= capacity) {
      seen.entries.removeAll { (_, times) -> times.isEmpty() || nowMs - times.last() >= 60_000L }
      if (seen.size >= capacity) seen.remove(seen.keys.first())
    }
    val times = seen.getOrPut(ip) { ArrayDeque() }
    while (times.isNotEmpty() && nowMs - times.first() >= 60_000L) times.removeFirst()
    if (times.size >= perMinute) return false
    times.addLast(nowMs)
    return true
  }
}

/** Effective limits after clamping what JS asked for into the safe ranges. */
data class MeshConfig(
  val preferredPort: Int = DEFAULT_PORT,
  val maxFrameBytes: Int = 512 * 1024,
  val maxPeers: Int = 16,
  val maxInboundPerIp: Int = 2,
  val maxPendingInbound: Int = 8,
  val acceptsPerMinutePerIp: Int = 20,
  val bytesPerSec: Int = 8 * 1024 * 1024,
  val framesPerSec: Int = 400,
  val maxQueuedBytes: Int = 4 * 1024 * 1024,
  val maxInboxBytesPerPeer: Int = 2 * 1024 * 1024,
  val maxInboxBytes: Int = 16 * 1024 * 1024,
  val idleTimeoutMs: Long = 45_000,
  val keepaliveMs: Long = 15_000,
  val handshakeTimeoutMs: Long = 5_000,
  val connectTimeoutMs: Long = 10_000,
  val defaultBanMs: Long = 10 * 60_000L,
) {
  companion object {
    /** Well-known listening port, so a hotspot host is reachable at gateway:47321. */
    const val DEFAULT_PORT = 47321
    const val MAX_BAN_MS = 24 * 3600_000L

    /** Missing or non-numeric keys keep the default; numbers are clamped, never rejected. */
    fun from(raw: Map<String, Any?>?): MeshConfig {
      val d = MeshConfig()
      if (raw == null) return d
      fun num(key: String): Double? = (raw[key] as? Number)?.toDouble()?.takeIf { it.isFinite() }
      fun int(key: String, def: Int, lo: Int, hi: Int): Int =
        num(key)?.let { it.toLong().coerceIn(lo.toLong(), hi.toLong()).toInt() } ?: def
      fun long(key: String, def: Long, lo: Long, hi: Long): Long =
        num(key)?.toLong()?.coerceIn(lo, hi) ?: def
      val maxFrame = int("maxFrameBytes", d.maxFrameBytes, 1024, MeshWire.MAX_FRAME_CEILING)
      val keepalive = long("keepaliveMs", d.keepaliveMs, 1_000, 120_000)
      return MeshConfig(
        preferredPort = int("preferredPort", d.preferredPort, 0, 65535),
        maxFrameBytes = maxFrame,
        maxPeers = int("maxPeers", d.maxPeers, 1, 64),
        maxInboundPerIp = int("maxInboundPerIp", d.maxInboundPerIp, 1, 4),
        maxPendingInbound = int("maxPendingInbound", d.maxPendingInbound, 1, 32),
        acceptsPerMinutePerIp = int("acceptsPerMinutePerIp", d.acceptsPerMinutePerIp, 1, 120),
        bytesPerSec = int("bytesPerSec", d.bytesPerSec, 64 * 1024, 64 * 1024 * 1024),
        framesPerSec = int("framesPerSec", d.framesPerSec, 10, 5_000),
        // A queue must hold at least two maximal frames or one could never be sent.
        maxQueuedBytes = int("maxQueuedBytes", d.maxQueuedBytes, 2 * (maxFrame + MeshWire.HEADER_BYTES), 64 * 1024 * 1024),
        maxInboxBytesPerPeer = int("maxInboxBytesPerPeer", d.maxInboxBytesPerPeer, 2 * maxFrame, 64 * 1024 * 1024),
        maxInboxBytes = int("maxInboxBytes", d.maxInboxBytes, 4 * maxFrame, 256 * 1024 * 1024),
        // Idle must outlast at least two keepalive intervals.
        idleTimeoutMs = long("idleTimeoutMs", d.idleTimeoutMs, 3_000, 600_000).coerceAtLeast(keepalive * 2 + 1_000),
        keepaliveMs = keepalive,
        handshakeTimeoutMs = long("handshakeTimeoutMs", d.handshakeTimeoutMs, 1_000, 60_000),
        connectTimeoutMs = long("connectTimeoutMs", d.connectTimeoutMs, 1_000, 60_000),
        defaultBanMs = long("defaultBanMs", d.defaultBanMs, 1_000, MAX_BAN_MS),
      )
    }
  }
}

/** Discovery tags: base64url, 8–43 characters (≤ 32 bytes). Never a team name. */
object MeshTags {
  private val TAG = Regex("^[A-Za-z0-9_-]{8,43}$")
  const val SERVICE_TYPE = "_inukshuk-team._tcp"

  fun isValid(tag: String?): Boolean = tag != null && TAG.matches(tag)

  /** A random DNS-SD instance name: no device or user name ever goes on the air. */
  fun instanceName(random: java.util.Random): String {
    val alphabet = "abcdefghijklmnopqrstuvwxyz234567"
    val sb = StringBuilder("ink-")
    repeat(12) { sb.append(alphabet[random.nextInt(alphabet.length)]) }
    return sb.toString()
  }
}
