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
  /** TerrainNative.LOOK_FLOATS floats, see packLook. */
  @Field var look: List<Double> = emptyList()

  /** false = probe only (frame timing, no drawing, 60° ceiling). */
  @Field var enabled: Boolean = true

  @Field var networkAllowed: Boolean = true

  @Field var maxPitch: Double = 80.0

  /** Pin plates: plate rgba, ink rgb, muted rgb, water rgb (0–1). */
  @Field var labelTheme: List<Double> = emptyList()

  /** Name properties to try, in order (the map's label language). */
  @Field var nameFields: List<String> = listOf("name")

  @Field var labels: Boolean = true

  /** UI bands (logical px) the pins stay clear of: [top, bottom]. */
  @Field var labelInsets: List<Double> = emptyList()
}

class TerrainLine : Record {
  @Field var id: Int = 0

  /** lng, lat pairs. */
  @Field var coords: List<Double> = emptyList()

  /** color rgba, halo rgba, width, haloWidth, order. */
  @Field var style: List<Double> = emptyList()
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
  private val main = android.os.Handler(android.os.Looper.getMainLooper())
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
        c.setScene(LabelTheme.from(config.labelTheme), config.nameFields, config.labels)
        c.setLabelInsets(config.labelInsets.getOrNull(0) ?: 0.0, config.labelInsets.getOrNull(1) ?: 0.0)
        controllers[viewTag] = c
        promise.resolve(true)
      }
    }.runOnQueue(Queues.MAIN)

    Function("update") { viewTag: Int, config: TerrainConfig ->
      val l = look(config)
      val theme = LabelTheme.from(config.labelTheme)
      main.post {
        controllers[viewTag]?.let {
          it.update(l, config.enabled, config.networkAllowed)
          it.setScene(theme, config.nameFields, config.labels)
          it.setLabelInsets(config.labelInsets.getOrNull(0) ?: 0.0, config.labelInsets.getOrNull(1) ?: 0.0)
        }
      }
      Unit
    }

    Function("setLines") { viewTag: Int, lines: List<TerrainLine> ->
      val specs = lines.map { l ->
        val merc = DoubleArray(l.coords.size - l.coords.size % 2)
        var i = 0
        while (i + 1 < l.coords.size) {
          merc[i] = TerrainController.mercX(l.coords[i])
          merc[i + 1] = TerrainController.mercY(l.coords[i + 1])
          i += 2
        }
        LineSpec(l.id, merc, FloatArray(11) { k -> (l.style.getOrNull(k) ?: 0.0).toFloat() })
      }
      main.post { controllers[viewTag]?.setLines(specs) }
      Unit
    }

    Function("setDrapeStyle") { viewTag: Int, json: String ->
      main.post { controllers[viewTag]?.setDrapeStyle(json) }
      Unit
    }

    AsyncFunction("jumpTo") { viewTag: Int, lat: Double, lng: Double, zoom: Double, pitch: Double, bearing: Double ->
      controllers[viewTag]?.jumpTo(lat, lng, zoom, pitch, bearing)
      Unit
    }.runOnQueue(Queues.MAIN)

    Function("setPuck") { viewTag: Int, visible: Boolean, lng: Double, lat: Double ->
      main.post { controllers[viewTag]?.setPuck(visible, lng, lat) }
      Unit
    }

    AsyncFunction("detach") { viewTag: Int ->
      controllers.remove(viewTag)?.detach()
      Unit
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stats") { viewTag: Int ->
      controllers[viewTag]?.stats()?.toList() ?: emptyList()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setPitch") { viewTag: Int, deg: Double ->
      controllers[viewTag]?.setPitch(deg)
      Unit
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

  private fun look(config: TerrainConfig): FloatArray = FloatArray(TerrainNative.LOOK_FLOATS) { i -> (config.look.getOrNull(i) ?: 0.0).toFloat() }

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
