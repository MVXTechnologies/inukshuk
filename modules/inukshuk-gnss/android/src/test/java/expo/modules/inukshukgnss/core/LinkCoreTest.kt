package expo.modules.inukshukgnss.core

// Framework-free tests (plain `main`, like the PDF module's Java tests) so they
// run with kotlinc + java alone: see android/tests/run.sh.

private var failures = 0
private var checks = 0

private fun check(name: String, condition: Boolean) {
  checks += 1
  if (!condition) {
    failures += 1
    System.err.println("FAIL: $name")
  }
}

private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

private fun backoffTests() {
  val b = Backoff(initialMs = 1_000, maxMs = 30_000, stableMs = 10_000)
  val delays = (1..8).map { b.nextDelayMs() }
  check("backoff doubles then caps", delays == listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L))
  check("backoff counts attempts", b.attempt == 8)

  // A link that drops straight away does not reset the schedule…
  b.onConnected(0)
  b.onDisconnected(2_000)
  check("short link keeps backoff", b.nextDelayMs() == 30_000L)
  // …one that stayed up does.
  b.onConnected(10_000)
  b.onDisconnected(25_000)
  check("stable link resets backoff", b.attempt == 0 && b.nextDelayMs() == 1_000L)

  // Disconnect without a connect is harmless.
  b.onDisconnected(99_000)
  check("disconnect without connect keeps attempt", b.attempt == 1)
  b.reset()
  check("reset", b.attempt == 0)

  // Many retries never overflow into a negative or zero delay.
  val big = Backoff()
  repeat(200) { big.nextDelayMs() }
  check("no overflow after many attempts", big.nextDelayMs() == 30_000L)
}

private fun ringTests() {
  val r = ByteRing(8)
  r.append(bytes(1, 2, 3))
  check("ring size", r.size == 3)
  check("ring take partial", r.take(2).contentEquals(bytes(1, 2)))
  r.append(bytes(4, 5, 6, 7, 8, 9, 10))
  check("ring wraps without loss", r.size == 8 && r.takeDropped() == 0L)
  check("ring order after wrap", r.take(100).contentEquals(bytes(3, 4, 5, 6, 7, 8, 9, 10)))
  check("ring empty", r.size == 0 && r.take(4).isEmpty())

  // Overflow drops the OLDEST bytes and counts them.
  r.append(bytes(1, 2, 3, 4, 5, 6))
  r.append(bytes(7, 8, 9, 10))
  check("overflow drop count", r.takeDropped() == 2L)
  check("overflow keeps newest", r.take(8).contentEquals(bytes(3, 4, 5, 6, 7, 8, 9, 10)))
  check("dropped resets after read", r.takeDropped() == 0L)

  // A single write larger than the ring keeps its tail.
  r.append(bytes(1, 2))
  r.append(ByteArray(20) { it.toByte() })
  check("huge append drop count", r.takeDropped() == 14L)
  check("huge append keeps tail", r.take(8).contentEquals(ByteArray(8) { (it + 12).toByte() }))

  // Offset/length slices.
  r.append(bytes(9, 9, 1, 2, 3, 9), off = 2, len = 3)
  check("append slice", r.take(8).contentEquals(bytes(1, 2, 3)))

  r.append(bytes(1, 2, 3))
  r.clear()
  check("clear counts as dropped", r.size == 0 && r.takeDropped() == 3L)

  var threw = false
  try {
    r.append(bytes(1, 2), off = 1, len = 2)
  } catch (e: IllegalArgumentException) {
    threw = true
  }
  check("bad slice rejected", threw)
}

private fun pacerTests() {
  val p = FlushPacer(100)
  check("first flush immediate", p.delayMs(1_000) == 0L)
  p.flushed(1_000)
  check("second flush waits", p.delayMs(1_030) == 70L)
  check("after interval immediate", p.delayMs(1_100) == 0L)
}

private fun splitTests() {
  val parts = splitForWrite(ByteArray(10) { it.toByte() }, 4)
  check("split sizes", parts.map { it.size } == listOf(4, 4, 2))
  check("split content", parts[2].contentEquals(bytes(8, 9)))
  check("split empty", splitForWrite(ByteArray(0), 20).isEmpty())
  check("split exact", splitForWrite(ByteArray(20), 20).size == 1)
}

private fun throttleTests() {
  val t = ScanThrottle(1_000)
  check("first sighting reported", t.shouldReport("a", 0))
  check("refresh throttled", !t.shouldReport("a", 500))
  check("other device reported", t.shouldReport("b", 500))
  check("refresh after interval", t.shouldReport("a", 1_000))
  t.clear()
  check("cleared reports again", t.shouldReport("a", 1_001))
}

private fun cursorTests() {
  val c = FrameCursor(listOf(bytes(1), bytes(2)), loop = true)
  check("cursor loops", listOf(c.next(), c.next(), c.next()).map { it!![0].toInt() } == listOf(1, 2, 1))
  val once = FrameCursor(listOf(bytes(1)), loop = false)
  once.next()
  check("cursor ends without loop", once.next() == null)
  check("empty cursor", FrameCursor(emptyList(), loop = true).next() == null)
}

private const val NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
private const val NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
private const val NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

private fun profileTests() {
  check("normalize full", normalizeUuid(" 6E400001-B5A3-F393-E0A9-E50E24DCCA9E ") == NUS)
  check("normalize 16-bit", normalizeUuid("FFE0") == "0000ffe0-0000-1000-8000-00805f9b34fb")
  check("normalize 32-bit", normalizeUuid("0000ffe1") == "0000ffe1-0000-1000-8000-00805f9b34fb")
  check("reject junk", normalizeUuid("nus") == null && normalizeUuid("") == null && normalizeUuid("12345") == null)

  val nus = gattProfileOf("nus", NUS, NUS_TX, NUS_RX)!!
  val hm10 = gattProfileOf("hm10", "ffe0", "ffe1", "ffe1")!!
  val readOnly = gattProfileOf("ro", NUS, NUS_TX, null)!!
  check("profile parse", nus.service == NUS && hm10.write == "0000ffe1-0000-1000-8000-00805f9b34fb")
  check("profile rejects bad uuid", gattProfileOf("x", "zz", NUS_TX, null) == null)
  check("profile rejects bad write uuid", gattProfileOf("x", NUS, NUS_TX, "nope") == null)
  check("profile rejects empty name", gattProfileOf(" ", NUS, NUS_TX, null) == null)
  check("profile without write", readOnly.write == null)

  val full: DiscoveredGatt = mapOf(
    NUS to mapOf(NUS_TX to CharCaps(true, false), NUS_RX to CharCaps(false, true)),
  )
  check("nus selected writable", selectProfile(listOf(hm10, nus), full) == ProfileChoice(nus, true))

  val hmFound: DiscoveredGatt = mapOf(hm10.service to mapOf(hm10.notify to CharCaps(true, true)))
  check("same-char profile", selectProfile(listOf(nus, hm10), hmFound) == ProfileChoice(hm10, true))

  val noWrite: DiscoveredGatt = mapOf(NUS to mapOf(NUS_TX to CharCaps(true, false)))
  check("falls back to read-only", selectProfile(listOf(nus), noWrite) == ProfileChoice(nus, false))
  check("read-only profile is never writable", selectProfile(listOf(readOnly), full) == ProfileChoice(readOnly, false))

  // Priority: a full match later in the list beats a read-only match earlier.
  val both: DiscoveredGatt = noWrite + hmFound
  check("full match preferred", selectProfile(listOf(nus, hm10), both) == ProfileChoice(hm10, true))

  val cannotNotify: DiscoveredGatt = mapOf(NUS to mapOf(NUS_TX to CharCaps(false, true)))
  check("no notify, no profile", selectProfile(listOf(nus), cannotNotify) == null)
  check("unknown service", selectProfile(listOf(nus), emptyMap()) == null)
}

fun main() {
  backoffTests()
  ringTests()
  pacerTests()
  splitTests()
  throttleTests()
  cursorTests()
  profileTests()
  if (failures > 0) {
    System.err.println("$failures of $checks checks failed")
    kotlin.system.exitProcess(1)
  }
  println("inukshuk-gnss core: $checks checks passed")
}
