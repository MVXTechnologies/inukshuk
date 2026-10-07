package expo.modules.inukshukgnss.core

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

// Plain JVM (java.net / javax.net.ssl only): android/tests/run.sh runs it
// against a local echo server.

/**
 * A raw TCP (optionally TLS) byte pipe for NTRIP casters. NTRIP 1.0 answers
 * `ICY 200 OK`, which is not HTTP, and both versions stream for hours, so
 * neither fetch nor WebSocket can carry it. The protocol (request, response
 * parsing, GGA upload) stays in TypeScript (@core/gnss/ntrip); this moves
 * bytes only.
 *
 * - **Connect timeout** [connectTimeoutMs]; **read timeout** [readTimeoutMs]
 *   (a caster silent that long is treated as gone).
 * - **Backpressure**: received bytes wait in a buffer of [maxBuffered] bytes
 *   and leave as at most one [Listener.onData] per [flushIntervalMs]. When
 *   the buffer is full (nobody listening), the reader STOPS reading, so TCP
 *   flow control pushes back on the caster instead of bytes being dropped.
 * - **TLS** verifies the certificate chain (platform trust store) AND the
 *   host name (`endpointIdentificationAlgorithm = HTTPS`; a bare
 *   SSLSocketFactory socket would not check it).
 * - Cleartext: a raw socket is not subject to Android's network-security
 *   cleartext policy (that governs HTTP stacks), so NTRIP v1 on port 2101
 *   works without loosening the app-wide config.
 *
 * [Listener.onClose] fires exactly once for a pipe that opened, never after
 * [close].
 */
class TcpPipe(
  private val host: String,
  private val port: Int,
  private val tls: Boolean,
  private val listener: Listener,
  private val connectTimeoutMs: Int = 15_000,
  private val readTimeoutMs: Int = 60_000,
  maxBuffered: Int = 256 * 1024,
  private val flushIntervalMs: Long = 100,
  private val maxEventBytes: Int = 64 * 1024,
) {
  interface Listener {
    fun onData(data: ByteArray)

    /** null: the caster closed normally; else why the pipe failed. */
    fun onClose(error: String?)
  }

  private val lock = Object()
  private val ring = ByteRing(maxBuffered)
  private var endReason: String? = null
  private var ended = false
  private var listening = false

  @Volatile private var socket: Socket? = null
  private val closed = AtomicBoolean(false)
  private val reported = AtomicBoolean(false)
  private val pendingWrite = AtomicInteger(0)
  private val writer: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "inukshuk-tcp-write") }
  private val flusher: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "inukshuk-tcp-flush") }

  /** [done] runs once: null when connected (and reading), else the error. */
  fun open(done: (String?) -> Unit) {
    Thread({ run(done) }, "inukshuk-tcp-read").start()
  }

  fun setListening(on: Boolean) {
    synchronized(lock) { listening = on }
  }

  private fun run(done: (String?) -> Unit) {
    val s: Socket
    try {
      s = connect()
    } catch (e: Exception) {
      shutdown()
      done(describe(e, "connect"))
      return
    }
    if (closed.get()) {
      closeQuietly(s)
      done("closed")
      return
    }
    flusher.scheduleWithFixedDelay({ flush() }, flushIntervalMs, flushIntervalMs, TimeUnit.MILLISECONDS)
    done(null)
    // Never read more than the buffer can ever hold, or the wait below
    // could not end.
    val buf = ByteArray(minOf(16 * 1024, ring.capacity))
    var reason: String? = null
    try {
      val input = s.getInputStream()
      while (!closed.get()) {
        val n = input.read(buf)
        if (n < 0) break
        if (n == 0) continue
        synchronized(lock) {
          // Backpressure: wait for the flusher rather than drop bytes.
          while (ring.size + n > ring.capacity && !closed.get()) lock.wait(250)
          if (!closed.get()) ring.append(buf, 0, n)
        }
      }
    } catch (e: Exception) {
      if (!closed.get()) reason = describe(e, "read")
    }
    synchronized(lock) {
      ended = true
      endReason = reason
    }
  }

  private fun connect(): Socket {
    val plain = Socket()
    socket = plain
    plain.connect(InetSocketAddress(host, port), connectTimeoutMs)
    plain.soTimeout = readTimeoutMs
    plain.tcpNoDelay = true
    if (!tls) return plain
    val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(plain, host, port, true) as SSLSocket
    socket = ssl
    val params = ssl.sslParameters
    params.endpointIdentificationAlgorithm = "HTTPS"
    ssl.sslParameters = params
    ssl.soTimeout = readTimeoutMs
    ssl.startHandshake()
    return ssl
  }

  /** Emits buffered bytes (when listening) and finishes an ended stream. */
  private fun flush() {
    while (true) {
      val chunk: ByteArray
      var finish = false
      var reason: String? = null
      synchronized(lock) {
        if (listening && ring.size > 0) {
          chunk = ring.take(maxEventBytes)
          lock.notifyAll()
        } else {
          chunk = ByteArray(0)
          // An ended stream finishes once delivered — or at once when no one
          // listens (the bytes would wait for nobody).
          if (ended && (ring.size == 0 || !listening)) {
            finish = true
            reason = endReason
          }
        }
      }
      if (chunk.isNotEmpty()) {
        if (!closed.get()) listener.onData(chunk)
        continue
      }
      if (finish) finish(reason)
      return
    }
  }

  private fun finish(reason: String?) {
    if (closed.get()) return
    shutdown()
    if (reported.compareAndSet(false, true)) listener.onClose(reason)
  }

  /** Writes [data]; [done] gets null or the error. At most [maxPendingWrite] queued. */
  fun write(data: ByteArray, done: (String?) -> Unit) {
    if (closed.get()) return done("closed")
    if (pendingWrite.get() + data.size > MAX_PENDING_WRITE) return done("write buffer full")
    pendingWrite.addAndGet(data.size)
    try {
      writer.execute {
        try {
          val s = socket ?: throw IOException("not connected")
          s.getOutputStream().write(data)
          s.getOutputStream().flush()
          done(null)
        } catch (e: Exception) {
          done(describe(e, "write"))
        } finally {
          pendingWrite.addAndGet(-data.size)
        }
      }
    } catch (e: RejectedExecutionException) {
      pendingWrite.addAndGet(-data.size)
      done("closed")
    }
  }

  /** Closes without reporting [Listener.onClose]. Idempotent. */
  fun close() {
    reported.set(true)
    shutdown()
  }

  private fun shutdown() {
    if (!closed.compareAndSet(false, true)) return
    closeQuietly(socket)
    synchronized(lock) { lock.notifyAll() }
    writer.shutdownNow()
    flusher.shutdownNow()
  }

  private fun describe(e: Exception, stage: String): String =
    when (e) {
      is SocketTimeoutException -> if (stage == "connect") "connect timed out" else "the caster stopped sending"
      else -> "$stage failed: ${e.message ?: e.javaClass.simpleName}"
    }

  companion object {
    const val MAX_PENDING_WRITE = 64 * 1024

    private fun closeQuietly(s: Socket?) {
      try {
        s?.close()
      } catch (_: IOException) {
      }
    }
  }
}
