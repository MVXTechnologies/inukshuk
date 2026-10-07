package expo.modules.inukshukmesh

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Team mesh transport (#589): LAN / phone-hotspot TCP with DNS-SD discovery.
 * Moves opaque frames between peers; identity, crypto and sync stay in JS
 * (src/core/team). JS binding: src/data/team/meshNative.ts. Design and
 * limits: docs/design/team-mesh.md.
 */
class InukshukMeshModule : Module() {
  private val lock = Any()
  private var engine: MeshEngine? = null
  private var discovery: MeshDiscovery? = null
  private var network: MeshNetwork? = null
  private val main = Handler(Looper.getMainLooper())
  private var statsTick: Runnable? = null

  private val engineEvents = object : MeshEngineListener {
    override fun onConnected(peer: Map<String, Any?>) = emit("onConnected", peer)
    override fun onDisconnected(peerId: String?, dialId: String?, reason: String, retryInMs: Long?) =
      emit("onDisconnected", mapOf("peerId" to peerId, "dialId" to dialId, "reason" to reason, "retryInMs" to retryInMs?.toDouble()))
    override fun onFramesAvailable() = emit("onFramesAvailable", emptyMap())
    override fun onWritable(peerId: String) = emit("onWritable", mapOf("peerId" to peerId))
    override fun onError(code: String, message: String) = emit("onError", mapOf("code" to code, "message" to message))
  }

  private val discoveryEvents = object : MeshDiscoveryListener {
    override fun onPeerFound(service: Map<String, Any?>) = emit("onPeerFound", service)
    override fun onPeerLost(serviceId: String) = emit("onPeerLost", mapOf("serviceId" to serviceId))
    override fun onError(code: String, message: String) = emit("onError", mapOf("code" to code, "message" to message))
    override fun onStateChanged() = emit("onStateChanged", state())
  }

  private fun emit(name: String, body: Map<String, Any?>) {
    try { sendEvent(name, body) } catch (_: Throwable) {}
  }

  private fun coded(e: MeshException) = CodedException(e.code, e.message, null)

  private fun requireEngine(): MeshEngine =
    synchronized(lock) { engine }?.takeIf { it.isRunning } ?: throw CodedException("E_MESH_NOT_RUNNING", "The mesh is not started", null)

  private fun state(): Map<String, Any?> {
    val e = synchronized(lock) { engine }
    val d = synchronized(lock) { discovery }
    return mapOf(
      "running" to (e?.isRunning == true),
      "port" to e?.port?.takeIf { it > 0 },
      "advertising" to (d?.advertisedName != null),
      "browsing" to (d?.browsing == true),
      // Android has no local-network permission: LAN access is always granted.
      "localNetwork" to "granted",
    )
  }

  private fun stopAll() {
    val e: MeshEngine?
    val d: MeshDiscovery?
    synchronized(lock) {
      e = engine; d = discovery
      engine = null; discovery = null
    }
    statsTick?.let { main.removeCallbacks(it) }
    statsTick = null
    d?.stop()
    e?.stop()
  }

  override fun definition() = ModuleDefinition {
    Name("InukshukMesh")

    Events(
      "onPeerFound", "onPeerLost", "onConnected", "onDisconnected", "onFramesAvailable",
      "onWritable", "onError", "onStateChanged", "onStats",
    )

    Constant("defaultPort") { MeshConfig.DEFAULT_PORT }
    Constant("serviceType") { MeshTags.SERVICE_TYPE }
    Constant("maxFrameCeiling") { MeshWire.MAX_FRAME_CEILING }

    AsyncFunction("start") { config: Map<String, Any?>? ->
      val context = appContext.reactContext?.applicationContext
        ?: throw CodedException("E_MESH_CONTEXT", "No application context", null)
      synchronized(lock) {
        engine?.takeIf { it.isRunning }?.let { return@AsyncFunction mapOf("port" to it.port, "alreadyRunning" to true) }
        val net = MeshNetwork(context)
        val e = MeshEngine(MeshConfig.from(config), engineEvents, { ch, addr -> net.bindToLan(ch, addr) })
        val port = try { e.start() } catch (x: MeshException) { throw coded(x) }
        engine = e
        network = net
        discovery = MeshDiscovery(context, discoveryEvents) { ip -> e.isBanned(ip) }
        val tick = object : Runnable {
          override fun run() {
            val current = synchronized(lock) { engine }
            if (current !== e || !e.isRunning) return
            emit("onStats", e.stats())
            main.postDelayed(this, 5_000)
          }
        }
        statsTick = tick
        main.postDelayed(tick, 5_000)
        emit("onStateChanged", state())
        mapOf("port" to port, "alreadyRunning" to false)
      }
    }

    AsyncFunction("stop") {
      stopAll()
      emit("onStateChanged", state())
    }

    AsyncFunction("startAdvertising") { tag: String ->
      if (!MeshTags.isValid(tag)) throw CodedException("E_MESH_ARGUMENT", "Invalid discovery tag", null)
      val e = requireEngine()
      val d = synchronized(lock) { discovery } ?: throw CodedException("E_MESH_NOT_RUNNING", "The mesh is not started", null)
      d.advertise(e.port, tag)
    }

    Function("stopAdvertising") {
      synchronized(lock) { discovery }?.stopAdvertising()
    }

    AsyncFunction("startBrowsing") { tag: String? ->
      if (tag != null && !MeshTags.isValid(tag)) throw CodedException("E_MESH_ARGUMENT", "Invalid discovery tag", null)
      requireEngine()
      val d = synchronized(lock) { discovery } ?: throw CodedException("E_MESH_NOT_RUNNING", "The mesh is not started", null)
      d.browse(tag)
    }

    Function("stopBrowsing") {
      synchronized(lock) { discovery }?.stopBrowsing()
    }

    Function("connect") { host: String, port: Int, reconnect: Boolean ->
      try { requireEngine().connect(host, port, reconnect) } catch (x: MeshException) { throw coded(x) }
    }

    Function("connectService") { serviceId: String, reconnect: Boolean ->
      val e = requireEngine()
      val target = synchronized(lock) { discovery }?.target(serviceId)
        ?: throw CodedException("E_MESH_UNKNOWN_SERVICE", "No resolved service $serviceId", null)
      try { e.connect(target.host, target.port, reconnect) } catch (x: MeshException) { throw coded(x) }
    }

    Function("disconnect") { id: String ->
      synchronized(lock) { engine }?.disconnect(id)
    }

    Function("send") { peerId: String, data: ByteArray ->
      try { requireEngine().send(peerId, data).toDouble() } catch (x: MeshException) { throw coded(x) }
    }

    Function("takeFrames") { max: Int ->
      val e = synchronized(lock) { engine } ?: return@Function emptyList<Map<String, Any>>()
      e.takeFrames(max.coerceIn(1, 1024)).map { mapOf("peerId" to it.peerId, "data" to it.data) }
    }

    Function("ban") { peerId: String, durationMs: Double ->
      val ms = if (durationMs.isFinite()) durationMs.toLong() else MeshConfig.MAX_BAN_MS
      synchronized(lock) { engine }?.ban(peerId, ms)
    }

    Function("getStats") {
      synchronized(lock) { engine }?.stats() ?: mapOf("running" to false, "peers" to emptyList<Any>())
    }

    Function("getState") { state() }

    Function("getNetworkInfo") {
      val context = appContext.reactContext?.applicationContext
      val net = synchronized(lock) { network } ?: context?.let { MeshNetwork(it) }
      val info = net?.info() ?: mapOf("interfaces" to emptyList<Any>(), "gateways" to emptyList<Any>())
      info + mapOf("port" to synchronized(lock) { engine }?.port?.takeIf { it > 0 })
    }

    OnDestroy { stopAll() }
  }
}
