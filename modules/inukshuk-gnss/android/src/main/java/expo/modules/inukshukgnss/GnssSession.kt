package expo.modules.inukshukgnss

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Base64
import expo.modules.inukshukgnss.core.Backoff
import expo.modules.inukshukgnss.core.ByteRing
import expo.modules.inukshukgnss.core.FlushPacer
import expo.modules.inukshukgnss.core.ScanThrottle
import expo.modules.kotlin.Promise

/** Receives the session's events; the module forwards them to JS. */
internal interface GnssEventSink {
  fun emit(name: String, body: Map<String, Any?>)
}

internal const val FAKE_DEVICE_ID = "inukshuk-fake-receiver"
internal const val FAKE_DEVICE_NAME = "Simulated receiver (test)"

/** Manifest flag set by plugins/withGnss.js when the E2E build asks for it. */
private const val FAKE_DEVICE_META = "app.inukshuk.gnss.FAKE_DEVICE"

/**
 * The one receiver link of the process.
 *
 * **Process-scoped, not module-scoped.** It lives as long as the process, not
 * the React instance: Android keeps the process alive during a recording via
 * expo-location's foreground service (src/lib/backgroundLocation.ts), and the
 * link has to survive whatever happens to the JS side meanwhile — a React
 * host rebuilt after the activity was destroyed, a dev reload, a headless
 * task context. Module instances attach as [GnssEventSink]s.
 *
 * **Why no foreground service of our own.** The socket reads run on native
 * threads of a process that already holds a `location` foreground service
 * while recording, so they keep running with the screen off. Bluetooth I/O
 * has no while-in-use restriction, so it needs no FGS type of its own, and
 * adding a `connectedDevice` service would mean a Play FGS declaration for no
 * gain. Outside a recording the app may be cached and frozen in the
 * background: the link then drops and auto-reconnects on return. A
 * "receiver connected without recording, screen off" use case would need
 * that service (a documented seam, see the module README).
 *
 * **Threading.** Every field below is confined to the `inukshuk-gnss`
 * HandlerThread, except [sinks] (synchronised) and [snapshot] (volatile).
 *
 * **Backpressure.** Bytes accumulate in a 512 KiB ring and leave as one
 * `onBytes` event per 100 ms at most (≤ 64 KiB each, base64). With no JS
 * listener they stay in the ring (oldest dropped and counted) and flush when
 * a listener attaches.
 */
@SuppressLint("MissingPermission")
internal class GnssSession private constructor(private val context: Context) {
  companion object {
    @Volatile private var instance: GnssSession? = null

    fun get(context: Context): GnssSession =
      instance ?: synchronized(this) {
        instance ?: GnssSession(context.applicationContext).also { instance = it }
      }

    private const val RING_BYTES = 512 * 1024
    private const val MAX_EVENT_BYTES = 64 * 1024
    private const val FLUSH_INTERVAL_MS = 100L
    private const val CONNECT_TIMEOUT_MS = 30_000L
    private const val DEFAULT_SCAN_MS = 15_000L
    private const val MAX_SCAN_MS = 60_000L
  }

  private val thread = HandlerThread("inukshuk-gnss").apply { start() }
  private val io = Handler(thread.looper)
  private val adapter: BluetoothAdapter? =
    (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  /** Attached module instances, and whether each listens to `onBytes`. */
  private val sinks = LinkedHashMap<GnssEventSink, Boolean>()

  private val ring = ByteRing(RING_BYTES)
  private val pacer = FlushPacer(FLUSH_INTERVAL_MS)
  private var flushPosted = false
  private var target: LinkTarget? = null
  private var transport: Transport? = null
  private var generation = 0
  private var info: LinkInfo? = null
  private val backoff = Backoff()

  @Volatile private var snapshot: Map<String, Any?> = stateBody("idle", null, null)

  private val reconnect = Runnable { openCurrent() }
  private val flush = Runnable { flushNow() }
  private var connectTimeout: Runnable? = null

  // BLE devices seen by the current process, so connect() can use the exact
  // object the scanner returned (random-address peripherals need it).
  private val seenLe = HashMap<String, BluetoothDevice>()
  private var scanCallback: ScanCallback? = null
  private val scanThrottle = ScanThrottle()
  private val scanTimeout = Runnable { stopScanNow("timeout") }

  val fakeAllowed: Boolean by lazy { computeFakeAllowed() }

  init {
    val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context, intent: Intent) {
        val s = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
        io.post { onAdapterState(s) }
      }
    }
    // A system broadcast: delivered to non-exported receivers too.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(receiver, filter)
    }
  }

  // --- sinks ---------------------------------------------------------------

  fun attach(sink: GnssEventSink) {
    synchronized(sinks) { sinks[sink] = false }
  }

  fun detach(sink: GnssEventSink) {
    synchronized(sinks) { sinks.remove(sink) }
  }

  fun setListening(sink: GnssEventSink, listening: Boolean) {
    synchronized(sinks) { if (sinks.containsKey(sink)) sinks[sink] = listening }
    if (listening) io.post { scheduleFlush() }
  }

  private fun anyListening() = synchronized(sinks) { sinks.values.any { it } }

  private fun emit(name: String, body: Map<String, Any?>) {
    val targets = synchronized(sinks) { sinks.keys.toList() }
    for (s in targets) s.emit(name, body)
  }

  private fun emitError(e: GnssException, deviceId: String?) {
    emit("onError", mapOf("code" to e.code, "message" to (e.message ?: e.code), "deviceId" to deviceId, "fatal" to e.fatal))
  }

  // --- availability ----------------------------------------------------------

  fun availability(): Map<String, Any?> {
    val pm = context.packageManager
    val ble = pm.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
    val classic = pm.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH)
    val transports = buildList {
      if (adapter != null && ble) add(TRANSPORT_BLE)
      if (adapter != null && classic) add(TRANSPORT_SPP)
      if (fakeAllowed) add(TRANSPORT_FAKE)
    }
    return mapOf(
      "supported" to (adapter != null && (ble || classic)),
      "ble" to (adapter != null && ble),
      "classic" to (adapter != null && classic),
      "poweredOn" to (adapter?.isEnabled == true),
      "transports" to transports,
      "fakeDevice" to fakeAllowed,
    )
  }

  private fun onAdapterState(s: Int) {
    val on = s == BluetoothAdapter.STATE_ON
    if (s != BluetoothAdapter.STATE_ON && s != BluetoothAdapter.STATE_OFF) return
    emit("onAvailability", availability())
    if (!on) {
      stopScanNow("bluetooth-off")
      return
    }
    // Bluetooth came back: retry the wanted link now rather than at the end
    // of a backoff that was counting failures caused by the radio being off.
    if (target != null && transport == null) {
      io.removeCallbacks(reconnect)
      backoff.reset()
      openCurrent()
    }
  }

  private fun computeFakeAllowed(): Boolean {
    // Debuggable builds always; release builds only with the manifest flag
    // that plugins/withGnss.js writes for E2E builds (GNSS_FAKE_DEVICE=1).
    if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) return true
    return try {
      val ai =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          context.packageManager.getApplicationInfo(
            context.packageName,
            PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()),
          )
        } else {
          @Suppress("DEPRECATION")
          context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        }
      ai.metaData?.getBoolean(FAKE_DEVICE_META, false) == true
    } catch (_: PackageManager.NameNotFoundException) {
      false
    }
  }

  // --- scanning ---------------------------------------------------------------

  /**
   * Unfiltered BLE scan. Many serial receivers do not advertise their
   * 128-bit service UUID (it often only appears in the scan response, or not
   * at all), so filtering by service would hide them; JS ranks results by
   * the advertised services instead. Android stops unfiltered scans when the
   * screen goes off, which is fine for a pairing screen.
   */
  fun startScan(durationMs: Long, promise: Promise) {
    io.post {
      val a = adapter
      if (a == null) return@post promise.reject("E_GNSS_UNAVAILABLE", "This device has no Bluetooth", null)
      if (!a.isEnabled) return@post promise.reject("E_GNSS_BLUETOOTH_OFF", "Bluetooth is off", null)
      val scanner = a.bluetoothLeScanner
        ?: return@post promise.reject("E_GNSS_BLUETOOTH_OFF", "Bluetooth is off", null)
      stopScanNow(null)
      scanThrottle.clear()
      seenLe.clear()
      val cb = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          io.post { onScanResult(result) }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
          io.post { results.forEach { onScanResult(it) } }
        }

        override fun onScanFailed(errorCode: Int) {
          io.post {
            if (scanCallback !== this) return@post
            scanCallback = null
            io.removeCallbacks(scanTimeout)
            // 2 = SCAN_FAILED_APPLICATION_REGISTRATION_FAILED, which is also
            // what Android reports after >5 scan starts in 30 s.
            emitError(GnssException("E_GNSS_SCAN_FAILED", "Bluetooth scan failed (code $errorCode)"), null)
            emit("onScanState", mapOf("scanning" to false, "reason" to "failed"))
          }
        }
      }
      try {
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(null, settings, cb)
      } catch (e: SecurityException) {
        return@post promise.reject("E_GNSS_PERMISSION", "Bluetooth scan permission missing", e)
      }
      scanCallback = cb
      emit("onScanState", mapOf("scanning" to true, "reason" to null))
      if (fakeAllowed) emit("onDevice", fakeDevice())
      val ms = if (durationMs <= 0) DEFAULT_SCAN_MS else durationMs.coerceAtMost(MAX_SCAN_MS)
      io.postDelayed(scanTimeout, ms)
      promise.resolve(null)
    }
  }

  fun stopScan(promise: Promise?) {
    io.post {
      stopScanNow("stopped")
      promise?.resolve(null)
    }
  }

  private fun stopScanNow(reason: String?) {
    val cb = scanCallback ?: return
    scanCallback = null
    io.removeCallbacks(scanTimeout)
    try {
      adapter?.bluetoothLeScanner?.stopScan(cb)
    } catch (_: SecurityException) {
    } catch (_: IllegalStateException) {
      // Adapter already off.
    }
    if (reason != null) emit("onScanState", mapOf("scanning" to false, "reason" to reason))
  }

  private fun onScanResult(r: ScanResult) {
    if (scanCallback == null) return
    val d = r.device
    val id = d.address
    seenLe[id] = d
    if (!scanThrottle.shouldReport(id, SystemClock.elapsedRealtime())) return
    val name = r.scanRecord?.deviceName ?: safeName(d)
    emit(
      "onDevice",
      mapOf(
        "id" to id,
        "name" to name,
        "transport" to TRANSPORT_BLE,
        "rssi" to r.rssi,
        "serviceUuids" to (r.scanRecord?.serviceUuids?.map { it.uuid.toString().lowercase() } ?: emptyList<String>()),
        "bonded" to safeBonded(d),
        "connectable" to r.isConnectable,
      ),
    )
  }

  /**
   * Devices already bonded in Android settings (the SPP receivers, and
   * any bonded BLE ones), plus the fake receiver when allowed.
   */
  fun knownDevices(promise: Promise) {
    io.post {
      val out = ArrayList<Map<String, Any?>>()
      val a = adapter
      if (a != null) {
        val bonded =
          try {
            a.bondedDevices ?: emptySet()
          } catch (e: SecurityException) {
            return@post promise.reject("E_GNSS_PERMISSION", "Bluetooth connect permission missing", e)
          }
        for (d in bonded) {
          val kind = when (d.type) {
            BluetoothDevice.DEVICE_TYPE_CLASSIC -> "classic"
            BluetoothDevice.DEVICE_TYPE_LE -> "le"
            BluetoothDevice.DEVICE_TYPE_DUAL -> "dual"
            else -> "unknown"
          }
          // SDP records cached at pairing; null when Android never fetched them.
          val uuids = d.uuids?.map { it.uuid.toString().lowercase() }
          out.add(
            mapOf(
              "id" to d.address,
              "name" to safeName(d),
              "transport" to if (kind == "le") TRANSPORT_BLE else TRANSPORT_SPP,
              "rssi" to null,
              "serviceUuids" to (uuids ?: emptyList<String>()),
              "bonded" to true,
              "deviceType" to kind,
              "supportsSpp" to uuids?.contains(SPP_UUID.toString().lowercase()),
            ),
          )
        }
      }
      if (fakeAllowed) out.add(fakeDevice())
      promise.resolve(out)
    }
  }

  private fun fakeDevice(): Map<String, Any?> =
    mapOf(
      "id" to FAKE_DEVICE_ID,
      "name" to FAKE_DEVICE_NAME,
      "transport" to TRANSPORT_FAKE,
      "rssi" to null,
      "serviceUuids" to emptyList<String>(),
      "bonded" to false,
    )

  private fun safeName(d: BluetoothDevice): String? =
    try {
      d.name
    } catch (_: SecurityException) {
      null
    }

  private fun safeBonded(d: BluetoothDevice): Boolean =
    try {
      d.bondState == BluetoothDevice.BOND_BONDED
    } catch (_: SecurityException) {
      false
    }

  // --- link lifecycle -----------------------------------------------------------

  fun connect(t: LinkTarget, promise: Promise) {
    io.post {
      if (t.transport == TRANSPORT_FAKE) {
        if (!fakeAllowed) {
          return@post promise.reject("E_GNSS_FAKE_DISABLED", "The simulated receiver is not enabled in this build", null)
        }
      } else if (adapter == null) {
        return@post promise.reject("E_GNSS_UNAVAILABLE", "This device has no Bluetooth", null)
      }
      io.removeCallbacks(reconnect)
      closeTransport()
      // A new link never inherits the previous receiver's unread bytes.
      ring.clear()
      ring.takeDropped()
      target = t
      backoff.reset()
      stopScanNow("connecting")
      openCurrent()
      promise.resolve(null)
    }
  }

  fun disconnect(promise: Promise?) {
    io.post {
      val t = target
      target = null
      io.removeCallbacks(reconnect)
      closeTransport()
      // Bytes already received are real data: deliver them.
      flushNow()
      setState("disconnected", t, reason = "user")
      promise?.resolve(null)
    }
  }

  fun write(data: ByteArray, promise: Promise) {
    io.post {
      val tr = transport
      val i = info
      if (tr == null || i == null) {
        return@post promise.reject("E_GNSS_NOT_CONNECTED", "The receiver is not connected", null)
      }
      if (!i.writable) {
        return@post promise.reject("E_GNSS_NOT_WRITABLE", "This receiver offers no writable serial channel", null)
      }
      tr.write(data) { e ->
        if (e == null) promise.resolve(null) else promise.reject(e.code, e.message, e)
      }
    }
  }

  fun state(): Map<String, Any?> = snapshot

  private fun openCurrent() {
    val t = target ?: return
    if (t.transport != TRANSPORT_FAKE && adapter?.isEnabled != true) {
      // Waits for ACTION_STATE_CHANGED → STATE_ON (onAdapterState).
      setState("reconnecting", t, reason = "bluetooth-off")
      return
    }
    val gen = ++generation
    val listener = boundListener(gen)
    setState("connecting", t)
    val tr: Transport =
      try {
        when (t.transport) {
          TRANSPORT_SPP -> SppTransport(adapter!!, t.deviceId, listener)
          TRANSPORT_BLE -> {
            val device = seenLe[t.deviceId] ?: adapter!!.getRemoteDevice(t.deviceId)
            BleTransport(context, device, t.profiles, t.mtu, listener, io)
          }
          else -> FakeTransport(t.fakeFrames, t.fakeIntervalMs, t.fakeLoop, listener, io)
        }
      } catch (e: IllegalArgumentException) {
        onClosed(gen, GnssException("E_GNSS_BAD_ARGUMENT", "Not a Bluetooth address: ${t.deviceId}", fatal = true, cause = e))
        return
      }
    transport = tr
    val timeout = Runnable {
      if (gen == generation && info == null) {
        // Bumps the generation, so late callbacks of the abandoned attempt
        // are ignored; then decide on a retry like any other failure.
        closeTransport()
        onClosedAfterClose(generation, GnssException("E_GNSS_CONNECT_TIMEOUT", "The receiver did not answer"))
      }
    }
    connectTimeout = timeout
    io.postDelayed(timeout, CONNECT_TIMEOUT_MS)
    tr.open()
  }

  private fun boundListener(gen: Int) = object : TransportListener {
    override fun onOpened(info: LinkInfo) {
      io.post { if (gen == generation) opened(info) }
    }

    override fun onBytes(data: ByteArray) {
      io.post { if (gen == generation) received(data) }
    }

    override fun onRssi(rssi: Int) {
      io.post {
        if (gen == generation) emit("onRssi", mapOf("deviceId" to target?.deviceId, "rssi" to rssi))
      }
    }

    override fun onClosed(error: GnssException) {
      io.post { onClosed(gen, error) }
    }
  }

  private fun opened(i: LinkInfo) {
    connectTimeout?.let { io.removeCallbacks(it) }
    connectTimeout = null
    info = i
    backoff.onConnected(SystemClock.elapsedRealtime())
    setState("connected", target)
  }

  private fun received(data: ByteArray) {
    ring.append(data)
    scheduleFlush()
  }

  private fun onClosed(gen: Int, error: GnssException) {
    if (gen != generation) return
    transport?.close()
    transport = null
    onClosedAfterClose(gen, error)
  }

  /** Decides what follows a lost/failed link: retry later or give up. */
  private fun onClosedAfterClose(gen: Int, error: GnssException) {
    if (gen != generation) return
    connectTimeout?.let { io.removeCallbacks(it) }
    connectTimeout = null
    val wasOpen = info != null
    info = null
    if (wasOpen) backoff.onDisconnected(SystemClock.elapsedRealtime())
    val t = target ?: return
    emitError(error, t.deviceId)
    if (error.fatal || !t.autoReconnect) {
      target = null
      setState("disconnected", t, reason = error.code)
      return
    }
    if (t.transport != TRANSPORT_FAKE && adapter?.isEnabled != true) {
      setState("reconnecting", t, reason = "bluetooth-off")
      return
    }
    val delay = backoff.nextDelayMs()
    setState("reconnecting", t, reason = error.code, retryInMs = delay)
    io.postDelayed(reconnect, delay)
  }

  /** Closes the current link without reporting it (callbacks go stale). */
  private fun closeTransport() {
    generation += 1
    connectTimeout?.let { io.removeCallbacks(it) }
    connectTimeout = null
    transport?.close()
    transport = null
    if (info != null) backoff.onDisconnected(SystemClock.elapsedRealtime())
    info = null
  }

  private fun setState(state: String, t: LinkTarget?, reason: String? = null, retryInMs: Long? = null) {
    val body = stateBody(state, t, info) +
      mapOf("attempt" to backoff.attempt, "reason" to reason, "retryInMs" to retryInMs)
    snapshot = body
    emit("onState", body)
  }

  private fun stateBody(state: String, t: LinkTarget?, i: LinkInfo?): Map<String, Any?> =
    mapOf(
      "state" to state,
      "deviceId" to t?.deviceId,
      "transport" to t?.transport,
      "mtu" to i?.mtu,
      "profile" to i?.profile,
      "writable" to (i?.writable ?: false),
      "attempt" to 0,
      "reason" to null,
      "retryInMs" to null,
    )

  // --- byte delivery -------------------------------------------------------------

  private fun scheduleFlush() {
    if (flushPosted || ring.size == 0 || !anyListening()) return
    flushPosted = true
    io.postDelayed(flush, pacer.delayMs(SystemClock.uptimeMillis()))
  }

  private fun flushNow() {
    flushPosted = false
    io.removeCallbacks(flush)
    if (ring.size == 0 || !anyListening()) return
    val deviceId = target?.deviceId ?: (snapshot["deviceId"] as? String)
    var dropped = ring.takeDropped()
    while (ring.size > 0) {
      val chunk = ring.take(MAX_EVENT_BYTES)
      emit(
        "onBytes",
        mapOf(
          "deviceId" to deviceId,
          "data" to Base64.encodeToString(chunk, Base64.NO_WRAP),
          "length" to chunk.size,
          // Bytes lost before this chunk (ring overflow): the JS framer must
          // resynchronise.
          "dropped" to dropped.toDouble(),
        ),
      )
      dropped = 0
    }
    pacer.flushed(SystemClock.uptimeMillis())
  }
}
