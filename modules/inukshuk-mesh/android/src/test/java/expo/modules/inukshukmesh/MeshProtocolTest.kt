package expo.modules.inukshukmesh

import java.util.Random

// Host test for MeshProtocol.kt (no JUnit: scripts/test-android.sh compiles
// it with kotlinc and runs main). Mirrors ios/Tests/MeshProtocolTests.swift.

private var checks = 0

internal fun expect(value: Boolean, label: String) {
  checks++
  if (!value) throw AssertionError(label)
}

private fun stream(vararg frames: ByteArray): ByteArray {
  val parts = mutableListOf(MeshWire.preamble())
  for (f in frames) parts.add(if (f.isEmpty()) MeshWire.keepalive() else MeshWire.encode(f))
  val out = ByteArray(parts.sumOf { it.size })
  var o = 0
  for (p in parts) { System.arraycopy(p, 0, out, o, p.size); o += p.size }
  return out
}

private fun header(len: Long): ByteArray =
  byteArrayOf((len ushr 24).toByte(), (len ushr 16).toByte(), (len ushr 8).toByte(), len.toByte())

private fun decodeAll(bytes: ByteArray, cap: Int, chunk: (Int) -> Int): Pair<DecodeStatus, List<ByteArray>> {
  val d = FrameDecoder(cap)
  val out = mutableListOf<ByteArray>()
  var i = 0
  var status = DecodeStatus.OK
  while (i < bytes.size) {
    val n = minOf(chunk(i), bytes.size - i).coerceAtLeast(1)
    status = d.feed(bytes, i, n, out)
    if (status != DecodeStatus.OK) break
    i += n
  }
  return status to out
}

fun wireTests() {
  val a = "hello".toByteArray()
  val b = ByteArray(70_000) { (it % 251).toByte() }
  val s = stream(a, ByteArray(0), b)
  for (chunking in listOf<(Int) -> Int>({ s.size }, { 1 }, { 3 }, { 4096 })) {
    val (status, frames) = decodeAll(s, 512 * 1024, chunking)
    expect(status == DecodeStatus.OK, "roundtrip status")
    expect(frames.size == 2, "keepalive is not delivered")
    expect(frames[0].contentEquals(a) && frames[1].contentEquals(b), "roundtrip content")
  }
  val d = FrameDecoder(1024)
  val out = mutableListOf<ByteArray>()
  d.feed(s, 0, 8 + 4 + 5 + 4, out)
  expect(d.keepalives == 1L && out.size == 1, "keepalive counted")

  // Preamble: wrong magic fails on its first wrong byte.
  expect(FrameDecoder(1024).feed("G".toByteArray(), 0, 1, out) == DecodeStatus.BAD_MAGIC, "bad magic early")
  expect(decodeAll("GET / HTTP/1.1\r\n\r\n".toByteArray(), 1024) { 64 }.first == DecodeStatus.BAD_MAGIC, "http probe")
  val v2 = MeshWire.preamble().also { it[4] = 2 }
  expect(FrameDecoder(1024).feed(v2, 0, 8, out) == DecodeStatus.INCOMPATIBLE, "other version")

  // Size cap, unsigned lengths, exact cap.
  val cap = 2048
  expect(decodeAll(MeshWire.preamble() + header(cap + 1L), cap) { 64 }.first == DecodeStatus.OVERSIZE, "cap + 1")
  expect(decodeAll(MeshWire.preamble() + header(0xFFFFFFFFL), cap) { 64 }.first == DecodeStatus.OVERSIZE, "u32 max")
  expect(decodeAll(MeshWire.preamble() + header(0x80000000L), cap) { 64 }.first == DecodeStatus.OVERSIZE, "sign bit")
  val exact = decodeAll(stream(ByteArray(cap) { 7 }), cap) { 100 }
  expect(exact.first == DecodeStatus.OK && exact.second.single().size == cap, "exact cap")

  // Dead after a violation.
  val dead = FrameDecoder(cap)
  dead.feed(MeshWire.preamble() + header(cap + 1L), 0, 12, out)
  val again = stream(a)
  expect(dead.feed(again, 8, again.size - 8, out) == DecodeStatus.OVERSIZE, "stays dead")

  // Announce the maximum, send a trickle: allocation follows what arrived.
  val trickle = FrameDecoder(MeshWire.MAX_FRAME_CEILING)
  val big = MeshWire.preamble() + header(MeshWire.MAX_FRAME_CEILING.toLong()) + ByteArray(10)
  trickle.feed(big, 0, big.size, out)
  expect(trickle.peakAllocation <= MeshWire.MIN_BODY_ALLOC, "no allocation from an untrusted length")
  expect(trickle.buffered <= MeshWire.MIN_BODY_ALLOC, "buffered follows arrival")

  // Frame sizes and encoding.
  expect(MeshWire.encode(a).size == 9 && MeshWire.encode(a)[3] == 5.toByte(), "header")
  expect(MeshWire.keepalive().contentEquals(ByteArray(4)), "keepalive bytes")
  // Cross-platform vector: the same bytes the Swift test builds.
  val vector = byteArrayOf(0x49, 0x4E, 0x4B, 0x4D, 1, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3)
  expect((MeshWire.preamble() + MeshWire.encode(byteArrayOf(1, 2, 3))).contentEquals(vector), "wire vector")
}

/** Random frames, random chunking: exact reassembly, bounded allocation. */
fun fuzzValid(seed: Long, rounds: Int) {
  val rnd = Random(seed)
  repeat(rounds) {
    val cap = 1024 + rnd.nextInt(64 * 1024)
    val frames = List(1 + rnd.nextInt(12)) {
      val size = when (rnd.nextInt(4)) { 0 -> 0; 1 -> cap; else -> rnd.nextInt(cap + 1) }
      ByteArray(size).also { rnd.nextBytes(it) }
    }
    val bytes = stream(*frames.toTypedArray())
    val maxChunk = 1 + rnd.nextInt(9000)
    val d = FrameDecoder(cap)
    val out = mutableListOf<ByteArray>()
    var i = 0
    while (i < bytes.size) {
      val n = minOf(1 + rnd.nextInt(maxChunk), bytes.size - i)
      expect(d.feed(bytes, i, n, out) == DecodeStatus.OK, "fuzz valid status")
      i += n
    }
    val expected = frames.filter { it.isNotEmpty() }
    expect(out.size == expected.size, "fuzz frame count")
    for (k in expected.indices) expect(out[k].contentEquals(expected[k]), "fuzz frame content")
    expect(d.peakAllocation <= cap, "fuzz allocation within cap")
    expect(d.buffered == 0, "nothing left over")
  }
}

/** Garbage after a valid preamble: never throws, never allocates beyond what arrived (×2) or the cap. */
fun fuzzGarbage(seed: Long, rounds: Int) {
  val rnd = Random(seed)
  repeat(rounds) {
    val cap = 1024 + rnd.nextInt(MeshWire.MAX_FRAME_CEILING - 1024)
    val garbage = ByteArray(rnd.nextInt(20_000)).also { rnd.nextBytes(it) }
    // Half the rounds: a plausible header so the body path is exercised.
    if (garbage.size >= 4 && rnd.nextBoolean()) {
      val len = rnd.nextInt(cap + 1).toLong()
      System.arraycopy(header(len), 0, garbage, 0, 4)
    }
    val bytes = if (rnd.nextInt(5) == 0) garbage else MeshWire.preamble() + garbage
    val d = FrameDecoder(cap)
    val out = mutableListOf<ByteArray>()
    var i = 0
    var fed = 0
    while (i < bytes.size) {
      val n = minOf(1 + rnd.nextInt(5000), bytes.size - i)
      val status = d.feed(bytes, i, n, out)
      fed += n
      expect(d.peakAllocation <= maxOf(MeshWire.MIN_BODY_ALLOC, 2 * fed), "garbage allocation follows arrival")
      expect(d.peakAllocation <= cap, "garbage allocation within cap")
      if (status != DecodeStatus.OK) break
      i += n
    }
    for (f in out) expect(f.size in 1..cap, "garbage frames within cap")
  }
}

fun bucketTests() {
  val b = DebtBucket(10.0, 20.0)
  b.charge(20.0, 0)
  expect(b.waitMs(0) == 0L, "burst is free")
  b.charge(10.0, 0)
  expect(b.waitMs(0) == 1000L, "10 over at 10/s waits 1 s")
  expect(b.waitMs(500) == 500L, "refills over time")
  expect(b.waitMs(1000) == 0L, "out of debt")
  expect(b.waitMs(100_000) == 0L, "capped at burst")
  b.charge(20.0, 100_000)
  expect(b.waitMs(100_000) == 0L, "burst after long idle, not more")
  b.charge(1.0, 100_000)
  expect(b.waitMs(100_000) > 0L, "burst is the ceiling")
}

fun backoffTests() {
  expect(Backoff.delayMs(0, 0.5) == 1000L, "first delay")
  expect(Backoff.delayMs(1, 0.5) == 2000L, "doubles")
  expect(Backoff.delayMs(3, 0.0) == 6400L, "jitter low")
  expect(Backoff.delayMs(3, 1.0) == 9600L, "jitter high")
  expect(Backoff.delayMs(30, 0.99) <= Backoff.MAX_MS, "capped")
  expect(Backoff.delayMs(-5, 0.5) == 1000L, "negative attempt")
}

fun banTests() {
  val bans = BanList(capacity = 4, strikesToBan = 3, strikeWindowMs = 1000, strikeBanMs = 5000)
  expect(!bans.strike("a", 0) && !bans.strike("a", 10), "two strikes are not a ban")
  expect(bans.strike("a", 20) && bans.isBanned("a", 21), "third strike bans")
  expect(!bans.isBanned("a", 5021), "ban expires")
  expect(!bans.strike("b", 0) && !bans.strike("b", 1500) && !bans.strike("b", 1600), "strikes age out of the window")
  for (i in 0 until 100) bans.ban("ip$i", 10_000L + i, 0)
  expect(bans.activeCount(0) <= 4, "bounded")
  expect(bans.isBanned("ip99", 0), "newest ban kept")
  bans.ban("ip99", 5, 0)
  expect(bans.isBanned("ip99", 50), "a shorter ban never shortens a longer one")
  for (i in 0 until 1000) bans.strike("s$i", 0)
  expect(bans.activeCount(0) <= 4, "strike flood stays bounded")

  val rate = AcceptRate(perMinute = 3, capacity = 4)
  expect(rate.admit("x", 0) && rate.admit("x", 1) && rate.admit("x", 2), "under rate")
  expect(!rate.admit("x", 3), "over rate")
  expect(rate.admit("x", 60_001), "window slides")
  for (i in 0 until 1000) rate.admit("y$i", 0)
}

fun configTests() {
  val d = MeshConfig.from(null)
  expect(d == MeshConfig(), "defaults")
  expect(d.preferredPort == 47321, "well-known port")
  val c = MeshConfig.from(
    mapOf(
      "maxFrameBytes" to 1e12, "maxPeers" to -3.0, "maxInboundPerIp" to 99.0, "bytesPerSec" to Double.NaN,
      "keepaliveMs" to 30_000.0, "idleTimeoutMs" to 1.0, "maxQueuedBytes" to 1.0, "preferredPort" to "x",
    ),
  )
  expect(c.maxFrameBytes == MeshWire.MAX_FRAME_CEILING, "frame ceiling")
  expect(c.maxPeers == 1, "peers floor")
  expect(c.maxInboundPerIp == 4, "per-ip ceiling")
  expect(c.bytesPerSec == d.bytesPerSec, "NaN keeps the default")
  expect(c.idleTimeoutMs >= 2 * c.keepaliveMs, "idle outlasts two keepalives")
  expect(c.maxQueuedBytes >= 2 * (c.maxFrameBytes + 4), "queue holds two frames")
  expect(c.preferredPort == 47321, "non-number ignored")
}

fun tagTests() {
  expect(MeshTags.isValid("abcdEFGH_-12"), "base64url tag")
  expect(!MeshTags.isValid("short") && !MeshTags.isValid(null), "too short")
  expect(!MeshTags.isValid("a".repeat(44)), "too long")
  expect(!MeshTags.isValid("My Team Name"), "no names")
  expect(!MeshTags.isValid("abcdefgh=,"), "no TXT separators")
  val name = MeshTags.instanceName(Random(1))
  expect(Regex("^ink-[a-z2-7]{12}$").matches(name), "instance name")
  expect(MeshTags.SERVICE_TYPE == "_inukshuk-team._tcp", "service type")
}

fun main(args: Array<String>) {
  val rounds = args.firstOrNull()?.toIntOrNull() ?: 400
  wireTests()
  fuzzValid(589, rounds)
  fuzzGarbage(590, rounds * 2)
  bucketTests()
  backoffTests()
  banTests()
  configTests()
  tagTests()
  println("MeshProtocolTest: passed $checks checks")
  MeshEngineTest.run()
}
