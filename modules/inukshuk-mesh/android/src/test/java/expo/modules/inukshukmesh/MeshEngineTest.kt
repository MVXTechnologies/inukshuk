package expo.modules.inukshukmesh

import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.Collections

// Real sockets on 127.0.0.1: two engines talking, and raw sockets playing a
// hostile peer. Run from MeshProtocolTest's main (scripts/test-android.sh).

class Recorder : MeshEngineListener {
  val connected: MutableList<Map<String, Any?>> = Collections.synchronizedList(mutableListOf())
  val disconnected: MutableList<List<Any?>> = Collections.synchronizedList(mutableListOf())
  val writable: MutableList<String> = Collections.synchronizedList(mutableListOf())
  val errors: MutableList<String> = Collections.synchronizedList(mutableListOf())
  @Volatile var available = 0

  override fun onConnected(peer: Map<String, Any?>) { connected.add(peer) }
  override fun onDisconnected(peerId: String?, dialId: String?, reason: String, retryInMs: Long?) {
    disconnected.add(listOf(peerId, dialId, reason, retryInMs))
  }
  override fun onFramesAvailable() { available++ }
  override fun onWritable(peerId: String) { writable.add(peerId) }
  override fun onError(code: String, message: String) { errors.add("$code $message") }
  fun reasons(): List<Any?> = synchronized(disconnected) { disconnected.map { it[2] } }
}

object MeshEngineTest {
  private fun waitFor(label: String, timeoutMs: Long = 5_000, cond: () -> Boolean) {
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
      if (cond()) { expect(true, label); return }
      Thread.sleep(10)
    }
    expect(false, "timed out: $label")
  }

  private fun engine(rec: Recorder, cfg: MeshConfig = MeshConfig(preferredPort = 0)) = MeshEngine(cfg, rec).also { it.start() }

  /** True when the server closed the raw socket (EOF or reset) within the timeout. */
  private fun closedByPeer(s: Socket, timeoutMs: Int = 3_000): Boolean {
    s.soTimeout = timeoutMs
    val input: InputStream = s.getInputStream()
    val buf = ByteArray(4096)
    return try {
      while (true) { if (input.read(buf) == -1) return true }
      @Suppress("UNREACHABLE_CODE") false
    } catch (e: SocketTimeoutException) { false } catch (e: java.io.IOException) { true }
  }

  private fun raw(port: Int): Socket = Socket().also { it.connect(InetSocketAddress("127.0.0.1", port), 2_000) }

  fun exchange() {
    val ra = Recorder(); val rb = Recorder()
    val a = engine(ra); val b = engine(rb)
    try {
      val dial = b.connect("127.0.0.1", a.port, reconnect = false)
      waitFor("both sides connected") { ra.connected.size == 1 && rb.connected.size == 1 }
      expect(rb.connected[0]["dialId"] == dial && rb.connected[0]["direction"] == "out", "outbound peer carries its dial")
      expect(ra.connected[0]["direction"] == "in", "inbound peer")
      val toA = rb.connected[0]["peerId"] as String
      val toB = ra.connected[0]["peerId"] as String
      val payload = ByteArray(300_000) { (it * 7).toByte() }
      b.send(toA, "hi".toByteArray())
      b.send(toA, payload)
      val got = mutableListOf<InFrame>()
      waitFor("frames arrive in order") { got.addAll(a.takeFrames(10)); got.size == 2 }
      expect(got[0].peerId == toB && String(got[0].data) == "hi", "first frame")
      expect(got[1].data.contentEquals(payload), "large frame intact")
      a.send(toB, "back".toByteArray())
      waitFor("reply") { b.takeFrames(10).any { String(it.data) == "back" } }

      var threw = ""
      try { b.send(toA, ByteArray(b.config.maxFrameBytes + 1)) } catch (e: MeshException) { threw = e.code }
      expect(threw == "E_MESH_FRAME_TOO_LARGE", "oversize send refused locally")
      try { b.send("nope", ByteArray(1)) } catch (e: MeshException) { threw = e.code }
      expect(threw == "E_MESH_NO_PEER", "unknown peer")
      try { b.send(toA, ByteArray(0)) } catch (e: MeshException) { threw = e.code }
      expect(threw == "E_MESH_ARGUMENT", "empty frame refused")

      @Suppress("UNCHECKED_CAST")
      val peers = a.stats()["peers"] as List<Map<String, Any?>>
      expect(peers.size == 1 && (peers[0]["bytesIn"] as Double) > 300_000, "stats count bytes")

      b.disconnect(toA)
      waitFor("disconnect seen on both sides") { ra.reasons().contains("remote-closed") && rb.reasons().contains("local") }
    } finally { a.stop(); b.stop() }
  }

  fun hostilePeers() {
    val ra = Recorder()
    val a = engine(ra, MeshConfig(preferredPort = 0, maxFrameBytes = 4096, handshakeTimeoutMs = 800, maxInboundPerIp = 4))
    try {
      // An HTTP probe: closed on its first byte.
      raw(a.port).use { s ->
        s.getOutputStream().write("GET / HTTP/1.1\r\n\r\n".toByteArray())
        expect(closedByPeer(s), "garbage preamble closed")
      }
      // A valid hello, then a length over the cap.
      raw(a.port).use { s ->
        s.getOutputStream().write(MeshWire.preamble() + byteArrayOf(0, 0, 0x10, 0x01))
        expect(closedByPeer(s), "oversize frame closed")
      }
      // Silent socket: handshake timeout. That is the third strike: banned.
      raw(a.port).use { s -> expect(closedByPeer(s, 4_000), "silent socket closed") }
      waitFor("ban recorded") { (a.stats()["activeBans"] as Int) >= 1 }
      raw(a.port).use { s ->
        s.getOutputStream().write(MeshWire.preamble())
        expect(closedByPeer(s), "banned address refused at accept")
      }
      expect(ra.connected.isEmpty() || ra.connected.size == 1, "hostile sockets rarely reach JS")
      expect((a.stats()["violations"] as Double) >= 2.0, "violations counted")
    } finally { a.stop() }
  }

  fun perIpLimit() {
    val ra = Recorder()
    val a = engine(ra, MeshConfig(preferredPort = 0, maxInboundPerIp = 1))
    try {
      raw(a.port).use { first ->
        first.getOutputStream().write(MeshWire.preamble())
        waitFor("first accepted") { ra.connected.size == 1 }
        raw(a.port).use { second -> expect(closedByPeer(second), "second from the same address refused") }
      }
    } finally { a.stop() }
  }

  fun idleAndKeepalive() {
    val ra = Recorder()
    val a = engine(ra, MeshConfig(preferredPort = 0, keepaliveMs = 1_000, idleTimeoutMs = 3_000))
    try {
      raw(a.port).use { s ->
        s.getOutputStream().write(MeshWire.preamble())
        waitFor("connected") { ra.connected.size == 1 }
        // We get its preamble and then keepalives while we stay silent.
        s.soTimeout = 2_500
        val buf = ByteArray(12)
        var n = 0
        while (n < 12) { val r = s.getInputStream().read(buf, n, 12 - n); if (r < 0) break; n += r }
        expect(n == 12 && buf.copyOfRange(8, 12).contentEquals(ByteArray(4)), "keepalive after the preamble")
        waitFor("idle peer closed", 6_000) { ra.reasons().contains("idle") }
      }
    } finally { a.stop() }
  }

  fun backpressure() {
    val ra = Recorder(); val rb = Recorder()
    val frame = 64 * 1024
    val small = MeshConfig(
      preferredPort = 0, maxFrameBytes = frame, maxQueuedBytes = 4 * (frame + 4),
      maxInboxBytesPerPeer = 2 * frame, maxInboxBytes = 4 * frame,
    )
    val a = engine(ra, small); val b = engine(rb, small)
    try {
      b.connect("127.0.0.1", a.port, reconnect = false)
      waitFor("connected") { ra.connected.size == 1 && rb.connected.size == 1 }
      val toA = rb.connected[0]["peerId"] as String
      // A never takes frames: its inbox fills, it stops reading, TCP fills,
      // B's queue fills and stays full (no onWritable): end-to-end backpressure.
      var stalled = false
      var sent = 0
      val end = System.currentTimeMillis() + 20_000
      while (!stalled && System.currentTimeMillis() < end) {
        try {
          b.send(toA, ByteArray(frame)); sent++
        } catch (e: MeshException) {
          expect(e.code == "E_MESH_BACKPRESSURE", "backpressure code")
          val before = rb.writable.size
          val wait = System.currentTimeMillis() + 1_500
          while (rb.writable.size == before && System.currentTimeMillis() < wait) Thread.sleep(10)
          stalled = rb.writable.size == before
        }
      }
      expect(stalled, "sender stalls while the receiver does not read")
      @Suppress("UNCHECKED_CAST")
      val aPeers = a.stats()["peers"] as List<Map<String, Any?>>
      expect(aPeers[0]["throttled"] == true, "receiver paused reading")
      expect((a.stats()["inboxBytes"] as Double) <= 4.0 * frame + frame, "receiver inbox bounded")
      // Drain A; B must hear it may write again, and every frame must arrive.
      val writableBefore = rb.writable.size
      var received = 0
      waitFor("all frames delivered after draining", 20_000) {
        received += a.takeFrames(64).size
        received >= sent
      }
      expect(received == sent, "no frame lost or duplicated")
      waitFor("writable announced after the stall") { rb.writable.size > writableBefore }
    } finally { a.stop(); b.stop() }
  }

  // A peer whose frames are already queued in the socket (a burst, a slow
  // receiver catching up): one wakeup must not deliver past the inbox bound.
  // It used to read up to 4 × 64 KB per wakeup before checking it, so the
  // inbox could reach the bound plus ~4 frames ("receiver inbox bounded",
  // flaky on CI where wakeups find more data queued).
  fun burstInboxBound() {
    val ra = Recorder()
    val frame = 64 * 1024
    val readChunk = 64 * 1024
    val cfg = MeshConfig(
      preferredPort = 0, maxFrameBytes = frame, maxInboxBytesPerPeer = 2 * frame,
      maxInboxBytes = 16 * frame, bytesPerSec = 64 * 1024 * 1024, framesPerSec = 10_000,
    )
    val a = engine(ra, cfg)
    try {
      raw(a.port).use { s ->
        var burst = MeshWire.preamble()
        repeat(16) { burst += MeshWire.encode(ByteArray(frame)) }
        // The engine stops reading part-way, so this write may never finish:
        // it runs on its own thread, and closing the socket ends it.
        Thread { try { s.getOutputStream().write(burst) } catch (_: Exception) {} }
          .apply { isDaemon = true }.start()
        waitFor("receiver paused") {
          @Suppress("UNCHECKED_CAST")
          val peers = a.stats()["peers"] as List<Map<String, Any?>>
          peers.isNotEmpty() && peers[0]["throttled"] == true
        }
        Thread.sleep(300)
        val inbox = a.stats()["inboxBytes"] as Double
        // At most: the bound, a frame the decoder was finishing, one read.
        expect(inbox <= (2 * frame + frame + readChunk).toDouble(), "inbox bounded under a burst ($inbox)")
      }
    } finally { a.stop() }
  }

  fun throttle() {
    val ra = Recorder()
    val a = engine(ra, MeshConfig(preferredPort = 0, framesPerSec = 10))
    try {
      raw(a.port).use { s ->
        val out = s.getOutputStream()
        val burst = ByteArray(0).let { var acc = MeshWire.preamble(); repeat(100) { acc += MeshWire.encode(byteArrayOf(1)) }; acc }
        out.write(burst)
        var got = 0
        waitFor("burst delivered") { got += a.takeFrames(1000).size; got == 100 }
        out.write(MeshWire.encode(byteArrayOf(2)))
        Thread.sleep(1_500)
        expect(a.takeFrames(10).isEmpty(), "over-rate peer is not read")
        @Suppress("UNCHECKED_CAST")
        val peers = a.stats()["peers"] as List<Map<String, Any?>>
        expect(peers[0]["throttled"] == true, "throttled in stats")
      }
    } finally { a.stop() }
  }

  fun reconnect() {
    val ra = Recorder(); val rb = Recorder()
    val a = engine(ra)
    val port = a.port
    val b = engine(rb)
    try {
      val dial = b.connect("127.0.0.1", port, reconnect = true)
      waitFor("connected") { rb.connected.size == 1 }
      a.stop()
      waitFor("drop reported with a retry") {
        synchronized(rb.disconnected) { rb.disconnected.any { it[1] == dial && it[3] != null } }
      }
      val a2 = MeshEngine(MeshConfig(preferredPort = port), Recorder())
      a2.start()
      try {
        expect(a2.port == port, "listener back on the same port")
        waitFor("redialled with backoff", 15_000) { rb.connected.size == 2 && rb.connected[1]["dialId"] == dial }
        b.disconnect(dial)
        waitFor("cancelled") { rb.reasons().contains("local") }
      } finally { a2.stop() }

      // A dial without reconnect gives up once.
      val once = b.connect("127.0.0.1", 1, reconnect = false)
      waitFor("single attempt fails") {
        synchronized(rb.disconnected) { rb.disconnected.any { it[1] == once && it[3] == null } }
      }
    } finally { b.stop() }
  }

  fun banByCore() {
    val ra = Recorder(); val rb = Recorder()
    val a = engine(ra); val b = engine(rb)
    try {
      val dial = b.connect("127.0.0.1", a.port, reconnect = true)
      waitFor("connected") { ra.connected.size == 1 }
      a.ban(ra.connected[0]["peerId"] as String, 60_000)
      waitFor("banned close") { ra.reasons().contains("banned") }
      Thread.sleep(2_500)
      expect(ra.connected.size == 1, "a banned address cannot come back")
      b.disconnect(dial)
      var threw = ""
      a.stop()
      try { a.connect("127.0.0.1", 1, false) } catch (e: MeshException) { threw = e.code }
      expect(threw == "E_MESH_NOT_RUNNING", "commands need a running mesh")
    } finally { a.stop(); b.stop() }
  }

  fun run() {
    exchange()
    hostilePeers()
    perIpLimit()
    idleAndKeepalive()
    backpressure()
    burstInboxBound()
    throttle()
    reconnect()
    banByCore()
    println("MeshEngineTest: passed")
  }
}
