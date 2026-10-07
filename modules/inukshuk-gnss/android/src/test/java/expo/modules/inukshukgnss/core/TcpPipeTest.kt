package expo.modules.inukshukgnss.core

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

// Framework-free (plain main) like LinkCoreTest; a local echo server stands
// in for an NTRIP caster.

private var failures = 0
private var checks = 0

private fun check(name: String, condition: Boolean) {
  checks += 1
  if (!condition) {
    failures += 1
    System.err.println("FAIL: $name")
  }
}

private class Recorder : TcpPipe.Listener {
  val data = ByteArrayOutputStream()
  var events = 0
  var maxEvent = 0
  val closed = CountDownLatch(1)

  @Volatile var closeError: String? = "not closed"

  override fun onData(data: ByteArray) {
    synchronized(this) {
      this.data.write(data)
      events += 1
      maxEvent = maxOf(maxEvent, data.size)
    }
  }

  override fun onClose(error: String?) {
    closeError = error
    closed.countDown()
  }

  fun text() = synchronized(this) { data.toString(Charsets.US_ASCII) }
}

private fun openSync(pipe: TcpPipe): String? {
  val latch = CountDownLatch(1)
  var result: String? = "pending"
  pipe.open {
    result = it
    latch.countDown()
  }
  latch.await(10, TimeUnit.SECONDS)
  return result
}

private fun writeSync(pipe: TcpPipe, bytes: ByteArray): String? {
  val latch = CountDownLatch(1)
  var result: String? = "pending"
  pipe.write(bytes) {
    result = it
    latch.countDown()
  }
  latch.await(10, TimeUnit.SECONDS)
  return result
}

private fun waitFor(timeoutMs: Long, cond: () -> Boolean): Boolean {
  val end = System.currentTimeMillis() + timeoutMs
  while (System.currentTimeMillis() < end) {
    if (cond()) return true
    Thread.sleep(10)
  }
  return cond()
}

/** Echo server: echoes everything; "BYE" makes it close the connection. */
private fun echoServer(): ServerSocket {
  val server = ServerSocket(0, 5, InetAddress.getLoopbackAddress())
  thread(isDaemon = true) {
    while (!server.isClosed) {
      val s = try { server.accept() } catch (_: Exception) { break }
      thread(isDaemon = true) {
        s.use {
          val buf = ByteArray(4096)
          val input = it.getInputStream()
          val out = it.getOutputStream()
          while (true) {
            val n = try { input.read(buf) } catch (_: Exception) { -1 }
            if (n < 0) break
            val text = String(buf, 0, n, Charsets.US_ASCII)
            if (text.contains("BYE")) break
            out.write(buf, 0, n)
            out.flush()
          }
        }
      }
    }
  }
  return server
}

private fun echoTest(server: ServerSocket) {
  val rec = Recorder()
  val pipe = TcpPipe("127.0.0.1", server.localPort, false, rec, flushIntervalMs = 20)
  pipe.setListening(true)
  check("connects", openSync(pipe) == null)
  check("writes", writeSync(pipe, "GET / HTTP/1.0\r\n\r\n".toByteArray()) == null)
  check("echo arrives", waitFor(3_000) { rec.text() == "GET / HTTP/1.0\r\n\r\n" })
  // The remote close is reported once, as a normal end.
  writeSync(pipe, "BYE".toByteArray())
  check("remote close reported", rec.closed.await(3, TimeUnit.SECONDS) && rec.closeError == null)
  check("write after close fails", writeSync(pipe, "x".toByteArray()) != null)
}

private fun chunkingTest(server: ServerSocket) {
  val rec = Recorder()
  // Small event cap: a large echo must arrive in several bounded events.
  val pipe = TcpPipe("127.0.0.1", server.localPort, false, rec, flushIntervalMs = 20, maxEventBytes = 1024)
  pipe.setListening(true)
  check("chunk: connects", openSync(pipe) == null)
  val payload = ByteArray(20_000) { ('a'.code + it % 26).toByte() }
  check("chunk: writes", writeSync(pipe, payload) == null)
  check("chunk: all bytes", waitFor(5_000) { rec.text().length == payload.size })
  check("chunk: in order", rec.text() == String(payload, Charsets.US_ASCII))
  check("chunk: events bounded", rec.maxEvent <= 1024 && rec.events >= 20)
  pipe.close()
  check("chunk: no close event after close()", !rec.closed.await(300, TimeUnit.MILLISECONDS))
}

private fun backpressureTest(server: ServerSocket) {
  val rec = Recorder()
  val pipe = TcpPipe("127.0.0.1", server.localPort, false, rec, maxBuffered = 4096, flushIntervalMs = 20)
  // Not listening: bytes wait (reader blocks at 4 KiB, TCP pushes back).
  check("bp: connects", openSync(pipe) == null)
  val payload = ByteArray(64_000) { (it % 251).toByte() }
  writeSync(pipe, payload)
  Thread.sleep(300)
  check("bp: nothing delivered while not listening", rec.events == 0)
  pipe.setListening(true)
  val delivered = waitFor(5_000) { rec.data.size() == payload.size }
  if (!delivered) System.err.println("bp: got ${rec.data.size()} of ${payload.size}, closed=${rec.closeError}")
  check("bp: everything delivered once listening", delivered)
  check("bp: nothing lost or reordered", rec.data.toByteArray().contentEquals(payload))
  pipe.close()
}

private fun failureTests() {
  // A port with nothing listening.
  val probe = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
  val port = probe.localPort
  probe.close()
  val rec = Recorder()
  val err = openSync(TcpPipe("127.0.0.1", port, false, rec))
  check("refused connect reports an error", err != null && err.startsWith("connect failed"))

  // TLS to a plain-TCP server: the handshake fails cleanly.
  val plain = echoServer()
  val tlsErr = openSync(TcpPipe("127.0.0.1", plain.localPort, true, Recorder(), connectTimeoutMs = 3_000, readTimeoutMs = 2_000))
  check("tls to a plain server fails", tlsErr != null)
  plain.close()

  // Read timeout: a server that accepts and stays silent.
  val silent = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
  thread(isDaemon = true) { try { silent.accept() } catch (_: Exception) {} }
  val r2 = Recorder()
  val p2 = TcpPipe("127.0.0.1", silent.localPort, false, r2, readTimeoutMs = 300, flushIntervalMs = 20)
  p2.setListening(true)
  check("silent: connects", openSync(p2) == null)
  check("silent: times out", r2.closed.await(3, TimeUnit.SECONDS) && r2.closeError == "the caster stopped sending")
  silent.close()

  // Writes beyond the pending cap are refused, never queued unbounded.
  val big = TcpPipe("127.0.0.1", 9, false, Recorder())
  check("write before open is refused", writeSync(big, ByteArray(TcpPipe.MAX_PENDING_WRITE + 1)) != null)
}

fun main() {
  val server = echoServer()
  echoTest(server)
  chunkingTest(server)
  backpressureTest(server)
  failureTests()
  server.close()
  if (failures > 0) {
    System.err.println("$failures of $checks TCP checks failed")
    kotlin.system.exitProcess(1)
  }
  println("inukshuk-gnss TCP pipe: $checks checks passed")
  kotlin.system.exitProcess(0)
}
