package expo.modules.inukshukterrain

import androidx.annotation.Keep

/** Callbacks the C++ engine makes (from the render thread or its worker). */
@Keep
interface TerrainBridge {
  @Keep fun requestDem(z: Int, x: Int, y: Int)

  @Keep fun requestImagery(z: Int, x: Int, y: Int)

  @Keep fun requestRepaint()
}

/** JNI surface of libinukshukterrain (cpp/gles/terrain_gles.cpp). */
@Keep
object TerrainNative {
  init {
    System.loadLibrary("inukshukterrain")
  }

  /** Floats in a packed look (src/core/terrain3d/look.ts packLook) plus the debug flags. */
  const val LOOK_FLOATS = 41

  @JvmStatic external fun nativeCreate(bridge: TerrainBridge): Long

  @JvmStatic external fun nativeDestroy(handle: Long)

  /** A new CustomLayerHost*; ownership passes to MapLibre's CustomLayer. */
  @JvmStatic external fun nativeCreateHost(handle: Long): Long

  @JvmStatic external fun nativeSetEnabled(handle: Long, enabled: Boolean)

  /** [LOOK_FLOATS], see packLook. */
  @JvmStatic external fun nativeSetLook(handle: Long, look: FloatArray)

  @JvmStatic external fun nativeOnDemData(handle: Long, z: Int, x: Int, y: Int, png: ByteArray): Boolean

  @JvmStatic external fun nativeOnDemFailed(handle: Long, z: Int, x: Int, y: Int)

  /** 256² RGBA8 satellite pixels, or null when the tile failed. */
  @JvmStatic external fun nativeOnImageryData(handle: Long, z: Int, x: Int, y: Int, rgba: ByteArray?)

  /**
   * 11 doubles per label: id, mercX, mercY, kind, priority, w, h, u0, v0, u1, v1; `ink`
   * (rgb) colours the stems and ground dots.
   */
  @JvmStatic external fun nativeSetLabels(handle: Long, values: DoubleArray, ink: FloatArray)

  /** Premultiplied RGBA8 pixels into the label sprite atlas (2048²) at x, y. */
  @JvmStatic external fun nativeUploadSprite(handle: Long, x: Int, y: Int, w: Int, h: Int, rgba: ByteArray)

  /** merc: x, y pairs (0–1); style: color rgba, halo rgba, width, haloWidth, order. */
  @JvmStatic external fun nativeSetPolyline(handle: Long, id: Int, merc: DoubleArray, style: FloatArray)

  @JvmStatic external fun nativeRemovePolyline(handle: Long, id: Int)

  @JvmStatic external fun nativeSetPuck(handle: Long, visible: Boolean, mercX: Double, mercY: Double)

  /** Rings as flat mercator x, y pairs plus the point count of each ring. */
  @JvmStatic external fun nativeSetMasks(
    handle: Long,
    waterXY: DoubleArray,
    waterCounts: IntArray,
    iceXY: DoubleArray,
    iceCounts: IntArray,
  )

  @JvmStatic external fun nativeTrimMemory(handle: Long)

  @JvmStatic external fun nativeSetRecording(handle: Long, on: Boolean)

  @JvmStatic external fun nativeTakeFrameTimes(handle: Long, costs: Boolean): LongArray

  /**
   * [demCount, demBytes, meshCount, drawnTiles, flatTiles, inFlight, requested, failed,
   * engineCpuMs, drawMs, pitchDeg, gpuTileSlots, labelsShown, imagerySlots, bakeQueue]
   */
  @JvmStatic external fun nativeStats(handle: Long): DoubleArray
}
