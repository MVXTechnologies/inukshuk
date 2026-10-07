package expo.modules.inukshukgnss

import android.os.Handler
import expo.modules.inukshukgnss.core.FrameCursor
import expo.modules.inukshukgnss.core.GattProfile

/** Error codes are part of the JS contract (src/lib/gnss/nativeGnss.ts). */
internal class GnssException(
  val code: String,
  message: String,
  /** Retrying cannot help (not bonded, no serial service, no permission). */
  val fatal: Boolean = false,
  cause: Throwable? = null,
) : Exception(message, cause)

/** What an opened link offers. `mtu` is the negotiated ATT MTU (BLE only). */
internal data class LinkInfo(val mtu: Int?, val profile: String?, val writable: Boolean)

/** Callbacks from a transport; any thread. The session re-posts to its own. */
internal interface TransportListener {
  fun onOpened(info: LinkInfo)

  /** [data] belongs to the session from here on (transports pass a copy). */
  fun onBytes(data: ByteArray)

  fun onRssi(rssi: Int)

  /** Unrequested close. A requested [Transport.close] reports nothing. */
  fun onClosed(error: GnssException)
}

/**
 * One byte link to one receiver. The session calls every method on its own
 * I/O thread. Implementations: Bluetooth Classic SPP ([SppTransport]), BLE
 * GATT ([BleTransport]) and the test-only [FakeTransport]. TCP (Wi-Fi
 * receivers, P1 in the research) slots in here as another implementation.
 */
internal interface Transport {
  fun open()

  fun close()

  /** [done] runs once, on any thread, when the bytes left the phone or failed. */
  fun write(data: ByteArray, done: (GnssException?) -> Unit)
}

/** Where a connect() wants to go; parsed and validated from the JS options. */
internal data class LinkTarget(
  val deviceId: String,
  val transport: String,
  val profiles: List<GattProfile>,
  val autoReconnect: Boolean,
  val mtu: Int,
  val fakeFrames: List<ByteArray>,
  val fakeIntervalMs: Long,
  val fakeLoop: Boolean,
)

internal const val TRANSPORT_BLE = "ble"
internal const val TRANSPORT_SPP = "spp"
internal const val TRANSPORT_FAKE = "fake"

/** Writes queued but not yet sent; beyond this a write is refused. */
internal const val MAX_PENDING_WRITE_BYTES = 64 * 1024

/**
 * Test-only receiver: replays frames handed over by JS (an NMEA recording,
 * split per epoch) at a fixed interval through the SAME session, event and
 * buffering path as a real link. Only reachable when [GnssSession.fakeAllowed].
 */
internal class FakeTransport(
  frames: List<ByteArray>,
  private val intervalMs: Long,
  loop: Boolean,
  private val listener: TransportListener,
  private val io: Handler,
) : Transport {
  private val cursor = FrameCursor(frames, loop)
  private var closed = false

  private val tick = object : Runnable {
    override fun run() {
      if (closed) return
      val frame = cursor.next()
      if (frame == null) {
        closed = true
        listener.onClosed(
          GnssException("E_GNSS_FAKE_ENDED", "The simulated receiver reached the end of its recording", fatal = true),
        )
        return
      }
      listener.onBytes(frame.copyOf())
      io.postDelayed(this, intervalMs)
    }
  }

  private val start = Runnable {
    if (!closed) {
      listener.onOpened(LinkInfo(mtu = null, profile = "fake", writable = true))
      io.post(tick)
    }
  }

  override fun open() {
    // A short delay so the UI sees `connecting` before `connected`, as with
    // real hardware.
    io.postDelayed(start, 250)
  }

  override fun close() {
    closed = true
    io.removeCallbacks(start)
    io.removeCallbacks(tick)
  }

  override fun write(data: ByteArray, done: (GnssException?) -> Unit) {
    // Accepted and discarded: lets the NTRIP → receiver path run end to end.
    done(if (closed) GnssException("E_GNSS_NOT_CONNECTED", "The simulated receiver is closed") else null)
  }
}
