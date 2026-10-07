package expo.modules.inukshukgnss

import android.Manifest
import android.content.Context
import android.os.Build
import android.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import expo.modules.inukshukgnss.core.GattProfile
import expo.modules.inukshukgnss.core.TcpPipe
import expo.modules.inukshukgnss.core.gattProfileOf
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class GattProfileRecord : Record {
  @Field var name: String = ""

  @Field var service: String = ""

  @Field var notify: String = ""

  @Field var write: String? = null
}

class FakeDeviceRecord : Record {
  /** Base64 frames (e.g. one NMEA epoch each), replayed in order. */
  @Field var frames: List<String> = emptyList()

  @Field var intervalMs: Double = 1000.0

  @Field var loop: Boolean = true
}

class ConnectOptions : Record {
  @Field var deviceId: String = ""

  @Field var transport: String = ""

  @Field var profiles: List<GattProfileRecord> = emptyList()

  @Field var autoReconnect: Boolean = true

  @Field var mtu: Double = 517.0

  @Field var fake: FakeDeviceRecord? = null
}

class ScanOptions : Record {
  @Field var durationMs: Double = 15_000.0
}

class TcpOptions : Record {
  @Field var host: String = ""

  @Field var port: Int = 0

  @Field var tls: Boolean = false
}

class KnownDevicesOptions : Record {
  @Field var serviceUuids: List<String> = emptyList()
}

/**
 * JS surface of the GNSS receiver transport (contract in
 * src/lib/gnss/nativeGnss.ts). Thin: validation, permissions, and handing
 * off to the process-wide [GnssSession].
 */
class InukshukGnssModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  @Volatile private var attached = false

  /** The process-wide session, with this instance attached as a sink. */
  private val session: GnssSession
    get() =
      GnssSession.get(context).also {
        if (!attached) {
          it.attach(sink)
          attached = true
        }
      }

  private val sink = object : GnssEventSink {
    override fun emit(name: String, body: Map<String, Any?>) {
      sendEvent(name, body)
    }
  }

  /** NTRIP sockets of this React instance (closed with it). */
  private val tcp = ConcurrentHashMap<String, TcpPipe>()

  @Volatile private var tcpListening = false

  override fun definition() = ModuleDefinition {
    Name("InukshukGnss")

    Events(
      "onBytes",
      "onState",
      "onDevice",
      "onScanState",
      "onRssi",
      "onError",
      "onAvailability",
      "onTcpData",
      "onTcpClose",
    )

    OnCreate {
      // Attach early so state events are not missed; if the React context is
      // not ready yet, the first call or listener attaches instead.
      try {
        session
      } catch (_: Exception) {
      }
    }

    OnDestroy {
      // The link outlives this React instance on purpose (see GnssSession);
      // a scan does not.
      if (attached) {
        try {
          val s = session
          s.detach(sink)
          s.stopScan(null)
        } catch (_: Exception) {
        }
        attached = false
      }
      tcp.values.forEach { it.close() }
      tcp.clear()
    }

    OnStartObserving("onTcpData") {
      tcpListening = true
      tcp.values.forEach { it.setListening(true) }
    }

    OnStopObserving("onTcpData") {
      tcpListening = false
      tcp.values.forEach { it.setListening(false) }
    }

    // Raw TCP / TLS for NTRIP casters (contract: src/data/gnss/ntripSocket.ts).
    // Resolves with the socket id once connected; rejects E_TCP_CONNECT.
    AsyncFunction("openTcp") { options: TcpOptions, promise: Promise ->
      val host = options.host.trim()
      if (host.isEmpty() || options.port !in 1..65535) {
        promise.reject("E_TCP_BAD_ARGUMENT", "A host and a port (1-65535) are required", null)
        return@AsyncFunction
      }
      if (tcp.size >= MAX_TCP) {
        promise.reject("E_TCP_LIMIT", "Too many open caster connections", null)
        return@AsyncFunction
      }
      val id = UUID.randomUUID().toString()
      val pipe = TcpPipe(
        host,
        options.port,
        options.tls,
        object : TcpPipe.Listener {
          override fun onData(data: ByteArray) {
            sendEvent("onTcpData", mapOf("id" to id, "data" to Base64.encodeToString(data, Base64.NO_WRAP)))
          }

          override fun onClose(error: String?) {
            tcp.remove(id)
            sendEvent("onTcpClose", mapOf("id" to id, "error" to error))
          }
        },
      )
      pipe.setListening(tcpListening)
      tcp[id] = pipe
      pipe.open { error ->
        if (error == null) {
          promise.resolve(id)
        } else {
          tcp.remove(id)
          promise.reject("E_TCP_CONNECT", error, null)
        }
      }
    }

    AsyncFunction("writeTcp") { id: String, data: ByteArray, promise: Promise ->
      val pipe = tcp[id]
      if (pipe == null) {
        promise.reject("E_TCP_CLOSED", "The caster connection is closed", null)
        return@AsyncFunction
      }
      pipe.write(data) { error ->
        if (error == null) promise.resolve(null) else promise.reject("E_TCP_WRITE", error, null)
      }
    }

    AsyncFunction("closeTcp") { id: String ->
      tcp.remove(id)?.close()
    }

    OnStartObserving("onBytes") { session.setListening(sink, true) }

    OnStopObserving("onBytes") { session.setListening(sink, false) }

    AsyncFunction("getAvailability") { session.availability() }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, *requiredPermissions())
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, *requiredPermissions())
    }

    AsyncFunction("startScan") { options: ScanOptions, promise: Promise ->
      session.startScan(options.durationMs.toLong(), promise)
    }

    AsyncFunction("stopScan") { promise: Promise -> session.stopScan(promise) }

    // serviceUuids is used by iOS only; Android lists bonded devices.
    AsyncFunction("getKnownDevices") { _: KnownDevicesOptions, promise: Promise -> session.knownDevices(promise) }

    AsyncFunction("connect") { options: ConnectOptions, promise: Promise ->
      val target =
        try {
          parseTarget(options)
        } catch (e: GnssException) {
          promise.reject(e.code, e.message, e)
          return@AsyncFunction
        }
      session.connect(target, promise)
    }

    AsyncFunction("disconnect") { promise: Promise -> session.disconnect(promise) }

    AsyncFunction("write") { data: ByteArray, promise: Promise -> session.write(data, promise) }

    Function("getState") { session.state() }
  }

  /**
   * Android 12+ (API 31): the "Nearby devices" runtime permissions.
   * BLUETOOTH_SCAN is declared with neverForLocation (plugins/withGnss.js),
   * so scanning needs no location permission.
   * Android 8–11: BLUETOOTH/BLUETOOTH_ADMIN are install-time, but a BLE scan
   * returns nothing without ACCESS_FINE_LOCATION (which the app already asks
   * for to show the blue dot).
   */
  private companion object {
    const val MAX_TCP = 4
  }

  private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun parseTarget(o: ConnectOptions): LinkTarget {
    fun bad(message: String) = GnssException("E_GNSS_BAD_ARGUMENT", message, fatal = true)
    if (o.deviceId.isBlank()) throw bad("deviceId is required")
    val mtu = o.mtu.toInt().coerceIn(23, 517)
    return when (o.transport) {
      TRANSPORT_SPP -> LinkTarget(o.deviceId, TRANSPORT_SPP, emptyList(), o.autoReconnect, mtu, emptyList(), 0, false)
      TRANSPORT_BLE -> {
        val profiles: List<GattProfile> = o.profiles.map {
          gattProfileOf(it.name, it.service, it.notify, it.write) ?: throw bad("Invalid GATT profile '${it.name}'")
        }
        if (profiles.isEmpty()) throw bad("A BLE connection needs at least one GATT profile")
        LinkTarget(o.deviceId, TRANSPORT_BLE, profiles, o.autoReconnect, mtu, emptyList(), 0, false)
      }
      TRANSPORT_FAKE -> {
        val f = o.fake ?: throw bad("The simulated receiver needs its frames")
        val frames = f.frames.map {
          try {
            Base64.decode(it, Base64.DEFAULT)
          } catch (e: IllegalArgumentException) {
            throw bad("A simulated frame is not base64")
          }
        }
        if (frames.isEmpty()) throw bad("The simulated receiver needs at least one frame")
        val interval = f.intervalMs.toLong().coerceIn(20, 60_000)
        LinkTarget(o.deviceId, TRANSPORT_FAKE, emptyList(), o.autoReconnect, mtu, frames, interval, f.loop)
      }
      // "ea" (iOS External Accessory) and "tcp" are reserved names.
      else -> throw GnssException("E_GNSS_UNSUPPORTED_TRANSPORT", "Unsupported transport '${o.transport}'", fatal = true)
    }
  }
}
