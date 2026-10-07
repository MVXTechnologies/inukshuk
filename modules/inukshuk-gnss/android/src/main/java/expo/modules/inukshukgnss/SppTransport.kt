package expo.modules.inukshukgnss

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger

/** Serial Port Profile service class (Bluetooth SIG assigned number 0x1101). */
internal val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

/**
 * Bluetooth Classic SPP (RFCOMM) to a BONDED receiver: Garmin GLO 2, Bad Elf,
 * Emlid Reach RX, Trimble, Eos, Geode. Pairing happens in Android's Bluetooth
 * settings; we never discover or bond classic devices ourselves (that would
 * need location-derived scanning permissions for no gain).
 *
 * A blocking reader thread per link (RFCOMM has no async API); writes go
 * through a single-thread executor so they never block the reader or the
 * session thread. Every permission-guarded call is caught: a revoked
 * BLUETOOTH_CONNECT surfaces as a fatal E_GNSS_PERMISSION, never a crash.
 */
@SuppressLint("MissingPermission")
internal class SppTransport(
  private val adapter: BluetoothAdapter,
  private val address: String,
  private val listener: TransportListener,
) : Transport {
  @Volatile private var socket: BluetoothSocket? = null

  @Volatile private var closed = false
  private val pendingBytes = AtomicInteger(0)
  private val writer: ExecutorService =
    Executors.newSingleThreadExecutor { r -> Thread(r, "inukshuk-gnss-spp-write") }

  override fun open() {
    Thread({ run() }, "inukshuk-gnss-spp-read").start()
  }

  private fun run() {
    val s: BluetoothSocket
    try {
      s = connect()
    } catch (e: GnssException) {
      if (!closed) listener.onClosed(e)
      return
    } catch (e: SecurityException) {
      if (!closed) listener.onClosed(permissionError(e))
      return
    } catch (e: IOException) {
      if (!closed) {
        listener.onClosed(GnssException("E_GNSS_CONNECT_FAILED", "Could not open the receiver's serial port: ${e.message}", cause = e))
      }
      return
    }
    if (closed) {
      closeQuietly(s)
      return
    }
    listener.onOpened(LinkInfo(mtu = null, profile = "spp", writable = true))
    val buffer = ByteArray(4096)
    try {
      val input = s.inputStream
      while (!closed) {
        val n = input.read(buffer)
        if (n < 0) break
        if (n > 0) listener.onBytes(buffer.copyOf(n))
      }
      if (!closed) listener.onClosed(GnssException("E_GNSS_LINK_LOST", "The receiver closed the connection"))
    } catch (e: IOException) {
      if (!closed) listener.onClosed(GnssException("E_GNSS_LINK_LOST", "Bluetooth link lost: ${e.message}", cause = e))
    } finally {
      closeQuietly(s)
    }
  }

  private fun connect(): BluetoothSocket {
    val device: BluetoothDevice =
      try {
        adapter.getRemoteDevice(address)
      } catch (e: IllegalArgumentException) {
        throw GnssException("E_GNSS_BAD_ARGUMENT", "Not a Bluetooth address: $address", fatal = true, cause = e)
      }
    if (device.bondState != BluetoothDevice.BOND_BONDED) {
      throw GnssException(
        "E_GNSS_NOT_BONDED",
        "Pair the receiver in Android's Bluetooth settings first",
        fatal = true,
      )
    }
    // Discovery slows RFCOMM connects to a crawl. Cancelling it needs
    // BLUETOOTH_SCAN on Android 12+, which the user may not have granted.
    try {
      adapter.cancelDiscovery()
    } catch (_: SecurityException) {
    }
    // Secure (authenticated, encrypted) RFCOMM first; a few older receivers
    // only accept an insecure link.
    val secure = device.createRfcommSocketToServiceRecord(SPP_UUID)
    socket = secure
    try {
      secure.connect()
      return secure
    } catch (first: IOException) {
      closeQuietly(secure)
      if (closed) throw first
    }
    val insecure = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
    socket = insecure
    if (closed) {
      closeQuietly(insecure)
      throw IOException("closed")
    }
    insecure.connect()
    return insecure
  }

  override fun close() {
    closed = true
    // Closing the socket is what unblocks a pending connect() or read().
    closeQuietly(socket)
    writer.shutdownNow()
  }

  override fun write(data: ByteArray, done: (GnssException?) -> Unit) {
    if (pendingBytes.get() + data.size > MAX_PENDING_WRITE_BYTES) {
      done(GnssException("E_GNSS_WRITE_OVERFLOW", "The receiver is not accepting data fast enough"))
      return
    }
    pendingBytes.addAndGet(data.size)
    try {
      writer.execute {
        try {
          val s = socket
          if (s == null || closed) {
            done(GnssException("E_GNSS_NOT_CONNECTED", "The receiver is not connected"))
          } else {
            s.outputStream.write(data)
            s.outputStream.flush()
            done(null)
          }
        } catch (e: IOException) {
          done(GnssException("E_GNSS_WRITE_FAILED", "Write to the receiver failed: ${e.message}", cause = e))
        } finally {
          pendingBytes.addAndGet(-data.size)
        }
      }
    } catch (e: RejectedExecutionException) {
      pendingBytes.addAndGet(-data.size)
      done(GnssException("E_GNSS_NOT_CONNECTED", "The receiver is not connected", cause = e))
    }
  }
}

internal fun permissionError(e: SecurityException) =
  GnssException("E_GNSS_PERMISSION", "Bluetooth permission missing: ${e.message}", fatal = true, cause = e)

private fun closeQuietly(s: BluetoothSocket?) {
  try {
    s?.close()
  } catch (_: IOException) {
  }
}
