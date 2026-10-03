package expo.modules.inukshukterrain

import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.view.View
import android.view.ViewGroup
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import org.maplibre.android.maps.MapView

class TerrainConfig : Record {
  /** 14 floats, see TerrainNative.nativeSetLook. */
  @Field var look: List<Double> = emptyList()

  /** false = probe only (frame timing, no drawing, 60° ceiling). */
  @Field var enabled: Boolean = true

  @Field var networkAllowed: Boolean = true

  @Field var maxPitch: Double = 80.0
}

class BenchStep : Record {
  @Field var kind: String = "idle"
  @Field var durationMs: Double = 0.0
  @Field var amount: Double = 0.0
}

/**
 * Native 3D terrain inside the MapLibre map (docs/plans/native-terrain.md).
 * JS attaches it to the view that CONTAINS the <Map> (a host View it can take
 * a React tag of); everything per-frame then runs natively.
 */
class InukshukTerrainModule : Module() {
  private val controllers = HashMap<Int, TerrainController>()
  private var memoryCallbacks: ComponentCallbacks2? = null

  override fun definition() = ModuleDefinition {
    Name("InukshukTerrain")

    Constant("supported") { true }

    OnCreate {
      val cb = object : ComponentCallbacks2 {
        override fun onTrimMemory(level: Int) {
          if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) controllers.values.forEach { it.trimMemory() }
        }

        override fun onConfigurationChanged(newConfig: Configuration) {}

        @Deprecated("Deprecated in Java")
        override fun onLowMemory() {
          controllers.values.forEach { it.trimMemory() }
        }
      }
      appContext.reactContext?.applicationContext?.registerComponentCallbacks(cb)
      memoryCallbacks = cb
    }

    OnDestroy {
      memoryCallbacks?.let { appContext.reactContext?.applicationContext?.unregisterComponentCallbacks(it) }
      controllers.values.forEach { it.detach() }
      controllers.clear()
    }

    AsyncFunction("attach") { viewTag: Int, config: TerrainConfig, promise: Promise ->
      val root = appContext.findView<View>(viewTag)
      val mapView = root?.let { findMapView(it) }
      if (mapView == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      controllers.remove(viewTag)?.detach()
      mapView.getMapAsync { map ->
        val c = TerrainController(mapView.context.applicationContext, mapView, map)
        c.attach(look(config), config.enabled, config.networkAllowed, config.maxPitch)
        controllers[viewTag] = c
        promise.resolve(true)
      }
    }.runOnQueue(Queues.MAIN)

    Function("update") { viewTag: Int, config: TerrainConfig ->
      controllers[viewTag]?.update(look(config), config.enabled, config.networkAllowed)
      Unit
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("detach") { viewTag: Int ->
      controllers.remove(viewTag)?.detach()
      Unit
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stats") { viewTag: Int ->
      controllers[viewTag]?.stats()?.toList() ?: emptyList()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("trimMemory") { viewTag: Int ->
      controllers[viewTag]?.trimMemory()
      Unit
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("runBench") { viewTag: Int, script: List<BenchStep>, promise: Promise ->
      val c = controllers[viewTag]
      if (c == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val steps =
        if (script.isEmpty()) GestureBench.standardScript()
        else script.map { GestureBench.Step(it.kind, it.durationMs.toLong(), it.amount.toFloat()) }
      c.setRecording(true)
      GestureBench(c.mapView) {
        val times = c.takeFrameTimes(false)
        val costs = c.takeFrameTimes(true)
        c.setRecording(false)
        promise.resolve(
          mapOf(
            "frameTimesNs" to times.map { it.toDouble() },
            "costNs" to costs.map { it.toDouble() },
            "stats" to c.stats().toList(),
          ),
        )
      }.start(steps)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("record") { viewTag: Int, on: Boolean ->
      val c = controllers[viewTag] ?: return@AsyncFunction null
      if (on) {
        c.setRecording(true)
        null
      } else {
        val times = c.takeFrameTimes(false)
        val costs = c.takeFrameTimes(true)
        c.setRecording(false)
        mapOf("frameTimesNs" to times.map { it.toDouble() }, "costNs" to costs.map { it.toDouble() })
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun look(config: TerrainConfig): FloatArray = FloatArray(14) { i -> (config.look.getOrNull(i) ?: 0.0).toFloat() }

  private fun findMapView(v: View): MapView? {
    if (v is MapView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) {
        findMapView(v.getChildAt(i))?.let { return it }
      }
    }
    return null
  }
}
