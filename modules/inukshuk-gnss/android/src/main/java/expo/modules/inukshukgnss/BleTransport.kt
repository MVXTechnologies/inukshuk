package expo.modules.inukshukgnss

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.os.Build
import android.os.Handler
import expo.modules.inukshukgnss.core.CharCaps
import expo.modules.inukshukgnss.core.GattProfile
import expo.modules.inukshukgnss.core.ProfileChoice
import expo.modules.inukshukgnss.core.selectProfile
import expo.modules.inukshukgnss.core.splitForWrite
import java.util.UUID

/** Client Characteristic Configuration descriptor (notifications on/off). */
private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
private const val RSSI_INTERVAL_MS = 5_000L
private const val WRITE_STALL_MS = 5_000L
private const val WRITE_BUSY_RETRY_MS = 20L
private const val WRITE_BUSY_MAX_RETRIES = 50

/**
 * BLE serial link: connect → request MTU → discover services → pick the first
 * matching [GattProfile] → enable notifications → stream.
 *
 * Android allows ONE outstanding GATT operation per connection, so setup is a
 * strict chain and writes are a queue that advances only on
 * onCharacteristicWrite (also for write-without-response, where Android uses
 * that callback for local flow control). All state lives on the session's I/O
 * thread; GATT callbacks arrive on binder threads and are re-posted.
 *
 * Both the API 33+ and the older (deprecated) GATT signatures are handled:
 * minSdk is 26.
 */
@SuppressLint("MissingPermission")
internal class BleTransport(
  private val context: Context,
  private val device: BluetoothDevice,
  private val profiles: List<GattProfile>,
  private val requestedMtu: Int,
  private val listener: TransportListener,
  private val io: Handler,
) : Transport {
  private class PendingWrite(
    val payload: Int,
    val bytes: ByteArray,
    val last: Boolean,
    val done: ((GnssException?) -> Unit)?,
    var retries: Int = 0,
  )

  private var gatt: BluetoothGatt? = null
  private var closed = false
  private var opened = false
  private var mtu = 23
  private var choice: ProfileChoice? = null
  // Read on binder threads by deliver(); written once during setup.
  @Volatile private var notifyChar: BluetoothGattCharacteristic? = null
  private var writeChar: BluetoothGattCharacteristic? = null
  private var writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
  private val writes = ArrayDeque<PendingWrite>()
  private var inFlight: PendingWrite? = null
  private var nextPayload = 0

  private val rssiTick = object : Runnable {
    override fun run() {
      if (closed || !opened) return
      // Skip a tick rather than interleave with a write.
      if (inFlight == null) guard { gatt?.readRemoteRssi() }
      io.postDelayed(this, RSSI_INTERVAL_MS)
    }
  }

  private val writeStall = Runnable {
    fail(GnssException("E_GNSS_WRITE_STALLED", "The receiver stopped acknowledging writes"))
  }

  private val pumpLater = Runnable { pump() }

  private val callback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
      io.post { onConnectionState(status, newState) }
    }

    override fun onMtuChanged(g: BluetoothGatt, value: Int, status: Int) {
      io.post {
        if (status == BluetoothGatt.GATT_SUCCESS) mtu = value
        discover()
      }
    }

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
      io.post { onServices(status) }
    }

    override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
      io.post {
        if (closed || opened) return@post
        if (status == BluetoothGatt.GATT_SUCCESS) {
          markOpened()
        } else {
          fail(GnssException("E_GNSS_NOTIFY_FAILED", "The receiver refused notifications (status $status)"))
        }
      }
    }

    // API 33+: the value comes as an argument (the characteristic's own
    // value field is no longer updated).
    override fun onCharacteristicChanged(
      g: BluetoothGatt,
      c: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      deliver(c, value)
    }

    // API 26–32. Not called on 33+ because the 3-argument override above
    // replaces the default that would forward here.
    @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
    override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
      val v = c.value ?: return
      deliver(c, v)
    }

    override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
      io.post { onWriteDone(status) }
    }

    override fun onReadRemoteRssi(g: BluetoothGatt, rssi: Int, status: Int) {
      if (status == BluetoothGatt.GATT_SUCCESS) listener.onRssi(rssi)
    }
  }

  private fun deliver(c: BluetoothGattCharacteristic, value: ByteArray) {
    // Only the profile's output characteristic carries receiver data.
    if (value.isEmpty() || c.uuid != notifyChar?.uuid) return
    listener.onBytes(value.copyOf())
  }

  override fun open() {
    guard {
      gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
      if (gatt == null) fail(GnssException("E_GNSS_CONNECT_FAILED", "Android refused to open a BLE connection"))
    }
  }

  private fun onConnectionState(status: Int, newState: Int) {
    if (closed) return
    if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
      // A larger MTU means fewer packets for RTCM corrections. Android caps
      // the request at 517; the receiver answers with what it supports.
      guard { if (gatt?.requestMtu(requestedMtu) != true) discover() }
    } else {
      // 133 (GATT_ERROR) is Android's catch-all for "could not connect" or
      // "connection dropped"; the session's backoff handles both.
      val code = if (opened) "E_GNSS_LINK_LOST" else "E_GNSS_CONNECT_FAILED"
      fail(GnssException(code, "Bluetooth LE link closed (status $status)"))
    }
  }

  private fun discover() {
    if (closed) return
    guard {
      if (gatt?.discoverServices() != true) {
        fail(GnssException("E_GNSS_CONNECT_FAILED", "Service discovery could not start"))
      }
    }
  }

  private fun onServices(status: Int) {
    if (closed) return
    val g = gatt ?: return
    if (status != BluetoothGatt.GATT_SUCCESS) {
      fail(GnssException("E_GNSS_CONNECT_FAILED", "Service discovery failed (status $status)"))
      return
    }
    val found = g.services.associate { svc ->
      svc.uuid.toString().lowercase() to
        svc.characteristics.associate { ch ->
          val p = ch.properties
          ch.uuid.toString().lowercase() to
            CharCaps(
              canNotify = p and (BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0,
              canWrite = p and (BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0,
            )
        }
    }
    val picked = selectProfile(profiles, found)
    if (picked == null) {
      // Retrying cannot conjure a service: fatal, and the message lists what
      // the device does offer so a new profile can be added from a report.
      fail(
        GnssException(
          "E_GNSS_NO_SERIAL_SERVICE",
          "No known serial service on this device. Services: ${found.keys.sorted().joinToString()}",
          fatal = true,
        ),
      )
      return
    }
    choice = picked
    val svc = g.getService(UUID.fromString(picked.profile.service))
    val out = svc?.getCharacteristic(UUID.fromString(picked.profile.notify))
    if (out == null) {
      fail(GnssException("E_GNSS_CONNECT_FAILED", "The serial characteristic vanished during setup"))
      return
    }
    notifyChar = out
    if (picked.writable) {
      val w = svc.getCharacteristic(UUID.fromString(picked.profile.write))
      writeChar = w
      writeType =
        if (w != null && w.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) {
          BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        } else {
          BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }
    }
    enableNotifications(g, out)
  }

  private fun enableNotifications(g: BluetoothGatt, out: BluetoothGattCharacteristic) {
    guard {
      if (!g.setCharacteristicNotification(out, true)) {
        fail(GnssException("E_GNSS_NOTIFY_FAILED", "Could not subscribe to the receiver's output"))
        return@guard
      }
      val cccd = out.getDescriptor(CCCD)
      if (cccd == null) {
        // Some ESP32 firmwares omit the CCCD and notify unconditionally.
        markOpened()
        return@guard
      }
      val value =
        if (out.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) {
          BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        } else {
          BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        }
      val started =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          g.writeDescriptor(cccd, value) == BluetoothStatusCodes.SUCCESS
        } else {
          @Suppress("DEPRECATION")
          cccd.value = value
          @Suppress("DEPRECATION")
          g.writeDescriptor(cccd)
        }
      if (!started) fail(GnssException("E_GNSS_NOTIFY_FAILED", "Could not subscribe to the receiver's output"))
    }
  }

  private fun markOpened() {
    if (closed || opened) return
    opened = true
    val c = choice
    listener.onOpened(LinkInfo(mtu = mtu, profile = c?.profile?.name, writable = c?.writable == true && writeChar != null))
    io.postDelayed(rssiTick, RSSI_INTERVAL_MS)
  }

  override fun write(data: ByteArray, done: (GnssException?) -> Unit) {
    if (closed || !opened) {
      done(GnssException("E_GNSS_NOT_CONNECTED", "The receiver is not connected"))
      return
    }
    if (writeChar == null) {
      done(GnssException("E_GNSS_NOT_WRITABLE", "This receiver offers no writable serial characteristic"))
      return
    }
    if (data.isEmpty()) {
      done(null)
      return
    }
    val queued = writes.sumOf { it.bytes.size } + (inFlight?.bytes?.size ?: 0)
    if (queued + data.size > MAX_PENDING_WRITE_BYTES) {
      done(GnssException("E_GNSS_WRITE_OVERFLOW", "The receiver is not accepting data fast enough"))
      return
    }
    val payload = nextPayload++
    // ATT header is 3 bytes; never below the BLE 4.0 default of 20.
    val parts = splitForWrite(data, maxOf(20, mtu - 3))
    parts.forEachIndexed { i, part ->
      val last = i == parts.lastIndex
      writes.addLast(PendingWrite(payload, part, last, if (last) done else null))
    }
    pump()
  }

  private fun pump() {
    if (closed || inFlight != null) return
    val next = writes.removeFirstOrNull() ?: return
    val g = gatt
    val ch = writeChar
    if (g == null || ch == null) {
      failPayload(next, GnssException("E_GNSS_NOT_CONNECTED", "The receiver is not connected"))
      return
    }
    inFlight = next
    var started = false
    guard {
      started =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          g.writeCharacteristic(ch, next.bytes, writeType) == BluetoothStatusCodes.SUCCESS
        } else {
          @Suppress("DEPRECATION")
          ch.writeType = writeType
          @Suppress("DEPRECATION")
          ch.value = next.bytes
          @Suppress("DEPRECATION")
          g.writeCharacteristic(ch)
        }
    }
    if (closed) return
    if (!started) {
      // The stack is busy (another operation still completing): retry soon.
      inFlight = null
      next.retries += 1
      if (next.retries > WRITE_BUSY_MAX_RETRIES) {
        failPayload(next, GnssException("E_GNSS_WRITE_FAILED", "The Bluetooth stack kept refusing the write"))
        pump()
      } else {
        writes.addFirst(next)
        io.postDelayed(pumpLater, WRITE_BUSY_RETRY_MS)
      }
      return
    }
    io.postDelayed(writeStall, WRITE_STALL_MS)
  }

  private fun onWriteDone(status: Int) {
    io.removeCallbacks(writeStall)
    val w = inFlight ?: return
    inFlight = null
    if (status != BluetoothGatt.GATT_SUCCESS) {
      failPayload(w, GnssException("E_GNSS_WRITE_FAILED", "The receiver rejected a write (status $status)"))
    } else if (w.last) {
      w.done?.invoke(null)
    }
    pump()
  }

  /** Fails [w]'s payload once and drops its chunks still queued. */
  private fun failPayload(w: PendingWrite, error: GnssException) {
    var done = if (w.last) w.done else null
    val it = writes.iterator()
    while (it.hasNext()) {
      val other = it.next()
      if (other.payload == w.payload) {
        if (other.last) done = other.done
        it.remove()
      }
    }
    done?.invoke(error)
  }

  private fun failAllWrites(error: GnssException) {
    io.removeCallbacks(writeStall)
    io.removeCallbacks(pumpLater)
    inFlight?.let { failPayload(it, error) }
    inFlight = null
    while (writes.isNotEmpty()) failPayload(writes.removeFirst(), error)
  }

  private fun fail(error: GnssException) {
    if (closed) return
    shutDown(error)
    listener.onClosed(error)
  }

  override fun close() {
    if (closed) return
    shutDown(GnssException("E_GNSS_NOT_CONNECTED", "The receiver was disconnected"))
  }

  private fun shutDown(error: GnssException) {
    closed = true
    io.removeCallbacks(rssiTick)
    failAllWrites(error)
    val g = gatt
    gatt = null
    try {
      g?.disconnect()
      g?.close()
    } catch (_: SecurityException) {
    }
  }

  /** Runs a permission-guarded GATT call; a revoked permission is fatal. */
  private inline fun guard(block: () -> Unit) {
    try {
      block()
    } catch (e: SecurityException) {
      fail(permissionError(e))
    }
  }
}
