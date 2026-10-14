package expo.modules.inukshukmapegl

import android.opengl.GLSurfaceView
import android.util.Log
import android.view.View
import android.view.ViewGroup
import expo.modules.inukshukmapegl.core.SurfaceTeardown
import expo.modules.inukshukmapegl.core.collectMatching
import java.lang.reflect.Field
import java.util.Collections
import java.util.WeakHashMap
import javax.microedition.khronos.egl.EGL10
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.egl.EGLDisplay
import javax.microedition.khronos.egl.EGLSurface

/**
 * Wraps MapLibre's EGL window-surface factory so a surface still current at
 * destroy time is unbound first (#697; the why is in core/SurfaceTeardown).
 */
internal class ReleasingWindowSurfaceFactory(
  val delegate: GLSurfaceView.EGLWindowSurfaceFactory,
) : GLSurfaceView.EGLWindowSurfaceFactory {
  override fun createWindowSurface(
    egl: EGL10,
    display: EGLDisplay,
    config: EGLConfig,
    nativeWindow: Any?,
  ): EGLSurface? = delegate.createWindowSurface(egl, display, config, nativeWindow)

  override fun destroySurface(egl: EGL10, display: EGLDisplay, surface: EGLSurface) {
    val outcome =
      SurfaceTeardown(
          currentDraw = { egl.eglGetCurrentSurface(EGL10.EGL_DRAW) },
          currentRead = { egl.eglGetCurrentSurface(EGL10.EGL_READ) },
          releaseContext = {
            egl.eglMakeCurrent(
              display,
              EGL10.EGL_NO_SURFACE,
              EGL10.EGL_NO_SURFACE,
              EGL10.EGL_NO_CONTEXT,
            )
          },
          destroy = { delegate.destroySurface(egl, display, it) },
        )
        .destroySurface(surface)
    when (outcome) {
      SurfaceTeardown.Outcome.NOT_CURRENT -> Unit
      // Logged every time: on the emulator this marks each avoided
      // use-after-free, which is what the E2E stress counts.
      SurfaceTeardown.Outcome.RELEASED ->
        Log.i(TAG, "released a still-current map surface before destroying it")
      SurfaceTeardown.Outcome.RELEASE_FAILED ->
        Log.e(TAG, "could not release a still-current map surface: 0x" +
          Integer.toHexString(egl.eglGetError()))
    }
  }

  companion object {
    const val TAG = "InukshukMapEgl"
  }
}

/**
 * Finds MapLibre's GL surface views in a view tree and installs the
 * releasing factory on each, once. Runs on the UI thread.
 */
internal object MapEglGuard {
  private const val SURFACE_VIEW =
    "org.maplibre.android.maps.renderer.surfaceview.MapLibreGLSurfaceView"
  private const val FACTORY_FIELD = "eglWindowSurfaceFactory"

  private val guarded: MutableSet<View> = Collections.newSetFromMap(WeakHashMap())
  private var surfaceClass: Class<*>? = null
  private var factoryField: Field? = null
  private var broken = false

  private fun resolve(): Boolean {
    if (broken) return false
    if (factoryField != null) return true
    return try {
      val cls = Class.forName(SURFACE_VIEW)
      val field = cls.getDeclaredField(FACTORY_FIELD)
      field.isAccessible = true
      surfaceClass = cls
      factoryField = field
      true
    } catch (e: ReflectiveOperationException) {
      // A MapLibre upgrade moved the field: say so loudly, once. The E2E
      // GWP-ASan stress is what then catches the crash coming back.
      broken = true
      Log.e(ReleasingWindowSurfaceFactory.TAG, "map EGL guard NOT installed: $e")
      false
    }
  }

  fun guardTree(root: View) {
    // Emulator only (#697): never reflect into MapLibre on a phone.
    if (!MapEglPackage.onEmulator) return
    if (!resolve()) return
    val cls = surfaceClass ?: return
    val field = factoryField ?: return
    val views =
      collectMatching(
        root,
        children = { v ->
          if (v is ViewGroup) List(v.childCount) { v.getChildAt(it) } else emptyList()
        },
        match = { cls.isInstance(it) && it !in guarded },
      )
    for (view in views) {
      try {
        val current = field.get(view) as? GLSurfaceView.EGLWindowSurfaceFactory ?: continue
        if (current !is ReleasingWindowSurfaceFactory) {
          // A plain reference swap. The GL thread reads the field only after
          // taking the render-thread lock, which surfaceCreated also takes on
          // this thread, so it sees the wrapper before its first destroy.
          field.set(view, ReleasingWindowSurfaceFactory(current))
        }
        guarded.add(view)
      } catch (e: ReflectiveOperationException) {
        broken = true
        Log.e(ReleasingWindowSurfaceFactory.TAG, "map EGL guard NOT installed: $e")
        return
      }
    }
  }
}
