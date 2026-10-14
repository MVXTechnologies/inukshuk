package expo.modules.inukshukmapegl.core

/**
 * The order MapLibre's GL thread must follow to destroy a window surface (#697).
 *
 * MapLibre's EglHelper unbinds a surface with eglMakeCurrent(NO_SURFACE,
 * NO_SURFACE, its context): a surfaceless bind. A driver without
 * EGL_KHR_surfaceless_context refuses it (EGL_BAD_MATCH; the emulator's
 * goldfish EGL does), MapLibre ignores the failure, and destroys a surface
 * that is still current. EGL then defers the destroy, but libEGL disconnects
 * the window at once, freeing the buffer the surface still holds; the
 * deferred destroy, run by the next eglMakeCurrent, cancels that freed
 * buffer: a use-after-free in libgui (Surface::cancelBuffer).
 *
 * The fix is AOSP GLSurfaceView's own order: when the surface is still
 * current, release the context completely (NO_SURFACE, NO_SURFACE,
 * NO_CONTEXT, valid on every driver) before destroying it. When the
 * surfaceless bind worked the surface is no longer current and nothing
 * changes, so drivers with surfaceless contexts (most phones) keep their
 * exact behaviour.
 *
 * Pure (no Android types), so it runs on a plain JVM: see
 * src/test/.../SurfaceTeardownTest.kt.
 */
class SurfaceTeardown<S : Any>(
  private val currentDraw: () -> S?,
  private val currentRead: () -> S?,
  /** eglMakeCurrent(NO_SURFACE, NO_SURFACE, NO_CONTEXT); false when EGL refused it. */
  private val releaseContext: () -> Boolean,
  private val destroy: (S) -> Unit,
) {
  /** What [destroySurface] had to do before destroying. */
  enum class Outcome {
    /** The surface was not current: destroyed as MapLibre asked. */
    NOT_CURRENT,
    /** Still current: the context was released first, then destroyed. */
    RELEASED,
    /** Still current and the release failed: destroyed anyway (EGL defers it). */
    RELEASE_FAILED,
  }

  fun destroySurface(surface: S): Outcome {
    val stillCurrent = surface == currentDraw() || surface == currentRead()
    val outcome =
      when {
        !stillCurrent -> Outcome.NOT_CURRENT
        releaseContext() -> Outcome.RELEASED
        else -> Outcome.RELEASE_FAILED
      }
    destroy(surface)
    return outcome
  }
}

/**
 * Depth-first walk of a view tree (or any tree), collecting the nodes
 * [match] accepts. Generic so the walk is tested without Android views.
 */
fun <T> collectMatching(root: T, children: (T) -> List<T>, match: (T) -> Boolean): List<T> {
  val found = ArrayList<T>()
  val stack = ArrayDeque<T>()
  stack.addLast(root)
  while (stack.isNotEmpty()) {
    val node = stack.removeLast()
    if (match(node)) found.add(node)
    for (child in children(node)) stack.addLast(child)
  }
  return found
}
