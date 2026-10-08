package expo.modules.inukshukmesh

import java.io.IOException
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.StandardSocketOptions
import java.nio.ByteBuffer
import java.nio.channels.CancelledKeyException
import java.nio.channels.SelectionKey
import java.nio.channels.Selector
import java.nio.channels.ServerSocketChannel
import java.nio.channels.SocketChannel
import java.util.Random
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** What the engine reports. Called on the engine's I/O thread; must not block. */
interface MeshEngineListener {
  fun onConnected(peer: Map<String, Any?>)
  fun onDisconnected(peerId: String?, dialId: String?, reason: String, retryInMs: Long?)
  fun onFramesAvailable()
  fun onWritable(peerId: String)
  fun onError(code: String, message: String)
}

class MeshException(val code: String, message: String) : Exception(message)

/** A received frame waiting for JS to take it. */
class InFrame(val peerId: String, val data: ByteArray)

/**
 * The TCP half of the team mesh: one listener, outgoing dials with
 * reconnect, length-prefixed frames, per-peer send queues with backpressure,
 * read throttling, connection limits, timeouts and bans.
 *
 * One NIO selector thread owns every socket and all connection state.
 * [send], [takeFrames], [stats] and the commands may be called from any
 * thread: they touch only concurrent structures or post a task to the
 * I/O thread. Pure JVM (no Android imports): the host test drives two
 * engines over 127.0.0.1. Android-only concerns (binding a socket to the
 * Wi-Fi network) come in through [socketBinder].
 */
class MeshEngine(
  val config: MeshConfig,
  private val listener: MeshEngineListener,
  private val socketBinder: ((SocketChannel, InetAddress) -> Unit)? = null,
  private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
  private val random: Random = Random(),
) {
  private inner class Dial(
    val id: String,
    var host: String,
    var port: Int,
    val reconnect: Boolean,
  ) {
    var attempt = 0
    var conn: Conn? = null
    var retryAt = 0L
    var cancelled = false
  }

  private inner class Conn(
    val id: String,
    val channel: SocketChannel,
    val outbound: Boolean,
    val dial: Dial?,
    val ip: String,
    val port: Int,
  ) {
    val decoder = FrameDecoder(config.maxFrameBytes)
    val created = clock()
    var key: SelectionKey? = null
    var connecting = outbound
    @Volatile var established = false
    var establishedAt = 0L
    var lastRecv = created
    @Volatile var lastSend = created
    @Volatile var closed = false

    val sendLock = Any()
    val queue = ArrayDeque<ByteBuffer>()
    val queuedBytes = AtomicLong()
    @Volatile var wantWritable = false

    val bytesBucket = DebtBucket(config.bytesPerSec.toDouble(), config.bytesPerSec * 2.0)
    val framesBucket = DebtBucket(config.framesPerSec.toDouble(), config.framesPerSec * 2.0)
    var throttledUntil = 0L
    @Volatile var inboxPaused = false
    val inboxBytes = AtomicLong()

    val bytesIn = AtomicLong()
    val bytesOut = AtomicLong()
    val framesIn = AtomicLong()
    val framesOut = AtomicLong()
  }

  private val running = AtomicBoolean(false)
  private var selector: Selector? = null
  private var server: ServerSocketChannel? = null
  private var thread: Thread? = null
  private val tasks = ConcurrentLinkedQueue<() -> Unit>()

  private val conns = ConcurrentHashMap<String, Conn>()
  private val dials = HashMap<String, Dial>()
  private val bans = BanList(strikeBanMs = config.defaultBanMs)
  private val acceptRate = AcceptRate(config.acceptsPerMinutePerIp)

  private val inbox = ConcurrentLinkedQueue<InFrame>()
  private val inboxBytes = AtomicLong()
  private val notifyPending = AtomicBoolean(false)

  private val nextId = AtomicInteger(0)
  private val readBuffer = ByteBuffer.allocateDirect(64 * 1024)
  private val readArray = ByteArray(64 * 1024)

  private val totalRejected = AtomicLong()
  private val totalViolations = AtomicLong()
  @Volatile private var listeningPort = -1
  @Volatile private var activeBans = 0

  val port: Int get() = listeningPort

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Binds the listener (preferred port, else any) and starts the I/O thread. Returns the port. */
  @Synchronized
  fun start(): Int {
    if (running.get()) return listeningPort
    val sel = Selector.open()
    val srv = ServerSocketChannel.open()
    try {
      srv.configureBlocking(false)
      srv.setOption(StandardSocketOptions.SO_REUSEADDR, true)
      try {
        srv.bind(InetSocketAddress(config.preferredPort), 16)
      } catch (e: BindException) {
        // Someone holds the well-known port (another app, a stale socket):
        // take any port; the invite and the advert carry the real one.
        srv.bind(InetSocketAddress(0), 16)
      }
      srv.register(sel, SelectionKey.OP_ACCEPT)
    } catch (e: IOException) {
      try { srv.close() } catch (_: IOException) {}
      try { sel.close() } catch (_: IOException) {}
      throw MeshException("E_MESH_LISTEN", "Cannot listen: ${e.message}")
    }
    selector = sel
    server = srv
    listeningPort = srv.socket().localPort
    running.set(true)
    val t = Thread({ loop() }, "inukshuk-mesh-io")
    t.isDaemon = true
    thread = t
    t.start()
    return listeningPort
  }

  /** Closes every connection and the listener; drops queued and unread frames. */
  @Synchronized
  fun stop() {
    if (!running.getAndSet(false)) return
    val done = CountDownLatch(1)
    tasks.add {
      for (c in conns.values.toList()) close(c, "stopped", strike = false, allowRetry = false)
      dials.clear()
      done.countDown()
    }
    selector?.wakeup()
    done.await(2, TimeUnit.SECONDS)
    thread?.join(2_000)
    try { server?.close() } catch (_: IOException) {}
    try { selector?.close() } catch (_: IOException) {}
    server = null
    selector = null
    thread = null
    listeningPort = -1
    conns.clear()
    inbox.clear()
    inboxBytes.set(0)
    notifyPending.set(false)
  }

  val isRunning: Boolean get() = running.get()

  // ── Commands (any thread) ─────────────────────────────────────────────────

  /** Dials host:port; returns the dial id. With [reconnect], retries with backoff until cancelled. */
  fun connect(host: String, port: Int, reconnect: Boolean): String {
    requireRunning()
    if (host.isEmpty() || host.length > 255) throw MeshException("E_MESH_ARGUMENT", "Invalid host")
    if (port !in 1..65535) throw MeshException("E_MESH_ARGUMENT", "Invalid port")
    val dialId = "d" + nextId.incrementAndGet()
    post {
      val dial = Dial(dialId, host, port, reconnect)
      dials[dialId] = dial
      attempt(dial)
    }
    return dialId
  }

  /** Closes a peer (by peer id) or cancels a dial and its retries (by dial id). */
  fun disconnect(id: String) {
    post {
      dials.remove(id)?.let { dial ->
        dial.cancelled = true
        dial.conn?.let { close(it, "local", strike = false, allowRetry = false) }
      }
      conns[id]?.let { c ->
        c.dial?.let { it.cancelled = true; dials.remove(it.id) }
        close(c, "local", strike = false, allowRetry = false)
      }
    }
  }

  /** Bans the peer's address for [durationMs] (capped at 24 h) and closes it. */
  fun ban(peerId: String, durationMs: Long) {
    val ms = durationMs.coerceIn(1_000, MeshConfig.MAX_BAN_MS)
    post {
      val c = conns[peerId] ?: return@post
      val now = clock()
      bans.ban(c.ip, now + ms, now)
      c.dial?.let { it.cancelled = true; dials.remove(it.id) }
      close(c, "banned", strike = false, allowRetry = false)
    }
  }

  /**
   * Queues one frame. Returns the peer's queued bytes after it.
   * Throws E_MESH_NO_PEER, E_MESH_FRAME_TOO_LARGE or E_MESH_BACKPRESSURE (not
   * queued; an onWritable event follows once the queue has drained).
   */
  fun send(peerId: String, payload: ByteArray): Long {
    val c = conns[peerId]
    if (c == null || !c.established || c.closed) throw MeshException("E_MESH_NO_PEER", "No connected peer $peerId")
    if (payload.isEmpty()) throw MeshException("E_MESH_ARGUMENT", "Empty frames are reserved for keepalives")
    if (payload.size > config.maxFrameBytes) {
      throw MeshException("E_MESH_FRAME_TOO_LARGE", "Frame of ${payload.size} bytes exceeds ${config.maxFrameBytes}")
    }
    val wire = MeshWire.encode(payload)
    val after: Long
    synchronized(c.sendLock) {
      if (c.queuedBytes.get() + wire.size > config.maxQueuedBytes) {
        c.wantWritable = true
        throw MeshException("E_MESH_BACKPRESSURE", "Send queue for $peerId is full")
      }
      c.queue.addLast(ByteBuffer.wrap(wire))
      after = c.queuedBytes.addAndGet(wire.size.toLong())
    }
    c.framesOut.incrementAndGet()
    post { armWrite(c) }
    return after
  }

  /** Takes up to [max] received frames, oldest first. */
  fun takeFrames(max: Int): List<InFrame> {
    val out = ArrayList<InFrame>(minOf(max, 64))
    var resume = false
    while (out.size < max) {
      val f = inbox.poll() ?: break
      out.add(f)
      inboxBytes.addAndGet(-f.data.size.toLong())
      val c = conns[f.peerId]
      if (c != null && c.inboxBytes.addAndGet(-f.data.size.toLong()) <= config.maxInboxBytesPerPeer / 2 && c.inboxPaused) {
        resume = true
      }
    }
    if (inbox.isEmpty()) {
      notifyPending.set(false)
      // A frame that landed between poll() and set(false) must still be announced.
      if (!inbox.isEmpty() && notifyPending.compareAndSet(false, true)) listener.onFramesAvailable()
    }
    if (resume || (inboxBytes.get() <= config.maxInboxBytes / 2 && conns.values.any { it.inboxPaused })) {
      post { resumeInboxPaused() }
    }
    return out
  }

  fun stats(): Map<String, Any?> {
    val peers = conns.values.filter { !it.closed }.map { c ->
      mapOf(
        "peerId" to c.id,
        "dialId" to c.dial?.id,
        "host" to c.ip,
        "port" to c.port,
        "direction" to if (c.outbound) "out" else "in",
        "established" to c.established,
        "queuedBytes" to c.queuedBytes.get().toDouble(),
        "inboxBytes" to c.inboxBytes.get().toDouble(),
        "bytesIn" to c.bytesIn.get().toDouble(),
        "bytesOut" to c.bytesOut.get().toDouble(),
        "framesIn" to c.framesIn.get().toDouble(),
        "framesOut" to c.framesOut.get().toDouble(),
        "keepalivesIn" to c.decoder.keepalives.toDouble(),
        "throttled" to (c.throttledUntil > clock() || c.inboxPaused),
      )
    }
    return mapOf(
      "running" to running.get(),
      "listening" to (running.get() && listeningPort > 0),
      "port" to (if (listeningPort > 0) listeningPort else null),
      "peers" to peers,
      "inboxBytes" to inboxBytes.get().toDouble(),
      "inboxFrames" to inbox.size,
      "activeBans" to activeBans,
      "rejectedConnections" to totalRejected.get().toDouble(),
      "violations" to totalViolations.get().toDouble(),
    )
  }

  /** Whether an address is currently banned (for discovery to skip it). */
  fun isBanned(ip: String): Boolean {
    return bans.isBanned(ip, clock())
  }

  // ── I/O thread ────────────────────────────────────────────────────────────

  private fun requireRunning() {
    if (!running.get()) throw MeshException("E_MESH_NOT_RUNNING", "The mesh is not started")
  }

  private fun post(task: () -> Unit): Boolean {
    if (!running.get()) return false
    tasks.add(task)
    selector?.wakeup()
    return true
  }

  private fun loop() {
    val sel = selector ?: return
    while (running.get()) {
      try {
        sel.select(nextTimeoutMs())
        while (true) {
          val task = tasks.poll() ?: break
          task()
        }
        val keys = sel.selectedKeys().iterator()
        while (keys.hasNext()) {
          val key = keys.next()
          keys.remove()
          try {
            handle(key)
          } catch (_: CancelledKeyException) {
            (key.attachment() as? Conn)?.let { close(it, "io-error", strike = false, allowRetry = true) }
          }
        }
        timers()
      } catch (e: Throwable) {
        // Never let one bad event kill the loop (and with it every connection).
        if (running.get()) listener.onError("E_MESH_INTERNAL", e.toString())
      }
    }
    // Drain stop()'s task.
    while (true) {
      val task = tasks.poll() ?: break
      try { task() } catch (_: Throwable) {}
    }
  }

  private fun handle(key: SelectionKey) {
    if (!key.isValid) return
    if (key.isAcceptable) {
      accept()
      return
    }
    val c = key.attachment() as? Conn ?: return
    if (key.isConnectable) finishConnect(c)
    if (key.isValid && key.isReadable) read(c)
    if (key.isValid && key.isWritable) write(c)
  }

  private fun accept() {
    val srv = server ?: return
    while (true) {
      val ch = try { srv.accept() } catch (e: IOException) { null } ?: return
      val addr = (ch.socket().inetAddress)
      val ip = addr?.hostAddress ?: "?"
      val now = clock()
      val reject = when {
        bans.isBanned(ip, now) -> "banned"
        !acceptRate.admit(ip, now) -> { if (bans.strike(ip, now)) refreshBans(); "rate" }
        conns.size >= config.maxPeers -> "limit"
        conns.values.count { !it.outbound && it.ip == ip } >= config.maxInboundPerIp -> "per-ip"
        conns.values.count { !it.outbound && !it.established } >= config.maxPendingInbound -> "pending"
        else -> null
      }
      if (reject != null) {
        totalRejected.incrementAndGet()
        try { ch.close() } catch (_: IOException) {}
        continue
      }
      try {
        ch.configureBlocking(false)
        ch.setOption(StandardSocketOptions.TCP_NODELAY, true)
        ch.setOption(StandardSocketOptions.SO_KEEPALIVE, true)
        val c = Conn("p" + nextId.incrementAndGet(), ch, outbound = false, dial = null, ip = ip, port = ch.socket().port)
        c.key = ch.register(selector!!, SelectionKey.OP_READ, c)
        conns[c.id] = c
        enqueuePreamble(c)
      } catch (e: IOException) {
        try { ch.close() } catch (_: IOException) {}
      }
    }
  }

  private fun attempt(dial: Dial) {
    if (dial.cancelled || !running.get()) return
    val now = clock()
    val failRetry = { reason: String ->
      scheduleRetry(dial, reason)
    }
    val address = try {
      InetAddress.getByName(dial.host)
    } catch (e: Exception) {
      listener.onError("E_MESH_RESOLVE", "Cannot resolve ${dial.host}")
      failRetry("connect-failed")
      return
    }
    val ip = address.hostAddress ?: dial.host
    if (bans.isBanned(ip, now)) {
      dials.remove(dial.id)
      listener.onDisconnected(null, dial.id, "banned", null)
      return
    }
    if (conns.size >= config.maxPeers) {
      failRetry("limit")
      return
    }
    val ch = try { SocketChannel.open() } catch (e: IOException) { failRetry("connect-failed"); return }
    try {
      ch.configureBlocking(false)
      ch.setOption(StandardSocketOptions.TCP_NODELAY, true)
      ch.setOption(StandardSocketOptions.SO_KEEPALIVE, true)
      socketBinder?.invoke(ch, address)
      val c = Conn("p" + nextId.incrementAndGet(), ch, outbound = true, dial = dial, ip = ip, port = dial.port)
      dial.conn = c
      conns[c.id] = c
      if (ch.connect(InetSocketAddress(address, dial.port))) {
        c.key = ch.register(selector!!, SelectionKey.OP_READ, c)
        c.connecting = false
        enqueuePreamble(c)
      } else {
        c.key = ch.register(selector!!, SelectionKey.OP_CONNECT, c)
      }
    } catch (e: IOException) {
      dial.conn?.let { conns.remove(it.id) }
      dial.conn = null
      try { ch.close() } catch (_: IOException) {}
      failRetry("connect-failed")
    }
  }

  private fun finishConnect(c: Conn) {
    try {
      if (c.channel.finishConnect()) {
        c.connecting = false
        c.lastRecv = clock()
        c.key?.interestOps(SelectionKey.OP_READ)
        enqueuePreamble(c)
      }
    } catch (e: IOException) {
      close(c, "connect-failed", strike = false, allowRetry = true)
    }
  }

  private fun enqueuePreamble(c: Conn) {
    val p = MeshWire.preamble()
    synchronized(c.sendLock) {
      c.queue.addFirst(ByteBuffer.wrap(p))
      c.queuedBytes.addAndGet(p.size.toLong())
    }
    armWrite(c)
  }

  private fun read(c: Conn) {
    if (c.closed) return
    val now = clock()
    val frames = ArrayList<ByteArray>()
    var total = 0
    var pending = 0L
    // A few reads per wakeup, so one fast peer cannot starve the others.
    for (round in 0 until 4) {
      readBuffer.clear()
      val n = try { c.channel.read(readBuffer) } catch (e: IOException) { -2 }
      if (n == -1) { close(c, "remote-closed", strike = false, allowRetry = true); break }
      if (n == -2) { close(c, "io-error", strike = false, allowRetry = true); break }
      if (n == 0) break
      readBuffer.flip()
      readBuffer.get(readArray, 0, n)
      total += n
      val framesBefore = frames.size
      val keepalivesBefore = c.decoder.keepalives
      val status = c.decoder.feed(readArray, 0, n, frames)
      if (status != DecodeStatus.OK) {
        violation(c, status)
        return
      }
      if (!c.established && c.decoder.preambleDone) establish(c)
      // Keepalives count against the frame rate too.
      val count = frames.size - framesBefore + (c.decoder.keepalives - keepalivesBefore)
      c.bytesBucket.charge(n.toDouble(), now)
      c.framesBucket.charge(count.toDouble(), now)
      // Stop this round as soon as the peer is over its rate, or the socket is drained.
      if (c.bytesBucket.waitMs(now) > 0 || c.framesBucket.waitMs(now) > 0) break
      if (n < readArray.size) break
      // Or once what this wakeup decoded fills the inbox: deliver() pauses the
      // peer, and no further read may land past the bound (it used to read up
      // to 4 × 64 KB more first: "receiver inbox bounded" flaked on CI).
      pending += frames.subList(framesBefore, frames.size).sumOf { it.size.toLong() }
      if (c.inboxBytes.get() + pending > config.maxInboxBytesPerPeer ||
        inboxBytes.get() + pending > config.maxInboxBytes) break
    }
    if (total > 0) {
      c.lastRecv = now
      c.bytesIn.addAndGet(total.toLong())
    }
    if (frames.isNotEmpty() && !c.closed) deliver(c, frames)
    if (c.closed) return
    val wait = maxOf(c.bytesBucket.waitMs(now), c.framesBucket.waitMs(now))
    if (wait > 0) {
      c.throttledUntil = now + wait
      updateInterest(c)
    }
  }

  private fun deliver(c: Conn, frames: List<ByteArray>) {
    var size = 0L
    for (f in frames) {
      inbox.add(InFrame(c.id, f))
      size += f.size
    }
    c.framesIn.addAndGet(frames.size.toLong())
    c.inboxBytes.addAndGet(size)
    inboxBytes.addAndGet(size)
    if (notifyPending.compareAndSet(false, true)) listener.onFramesAvailable()
    if (c.inboxBytes.get() > config.maxInboxBytesPerPeer || inboxBytes.get() > config.maxInboxBytes) {
      // JS is not keeping up: stop reading this peer until it does. TCP's
      // window then pushes back on the sender; nothing piles up here.
      c.inboxPaused = true
      updateInterest(c)
    }
  }

  private fun resumeInboxPaused() {
    if (inboxBytes.get() > config.maxInboxBytes / 2) return
    for (c in conns.values) {
      if (c.inboxPaused && c.inboxBytes.get() <= config.maxInboxBytesPerPeer / 2) {
        c.inboxPaused = false
        c.lastRecv = clock()
        updateInterest(c)
      }
    }
  }

  private fun write(c: Conn) {
    if (c.closed) return
    var wrote = 0L
    var drained: Boolean
    try {
      synchronized(c.sendLock) {
        while (c.queue.isNotEmpty()) {
          val buf = c.queue.first()
          val n = c.channel.write(buf)
          wrote += n
          if (buf.hasRemaining()) break
          c.queue.removeFirst()
        }
        drained = c.queue.isEmpty()
        c.queuedBytes.addAndGet(-wrote)
      }
    } catch (e: IOException) {
      close(c, "io-error", strike = false, allowRetry = true)
      return
    }
    if (wrote > 0) {
      c.bytesOut.addAndGet(wrote)
      c.lastSend = clock()
    }
    if (c.wantWritable && c.queuedBytes.get() <= config.maxQueuedBytes / 4) {
      c.wantWritable = false
      if (c.established) listener.onWritable(c.id)
    }
    if (drained) updateInterest(c)
  }

  private fun armWrite(c: Conn) {
    if (!c.closed) updateInterest(c)
  }

  private fun updateInterest(c: Conn) {
    val key = c.key ?: return
    if (!key.isValid || c.closed) return
    if (c.connecting) {
      key.interestOps(SelectionKey.OP_CONNECT)
      return
    }
    var ops = 0
    val now = clock()
    if (!c.inboxPaused && c.throttledUntil <= now) ops = ops or SelectionKey.OP_READ
    if (c.queuedBytes.get() > 0) ops = ops or SelectionKey.OP_WRITE
    key.interestOps(ops)
  }

  private fun establish(c: Conn) {
    c.established = true
    c.establishedAt = clock()
    c.dial?.let { if (it.conn === c) it.retryAt = 0 }
    listener.onConnected(
      mapOf(
        "peerId" to c.id,
        "dialId" to c.dial?.id,
        "host" to c.ip,
        "port" to c.port,
        "direction" to if (c.outbound) "out" else "in",
      ),
    )
  }

  private fun violation(c: Conn, status: DecodeStatus) {
    totalViolations.incrementAndGet()
    val reason = when (status) {
      DecodeStatus.BAD_MAGIC -> "bad-magic"
      DecodeStatus.INCOMPATIBLE -> "incompatible"
      DecodeStatus.OVERSIZE -> "oversize"
      DecodeStatus.OK -> "io-error"
    }
    // A newer app version is not an attacker: close without a strike.
    close(c, reason, strike = status != DecodeStatus.INCOMPATIBLE, allowRetry = false)
  }

  private fun close(c: Conn, reason: String, strike: Boolean, allowRetry: Boolean) {
    if (c.closed) return
    c.closed = true
    conns.remove(c.id)
    try { c.key?.cancel() } catch (_: Throwable) {}
    try { c.channel.close() } catch (_: IOException) {}
    synchronized(c.sendLock) {
      c.queue.clear()
      c.queuedBytes.set(0)
    }
    if (strike && bans.strike(c.ip, clock())) refreshBans()
    val dial = c.dial
    var retryIn: Long? = null
    if (dial != null && dial.conn === c) {
      dial.conn = null
      if (allowRetry && dial.reconnect && !dial.cancelled && running.get()) {
        if (c.established && clock() - c.establishedAt >= Backoff.STABLE_MS) dial.attempt = 0
        retryIn = scheduleRetry(dial, null)
      } else {
        dials.remove(dial.id)
      }
    }
    // A connection that never finished its preamble was never announced.
    if (c.established) {
      listener.onDisconnected(c.id, dial?.id, reason, retryIn)
    } else if (dial != null) {
      listener.onDisconnected(null, dial.id, reason, retryIn)
    }
  }

  /** Returns the delay, or null when the dial gave up. */
  private fun scheduleRetry(dial: Dial, reportReason: String?): Long? {
    if (!dial.reconnect || dial.cancelled || !running.get()) {
      dials.remove(dial.id)
      if (reportReason != null) listener.onDisconnected(null, dial.id, reportReason, null)
      return null
    }
    val delay = Backoff.delayMs(dial.attempt, random.nextDouble())
    dial.attempt++
    dial.retryAt = clock() + delay
    if (reportReason != null) listener.onDisconnected(null, dial.id, reportReason, delay)
    return delay
  }

  private fun refreshBans() {
    activeBans = bans.activeCount(clock())
  }

  private fun timers() {
    val now = clock()
    for (c in conns.values.toList()) {
      if (c.closed) continue
      if (c.connecting) {
        if (now - c.created > config.connectTimeoutMs) close(c, "connect-timeout", strike = false, allowRetry = true)
        continue
      }
      if (!c.established) {
        if (now - c.created > config.handshakeTimeoutMs) {
          // An inbound socket that never says hello is a probe or a slowloris.
          close(c, "handshake-timeout", strike = !c.outbound, allowRetry = true)
        }
        continue
      }
      if (c.throttledUntil in 1..now) {
        c.throttledUntil = 0
        c.lastRecv = now
        updateInterest(c)
      }
      val reading = !c.inboxPaused && c.throttledUntil == 0L
      if (reading && now - c.lastRecv > config.idleTimeoutMs) {
        close(c, "idle", strike = false, allowRetry = true)
        continue
      }
      if (now - c.lastSend > config.keepaliveMs && c.queuedBytes.get() == 0L) {
        val k = MeshWire.keepalive()
        synchronized(c.sendLock) {
          c.queue.addLast(ByteBuffer.wrap(k))
          c.queuedBytes.addAndGet(k.size.toLong())
        }
        c.lastSend = now
        updateInterest(c)
      }
    }
    for (dial in dials.values.toList()) {
      if (dial.conn == null && !dial.cancelled && dial.retryAt in 1..now) {
        dial.retryAt = 0
        attempt(dial)
      }
    }
    refreshBans()
  }

  private fun nextTimeoutMs(): Long {
    val now = clock()
    var next = 1_000L
    for (c in conns.values) {
      if (c.throttledUntil > now) next = minOf(next, c.throttledUntil - now)
    }
    for (d in dials.values) {
      if (d.retryAt > now) next = minOf(next, d.retryAt - now)
      else if (d.retryAt > 0) next = 1
    }
    return next.coerceIn(1, 1_000)
  }
}
