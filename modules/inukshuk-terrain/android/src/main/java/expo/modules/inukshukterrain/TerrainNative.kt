package expo.modules.inukshukterrain

import androidx.annotation.Keep

/** Callbacks the C++ engine makes (from the render thread or DEM workers). */
@Keep
interface TerrainBridge {
  @Keep fun requestDem(z: Int, x: Int, y: Int)

  @Keep fun requestRepaint()
}

/** JNI surface of libinukshukterrain (cpp/gles/terrain_gles.cpp). */
@Keep
object TerrainNative {
  init {
    System.loadLibrary("inukshukterrain")
  }

  @JvmStatic external fun nativeCreate(bridge: TerrainBridge): Long

  @JvmStatic external fun nativeDestroy(handle: Long)

  /** A new CustomLayerHost*; ownership passes to MapLibre's CustomLayer. */
  @JvmStatic external fun nativeCreateHost(handle: Long): Long

  @JvmStatic external fun nativeSetEnabled(handle: Long, enabled: Boolean)

  /** [exaggeration, fog rgb, horizon rgb, zenith rgb, form, fogStart, fogDensity, fogEnd] */
  @JvmStatic external fun nativeSetLook(handle: Long, look: FloatArray)

  @JvmStatic external fun nativeOnDemData(handle: Long, z: Int, x: Int, y: Int, png: ByteArray): Boolean

  @JvmStatic external fun nativeOnDemFailed(handle: Long, z: Int, x: Int, y: Int)

  @JvmStatic external fun nativeTrimMemory(handle: Long)

  @JvmStatic external fun nativeSetRecording(handle: Long, on: Boolean)

  @JvmStatic external fun nativeTakeFrameTimes(handle: Long, costs: Boolean): LongArray

  /**
   * [demCount, demBytes, meshCount, drawnTiles, flatTiles, inFlight, requested, failed,
   * engineCpuMs, drawMs, pitchDeg, gpuTileBuffers]
   */
  @JvmStatic external fun nativeStats(handle: Long): DoubleArray
}
