package expo.modules.inukshukterrain

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.gestures.BaseGesture
import org.maplibre.android.gestures.ShoveGestureDetector
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.style.layers.CustomLayer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * One map's native 3D terrain: owns the C++ engine handle, keeps the custom
 * layer on top of the style (RN re-inserts its component layers after every
 * style load), raises the pitch ceiling to 80° and lets the two-finger tilt
 * gesture past MapLibre's hard-coded 60°, and feeds DEM tiles. All camera
 * work stays inside MapLibre — nothing here runs per frame on the JS thread.
 */
class TerrainController(
  context: Context,
  val mapView: MapView,
  val map: MapLibreMap,
) : TerrainBridge {
  private val main = Handler(Looper.getMainLooper())
  private val lock = ReentrantReadWriteLock()
  private var handle: Long = TerrainNative.nativeCreate(this)
  private val destroyed = AtomicBoolean(false)
  private val repaintPosted = AtomicBoolean(false)
  private val fetcher = DemFetcher(context) { z, x, y, bytes -> deliver(z, x, y, bytes) }
  private var layer: CustomLayer? = null
  private var originalShove: ShoveGestureDetector.OnShoveGestureListener? = null
  private var maxPitch = 80.0
  private var enabled = true
  private val defaultLodScale = map.tileLodScale
  private val defaultLodMinRadius = map.tileLodMinRadius

  private val styleListener = MapView.OnDidFinishLoadingStyleListener { ensureOnTop() }
  private val watcher = object : Runnable {
    override fun run() {
      if (destroyed.get()) return
      ensureOnTop()
      main.postDelayed(this, WATCH_MS)
    }
  }

  fun attach(look: FloatArray, enabled: Boolean, networkAllowed: Boolean, maxPitch: Double) {
    this.maxPitch = maxPitch
    update(look, enabled, networkAllowed)
    setCoreMaxPitch(if (enabled) maxPitch else LEGACY_MAX_PITCH)
    applyTileLod(enabled)
    installShoveExtension()
    mapView.addOnDidFinishLoadingStyleListener(styleListener)
    ensureOnTop()
    main.postDelayed(watcher, WATCH_MS)
  }

  fun update(look: FloatArray, enabled: Boolean, networkAllowed: Boolean) {
    lock.read {
      if (destroyed.get()) return
      TerrainNative.nativeSetLook(handle, look)
      TerrainNative.nativeSetEnabled(handle, enabled)
    }
    fetcher.networkAllowed = networkAllowed
    if (this.enabled != enabled) {
      this.enabled = enabled
      setCoreMaxPitch(if (enabled) maxPitch else LEGACY_MAX_PITCH)
      applyTileLod(enabled)
    }
    map.triggerRepaint()
  }

  fun detach() {
    if (!destroyed.compareAndSet(false, true)) return
    main.removeCallbacks(watcher)
    mapView.removeOnDidFinishLoadingStyleListener(styleListener)
    restoreShove()
    setCoreMaxPitch(LEGACY_MAX_PITCH)
    applyTileLod(false)
    if (map.cameraPosition.tilt > LEGACY_MAX_PITCH) {
      map.moveCamera(CameraUpdateFactory.tiltTo(LEGACY_MAX_PITCH))
    }
    try {
      map.style?.removeLayer(LAYER_ID)
    } catch (e: Exception) {
      Log.w(TAG, "removeLayer failed", e)
    }
    layer = null
    fetcher.shutdown()
    lock.write {
      TerrainNative.nativeDestroy(handle)
      handle = 0
    }
    map.triggerRepaint()
  }

  fun trimMemory() = lock.read { if (!destroyed.get()) TerrainNative.nativeTrimMemory(handle) }

  fun stats(): DoubleArray = lock.read {
    if (destroyed.get()) DoubleArray(0) else TerrainNative.nativeStats(handle)
  }

  fun setRecording(on: Boolean) = lock.read {
    if (!destroyed.get()) TerrainNative.nativeSetRecording(handle, on)
  }

  fun takeFrameTimes(costs: Boolean): LongArray = lock.read {
    if (destroyed.get()) LongArray(0) else TerrainNative.nativeTakeFrameTimes(handle, costs)
  }

  // ---- TerrainBridge (any thread) ---------------------------------------------

  override fun requestDem(z: Int, x: Int, y: Int) {
    if (!destroyed.get()) fetcher.fetch(z, x, y)
  }

  override fun requestRepaint() {
    if (destroyed.get() || !repaintPosted.compareAndSet(false, true)) return
    main.post {
      repaintPosted.set(false)
      if (!destroyed.get()) map.triggerRepaint()
    }
  }

  private fun deliver(z: Int, x: Int, y: Int, bytes: ByteArray?) {
    lock.read {
      if (destroyed.get()) return
      if (bytes == null || !TerrainNative.nativeOnDemData(handle, z, x, y, bytes)) {
        if (bytes != null) java.io.File(mapView.context.cacheDir, "dem/dem-$z-$x-$y.png").delete()
        TerrainNative.nativeOnDemFailed(handle, z, x, y)
      }
    }
  }

  // ---- the layer stays on top of the style -------------------------------------

  private fun ensureOnTop() {
    if (destroyed.get()) return
    val style = map.style ?: return
    if (!style.isFullyLoaded) return
    try {
      val layers = style.layers
      if (layers.isNotEmpty() && layers.last().id == LAYER_ID) return
      if (style.getLayer(LAYER_ID) != null) style.removeLayer(LAYER_ID)
      val host = lock.read { if (destroyed.get()) 0L else TerrainNative.nativeCreateHost(handle) }
      if (host == 0L) return
      val l = CustomLayer(LAYER_ID, host)
      style.addLayer(l)
      layer = l
      map.triggerRepaint()
    } catch (e: Exception) {
      Log.w(TAG, "could not (re)insert the terrain layer", e)
    }
  }

  /**
   * Past ~60° MapLibre itself renders tiles out to the horizon; in 3D that far
   * band is fog, so let MapLibre's pitch LOD coarsen it sooner (its own
   * knobs, restored on detach).
   */
  private fun applyTileLod(on: Boolean) {
    try {
      map.tileLodScale = if (on) LOD_SCALE_3D else defaultLodScale
      map.tileLodMinRadius = if (on) LOD_MIN_RADIUS_3D else defaultLodMinRadius
    } catch (e: Exception) {
      Log.w(TAG, "tile LOD not set", e)
    }
  }

  // ---- pitch ceiling --------------------------------------------------------------

  /**
   * MapLibre's core accepts up to 180°, but `Transform.setMaxPitch` rejects
   * anything above `MapLibreConstants.MAXIMUM_PITCH` (60). Go to the native
   * setter (`@Keep`, JNI-registered) directly.
   */
  private fun setCoreMaxPitch(deg: Double) {
    try {
      val f = MapLibreMap::class.java.getDeclaredField("nativeMapView")
      f.isAccessible = true
      val native = f.get(map) ?: return
      val m = native.javaClass.getDeclaredMethod("nativeSetMaxPitch", Double::class.javaPrimitiveType)
      m.isAccessible = true
      m.invoke(native, deg)
    } catch (e: Exception) {
      Log.w(TAG, "max pitch not raised", e)
    }
  }

  /** Programmatic pitch past 60 (CameraPosition.Builder clamps to 60; QA camera). */
  fun setPitch(deg: Double) = setTiltDirect(deg.coerceIn(0.0, if (enabled) maxPitch else LEGACY_MAX_PITCH))

  private fun setTiltDirect(deg: Double) {
    try {
      val gt = MapLibreMap::class.java.getDeclaredMethod("getTransform")
      gt.isAccessible = true
      val transform = gt.invoke(map) ?: return
      val st = transform.javaClass.getDeclaredMethod("setTilt", java.lang.Double::class.java)
      st.isAccessible = true
      st.invoke(transform, deg)
    } catch (e: Exception) {
      Log.w(TAG, "tilt not set", e)
    }
  }

  /**
   * MapLibre's shove (two-finger tilt) listener clamps to the compile-time
   * `MAXIMUM_TILT = 60`. Wrap it: below 60° it runs untouched (events,
   * cancellation, bookkeeping); past 60° we apply the same 0.1°/px rule up to
   * our ceiling.
   */
  private fun installShoveExtension() {
    try {
      val gm = map.gesturesManager
      val detector = gm.shoveGestureDetector
      val f = BaseGesture::class.java.getDeclaredField("listener")
      f.isAccessible = true
      @Suppress("UNCHECKED_CAST")
      val original = f.get(detector) as? ShoveGestureDetector.OnShoveGestureListener ?: return
      if (original is ShoveExtension) return
      originalShove = original
      gm.setShoveGestureListener(ShoveExtension(original))
    } catch (e: Exception) {
      Log.w(TAG, "shove extension not installed", e)
    }
  }

  private fun restoreShove() {
    val o = originalShove ?: return
    try {
      map.gesturesManager.setShoveGestureListener(o)
    } catch (_: Exception) {}
    originalShove = null
  }

  private inner class ShoveExtension(
    private val original: ShoveGestureDetector.OnShoveGestureListener,
  ) : ShoveGestureDetector.OnShoveGestureListener {
    override fun onShoveBegin(detector: ShoveGestureDetector): Boolean = original.onShoveBegin(detector)

    override fun onShove(detector: ShoveGestureDetector, deltaSinceLast: Float, deltaSinceStart: Float): Boolean {
      val ceiling = if (enabled && !destroyed.get()) maxPitch else LEGACY_MAX_PITCH
      val tilt = map.cameraPosition.tilt
      val target = (tilt - SHOVE_FACTOR * deltaSinceLast).coerceIn(0.0, ceiling)
      if (target <= LEGACY_MAX_PITCH && tilt <= LEGACY_MAX_PITCH) {
        return original.onShove(detector, deltaSinceLast, deltaSinceStart)
      }
      setTiltDirect(target)
      return true
    }

    override fun onShoveEnd(detector: ShoveGestureDetector, velocityX: Float, velocityY: Float) =
      original.onShoveEnd(detector, velocityX, velocityY)
  }

  companion object {
    const val TAG = "InukshukTerrain"
    const val LAYER_ID = "inukshuk-terrain-3d"
    const val LEGACY_MAX_PITCH = 60.0
    const val SHOVE_FACTOR = 0.1
    const val WATCH_MS = 400L
    const val LOD_SCALE_3D = 1.6
    const val LOD_MIN_RADIUS_3D = 2.0
  }
}
