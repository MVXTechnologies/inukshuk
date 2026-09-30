package expo.modules.inukshukmappitch

import android.view.View
import android.view.ViewGroup
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Raises the maximum camera pitch of the MapLibre maps on screen (#480).
 *
 * @maplibre/maplibre-react-native 11.4 exposes no max-pitch prop, so every
 * map keeps MapLibre Native's default 60° (MapLibreConstants.MAXIMUM_PITCH);
 * the core accepts more (Transform::setMaxPitch clamps only to 180°). JS calls
 * [setMaxPitch] once a map has finished loading; this walks the activity's
 * view tree and, on every MLRN map view whose MapLibreMap is ready, calls
 * `MapLibreMap.setMaxPitchPreference(degrees)`.
 *
 * By REFLECTION on purpose: this module then needs no compile-time MapLibre
 * dependency (no version to keep in step with the RN wrapper's), and a
 * renamed method degrades to "still 60°" instead of a build break or a crash —
 * every failure is caught and the map is simply not counted.
 */
class InukshukMapPitchModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("InukshukMapPitch")

    // View-tree access and MapLibreMap calls both belong on the UI thread.
    AsyncFunction("setMaxPitch") { degrees: Double ->
      val root = appContext.currentActivity?.window?.decorView ?: return@AsyncFunction 0
      var applied = 0
      forEachView(root) { view ->
        if (applyMaxPitch(view, degrees)) applied++
      }
      applied
    }.runOnQueue(Queues.MAIN)
  }

  private fun forEachView(view: View, visit: (View) -> Unit) {
    visit(view)
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        view.getChildAt(i)?.let { forEachView(it, visit) }
      }
    }
  }

  /**
   * MLRNMapView (extends org.maplibre.android.maps.MapView) has a public
   * `mapLibreMap` property, null until the map is ready.
   */
  private fun applyMaxPitch(view: View, degrees: Double): Boolean {
    if (!isMapLibreMapView(view.javaClass)) return false
    return try {
      val map = view.javaClass.getMethod("getMapLibreMap").invoke(view) ?: return false
      map.javaClass
        .getMethod("setMaxPitchPreference", java.lang.Double.TYPE)
        .invoke(map, degrees)
      true
    } catch (_: Exception) {
      false
    }
  }

  private fun isMapLibreMapView(cls: Class<*>): Boolean {
    var c: Class<*>? = cls
    while (c != null) {
      if (c.name == MAPLIBRE_MAP_VIEW) return true
      c = c.superclass
    }
    return false
  }

  private companion object {
    const val MAPLIBRE_MAP_VIEW = "org.maplibre.android.maps.MapView"
  }
}
