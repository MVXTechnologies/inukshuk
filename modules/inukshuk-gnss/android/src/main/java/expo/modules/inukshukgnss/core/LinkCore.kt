package expo.modules.inukshukgnss.core

// Pure transport bookkeeping shared by every Android transport. No android.*
// imports here: android/tests/run.sh compiles this file on a plain JVM.
//
// The module moves bytes and nothing else. NMEA/UBX/RTCM framing and parsing
// live in TypeScript (src/core/gnss); nothing in this file looks inside a byte.

/**
 * Reconnect delays: 1 s, 2 s, 4 s … capped at 30 s.
 *
 * The schedule only resets after a link has stayed up for [stableMs]. A
 * receiver that accepts the connection and drops it straight away (a flat
 * battery, a stuck GATT server) would otherwise be retried every second
 * forever.
 */
class Backoff(
  private val initialMs: Long = 1_000,
  private val maxMs: Long = 30_000,
  private val stableMs: Long = 10_000,
) {
  /** Retries since the last stable link. */
  var attempt: Int = 0
    private set
  private var connectedAt: Long? = null

  fun nextDelayMs(): Long {
    // Shift instead of pow: exact, and saturates well before overflow.
    val shift = attempt.coerceAtMost(20)
    attempt += 1
    val delay = initialMs shl shift
    return if (delay <= 0 || delay > maxMs) maxMs else delay
  }

  fun onConnected(nowMs: Long) {
    connectedAt = nowMs
  }

  fun onDisconnected(nowMs: Long) {
    val since = connectedAt
    connectedAt = null
    if (since != null && nowMs - since >= stableMs) attempt = 0
  }

  fun reset() {
    attempt = 0
    connectedAt = null
  }
}

/**
 * Bounded FIFO of received bytes. When full, the OLDEST bytes go and are
 * counted in [dropped], so the JS side knows to resynchronise its framer
 * (a sentence may have lost its head).
 *
 * Holds what arrived between two event flushes, and everything that arrived
 * while no JS listener was attached (app reload, a React host being rebuilt).
 */
class ByteRing(val capacity: Int) {
  init {
    require(capacity > 0) { "capacity must be positive" }
  }

  private val buf = ByteArray(capacity)
  private var head = 0
  var size: Int = 0
    private set
  private var dropped: Long = 0

  fun append(src: ByteArray, off: Int = 0, len: Int = src.size - off) {
    require(off >= 0 && len >= 0 && off + len <= src.size) { "range outside source" }
    if (len == 0) return
    var from = off
    var count = len
    if (count >= capacity) {
      // Only the newest `capacity` bytes can survive.
      dropped += size.toLong() + (count - capacity)
      head = 0
      size = 0
      from += count - capacity
      count = capacity
    }
    val overflow = size + count - capacity
    if (overflow > 0) {
      head = (head + overflow) % capacity
      size -= overflow
      dropped += overflow.toLong()
    }
    var tail = (head + size) % capacity
    var left = count
    while (left > 0) {
      val n = minOf(left, capacity - tail)
      System.arraycopy(src, from, buf, tail, n)
      from += n
      left -= n
      tail = (tail + n) % capacity
    }
    size += count
  }

  /** Removes and returns up to [max] of the oldest bytes. */
  fun take(max: Int): ByteArray {
    val n = minOf(max.coerceAtLeast(0), size)
    val out = ByteArray(n)
    var copied = 0
    while (copied < n) {
      val chunk = minOf(n - copied, capacity - head)
      System.arraycopy(buf, head, out, copied, chunk)
      head = (head + chunk) % capacity
      copied += chunk
    }
    size -= n
    if (size == 0) head = 0
    return out
  }

  /** Bytes discarded since the last call (then resets to 0). */
  fun takeDropped(): Long {
    val d = dropped
    dropped = 0
    return d
  }

  fun clear() {
    dropped += size.toLong()
    head = 0
    size = 0
  }
}

/**
 * Event pacing: at most one `onBytes` event per [minIntervalMs], so a 10 Hz
 * receiver costs ≤ 10 bridge crossings a second however its bytes arrive
 * (BLE notifications are ~20–244 bytes each; RFCOMM reads are arbitrary).
 */
class FlushPacer(private val minIntervalMs: Long = 100) {
  private var lastFlushAt: Long? = null

  /** Delay before the next flush may run, 0 when it may run now. */
  fun delayMs(nowMs: Long): Long {
    val last = lastFlushAt ?: return 0
    val wait = last + minIntervalMs - nowMs
    return if (wait > 0) wait else 0
  }

  fun flushed(nowMs: Long) {
    lastFlushAt = nowMs
  }
}

/** Splits a write into pieces of at most [max] bytes (BLE: ATT MTU − 3). */
fun splitForWrite(data: ByteArray, max: Int): List<ByteArray> {
  require(max > 0) { "chunk size must be positive" }
  if (data.isEmpty()) return emptyList()
  val out = ArrayList<ByteArray>((data.size + max - 1) / max)
  var i = 0
  while (i < data.size) {
    val end = minOf(i + max, data.size)
    out.add(data.copyOfRange(i, end))
    i = end
  }
  return out
}

/**
 * Per-device throttle for scan results: report a device when first seen,
 * then at most once per [minIntervalMs] (RSSI refreshes).
 */
class ScanThrottle(private val minIntervalMs: Long = 1_000) {
  private val lastAt = HashMap<String, Long>()

  fun shouldReport(id: String, nowMs: Long): Boolean {
    val last = lastAt[id]
    if (last != null && nowMs - last < minIntervalMs) return false
    lastAt[id] = nowMs
    return true
  }

  fun clear() = lastAt.clear()
}

/** Replays pre-split frames for the fake receiver; loops when asked to. */
class FrameCursor(private val frames: List<ByteArray>, private val loop: Boolean) {
  private var index = 0

  fun next(): ByteArray? {
    if (frames.isEmpty()) return null
    if (index >= frames.size) {
      if (!loop) return null
      index = 0
    }
    return frames[index++]
  }
}
