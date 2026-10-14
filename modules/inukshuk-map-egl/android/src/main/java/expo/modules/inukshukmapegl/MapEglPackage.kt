package expo.modules.inukshukmapegl

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewTreeObserver
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener
import expo.modules.inukshukmapegl.core.EmulatorSignals
import expo.modules.inukshukmapegl.core.emulatorEvidence
import java.io.File

/**
 * Installs [MapEglGuard] on every MapLibre map the activity shows, on the
 * Android EMULATOR only (#697: the use-after-free needs its goldfish EGL
 * driver; phones keep MapLibre's behaviour and no reflection runs there).
 * Maps are created by @maplibre/maplibre-react-native at any time, so the
 * guard looks for new ones after each layout pass; a layout pass runs before
 * a new SurfaceView's surface exists, so each map is guarded before its first
 * EGL surface is ever destroyed.
 */
class MapEglPackage : Package {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context,
  ): List<ReactActivityLifecycleListener> = listOf(Listener())

  private class Listener : ReactActivityLifecycleListener {
    override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
      if (!onEmulator) return
      val decor = activity.window.decorView
      decor.viewTreeObserver.addOnGlobalLayoutListener(
        ViewTreeObserver.OnGlobalLayoutListener { MapEglGuard.guardTree(decor) },
      )
    }
  }

  companion object {
    /** Read once per process; logged once either way. */
    val onEmulator: Boolean by lazy {
      val evidence =
        emulatorEvidence(
          EmulatorSignals(
            // Not readable without the hidden SystemProperties API; the
            // other signals cover every current emulator image.
            qemuProperty = null,
            hardware = Build.HARDWARE,
            fingerprint = Build.FINGERPRINT,
            product = Build.PRODUCT,
            emulationEglDriver =
              File("/vendor/lib64/egl/libEGL_emulation.so").exists() ||
                File("/vendor/lib/egl/libEGL_emulation.so").exists(),
          ),
        )
      if (evidence.isEmpty()) {
        Log.i(ReleasingWindowSurfaceFactory.TAG, "map EGL guard: not an emulator, skipped")
      } else {
        Log.i(ReleasingWindowSurfaceFactory.TAG, "map EGL guard: emulator (${evidence.joinToString()}), on")
      }
      evidence.isNotEmpty()
    }
  }
}
