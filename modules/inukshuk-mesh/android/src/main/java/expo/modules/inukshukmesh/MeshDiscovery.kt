package expo.modules.inukshukmesh

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.Random

interface MeshDiscoveryListener {
  fun onPeerFound(service: Map<String, Any?>)
  fun onPeerLost(serviceId: String)
  fun onError(code: String, message: String)
  fun onStateChanged()
}

/**
 * DNS-SD advertisement and browsing through NsdManager.
 *
 * The advert is `_inukshuk-team._tcp` under a random instance name
 * (`ink-xxxxxxxxxxxx`, new each time advertising starts) with a TXT record
 * of `v=1` and `t=<discovery tag>` only: never a device, team or member
 * name. Browsing reports a service once it has been resolved and its tag
 * matches. NsdManager resolves one service at a time before API 34, so
 * resolves are queued (bounded: a flood of adverts cannot grow memory), and
 * the table of known services is bounded too.
 *
 * A Wi-Fi multicast lock is held while advertising or browsing: many Wi-Fi
 * drivers drop multicast in power save, which hides mDNS from the system
 * responder too (CHANGE_WIFI_MULTICAST_STATE, a normal permission).
 *
 * All state is touched on the main looper, where NsdManager calls back.
 */
class MeshDiscovery(
  context: Context,
  private val listener: MeshDiscoveryListener,
  private val isBanned: (String) -> Boolean,
) {
  data class Found(val serviceId: String, val host: String, val port: Int, val tag: String)

  private val appContext = context.applicationContext
  private val nsd = appContext.getSystemService(Context.NSD_SERVICE) as NsdManager
  private val main = Handler(Looper.getMainLooper())
  private val random = Random()

  private var registration: NsdManager.RegistrationListener? = null
  @Volatile var advertisedName: String? = null
    private set
  private val ownNames = HashSet<String>()

  private var discovery: NsdManager.DiscoveryListener? = null
  @Volatile var browsing = false
    private set
  private var browseTag: String? = null
  private val pending = ArrayDeque<NsdServiceInfo>()
  private var resolving = false
  private val found = LinkedHashMap<String, Found>()

  private var multicastLock: WifiManager.MulticastLock? = null

  companion object {
    const val MAX_PENDING_RESOLVES = 64
    const val MAX_SERVICES = 256
  }

  fun advertise(port: Int, tag: String) = onMain {
    stopAdvertisingNow()
    val name = MeshTags.instanceName(random)
    val info = NsdServiceInfo().apply {
      serviceName = name
      serviceType = MeshTags.SERVICE_TYPE
      setPort(port)
      setAttribute("v", "1")
      setAttribute("t", tag)
    }
    ownNames.add(name)
    val l = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(info: NsdServiceInfo) = onMain {
        // The system may rename us on a collision: remember the real name.
        info.serviceName?.let { ownNames.add(it); advertisedName = it }
        listener.onStateChanged()
      }
      override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) = onMain {
        if (registration === this) { registration = null; advertisedName = null }
        updateMulticastLock()
        listener.onError("E_MESH_ADVERTISE", "Service registration failed ($errorCode)")
        listener.onStateChanged()
      }
      override fun onServiceUnregistered(info: NsdServiceInfo) {}
      override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
    }
    registration = l
    advertisedName = name
    updateMulticastLock()
    try {
      nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
    } catch (e: Exception) {
      registration = null
      advertisedName = null
      updateMulticastLock()
      listener.onError("E_MESH_ADVERTISE", e.message ?: "registerService failed")
    }
    listener.onStateChanged()
  }

  fun stopAdvertising() = onMain {
    stopAdvertisingNow()
    listener.onStateChanged()
  }

  private fun stopAdvertisingNow() {
    registration?.let { try { nsd.unregisterService(it) } catch (_: Exception) {} }
    registration = null
    advertisedName = null
    updateMulticastLock()
  }

  fun browse(tag: String?) = onMain {
    browseTag = tag
    if (discovery != null) {
      // Same browse, new filter: re-report what we know under it.
      for (f in found.values.toList()) if (tag == null || f.tag == tag) listener.onPeerFound(describe(f))
      return@onMain
    }
    val l = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = onMain {
        if (discovery === this) { discovery = null; browsing = false }
        updateMulticastLock()
        listener.onError("E_MESH_BROWSE", "Service discovery failed to start ($errorCode)")
        listener.onStateChanged()
      }
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onServiceFound(info: NsdServiceInfo) = onMain {
        if (discovery !== this) return@onMain
        val name = info.serviceName ?: return@onMain
        if (name in ownNames || found.containsKey(name)) return@onMain
        if (pending.any { it.serviceName == name }) return@onMain
        if (pending.size >= MAX_PENDING_RESOLVES) return@onMain
        pending.addLast(info)
        pumpResolves()
      }
      override fun onServiceLost(info: NsdServiceInfo) = onMain {
        val name = info.serviceName ?: return@onMain
        pending.removeAll { it.serviceName == name }
        if (found.remove(name) != null) listener.onPeerLost(name)
      }
    }
    discovery = l
    browsing = true
    updateMulticastLock()
    try {
      nsd.discoverServices(MeshTags.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
    } catch (e: Exception) {
      discovery = null
      browsing = false
      updateMulticastLock()
      listener.onError("E_MESH_BROWSE", e.message ?: "discoverServices failed")
    }
    listener.onStateChanged()
  }

  fun stopBrowsing() = onMain {
    stopBrowsingNow()
    listener.onStateChanged()
  }

  private fun stopBrowsingNow() {
    discovery?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
    discovery = null
    browsing = false
    pending.clear()
    found.clear()
    updateMulticastLock()
  }

  /** Where a found service listens, or null when it is unknown (or gone). */
  fun target(serviceId: String): Found? {
    var result: Found? = null
    if (Looper.myLooper() == Looper.getMainLooper()) return found[serviceId]
    val latch = java.util.concurrent.CountDownLatch(1)
    main.post { result = found[serviceId]; latch.countDown() }
    latch.await(500, java.util.concurrent.TimeUnit.MILLISECONDS)
    return result
  }

  fun stop() = onMain {
    stopAdvertisingNow()
    stopBrowsingNow()
    ownNames.clear()
  }

  @Suppress("DEPRECATION")
  private fun pumpResolves() {
    if (resolving || discovery == null) return
    val info = pending.removeFirstOrNull() ?: return
    resolving = true
    val l = object : NsdManager.ResolveListener {
      override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = onMain {
        resolving = false
        if (errorCode == NsdManager.FAILURE_ALREADY_ACTIVE && pending.size < MAX_PENDING_RESOLVES) {
          // Another resolve in this process is running: try again shortly.
          pending.addLast(info)
          main.postDelayed({ pumpResolves() }, 250)
        } else {
          pumpResolves()
        }
      }
      override fun onServiceResolved(info: NsdServiceInfo) = onMain {
        resolving = false
        accept(info)
        pumpResolves()
      }
    }
    try {
      nsd.resolveService(info, l)
    } catch (e: Exception) {
      resolving = false
      main.post { pumpResolves() }
    }
  }

  @Suppress("DEPRECATION")
  private fun accept(info: NsdServiceInfo) {
    if (discovery == null) return
    val name = info.serviceName ?: return
    if (name in ownNames) return
    val attrs = info.attributes ?: emptyMap()
    val version = attrs["v"]?.let { String(it, Charsets.UTF_8) }
    val tag = attrs["t"]?.let { String(it, Charsets.UTF_8) }
    if (version != "1" || !MeshTags.isValid(tag)) return
    val address = if (Build.VERSION.SDK_INT >= 34) {
      info.hostAddresses.firstOrNull { it is java.net.Inet4Address } ?: info.hostAddresses.firstOrNull()
    } else {
      info.host
    }
    val host = address?.hostAddress ?: return
    val port = info.port
    if (port !in 1..65535) return
    // A banned address stays invisible to JS until its ban ends.
    if (isBanned(host)) return
    if (found.size >= MAX_SERVICES && !found.containsKey(name)) return
    val f = Found(name, host, port, tag!!)
    found[name] = f
    val filter = browseTag
    if (filter == null || filter == f.tag) listener.onPeerFound(describe(f))
  }

  private fun describe(f: Found): Map<String, Any?> =
    mapOf("serviceId" to f.serviceId, "host" to f.host, "port" to f.port, "tag" to f.tag)

  private fun updateMulticastLock() {
    val want = registration != null || discovery != null
    try {
      if (want && multicastLock == null) {
        val wifi = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        multicastLock = wifi?.createMulticastLock("inukshuk-mesh")?.apply {
          setReferenceCounted(false)
          acquire()
        }
      } else if (!want) {
        multicastLock?.let { if (it.isHeld) it.release() }
        multicastLock = null
      }
    } catch (e: Exception) {
      // Without the lock mDNS may still work; never fail discovery over it.
    }
  }

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }
}
