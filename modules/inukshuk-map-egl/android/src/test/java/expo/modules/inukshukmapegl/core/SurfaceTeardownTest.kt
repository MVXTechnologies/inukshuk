package expo.modules.inukshukmapegl.core

// Plain-JVM checks of the teardown order (scripts/test-android.sh). A fake
// EGL: `current` is what eglGetCurrentSurface returns, and every call lands
// in `log` so the order is asserted, not just the outcome.

private class FakeEgl(var current: String?, private val releaseWorks: Boolean = true) {
  val log = mutableListOf<String>()
  val teardown =
    SurfaceTeardown(
      currentDraw = { current },
      currentRead = { current },
      releaseContext = {
        log.add("release")
        if (releaseWorks) current = null
        releaseWorks
      },
      destroy = { log.add("destroy $it") },
    )
}

private fun check(label: String, ok: Boolean) {
  if (!ok) throw AssertionError(label)
  println("ok - $label")
}

fun main() {
  // Surfaceless bind worked (phones): MapLibre's own unbind left nothing current.
  FakeEgl(current = null).run {
    val out = teardown.destroySurface("old")
    check("not current: destroyed as asked", out == SurfaceTeardown.Outcome.NOT_CURRENT)
    check("not current: no extra EGL call", log == listOf("destroy old"))
  }
  // Another surface current: not ours to unbind.
  FakeEgl(current = "other").run {
    val out = teardown.destroySurface("old")
    check("other surface current: untouched", out == SurfaceTeardown.Outcome.NOT_CURRENT)
    check("other surface current: still current", current == "other")
  }
  // Goldfish: the surfaceless bind failed, the surface is still current.
  FakeEgl(current = "old").run {
    val out = teardown.destroySurface("old")
    check("still current: released", out == SurfaceTeardown.Outcome.RELEASED)
    check("still current: release BEFORE destroy", log == listOf("release", "destroy old"))
    check("still current: nothing current after", current == null)
  }
  // Release refused too: still destroy (EGL defers it), and report it.
  FakeEgl(current = "old", releaseWorks = false).run {
    val out = teardown.destroySurface("old")
    check("release refused: reported", out == SurfaceTeardown.Outcome.RELEASE_FAILED)
    check("release refused: destroyed anyway", log == listOf("release", "destroy old"))
  }
  // Only the read side current (a split draw/read bind) still counts.
  run {
    val log = mutableListOf<String>()
    val out =
      SurfaceTeardown(
          currentDraw = { "draw" },
          currentRead = { "old" },
          releaseContext = { log.add("release"); true },
          destroy = { log.add("destroy $it") },
        )
        .destroySurface("old")
    check("read-current: released", out == SurfaceTeardown.Outcome.RELEASED)
  }

  // The tree walk finds every match, nested or not, and nothing else.
  val tree =
    mapOf(
      "root" to listOf("a", "map1"),
      "a" to listOf("b", "map2"),
      "b" to listOf("map3"),
    )
  val maps =
    collectMatching("root", children = { tree[it] ?: emptyList() }, match = { it.startsWith("map") })
  check("walk: all maps found", maps.sorted() == listOf("map1", "map2", "map3"))
  check("walk: no match, empty", collectMatching("x", { emptyList() }, { false }).isEmpty())
}
