package expo.modules.inukshukterrain

import android.os.SystemClock
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import kotlin.math.cos
import kotlin.math.sin

/**
 * The fluidity harness: drives REAL gestures through MapLibre's own gesture
 * detectors by synthesising MotionEvents on the map view, one per vsync —
 * a continuous two-finger tilt, a two-finger rotation, a one-finger pan and
 * flings. The terrain layer records a timestamp per rendered frame while it
 * runs (TerrainController.setRecording), so the harness measures exactly the
 * frames MapLibre produced.
 */
class GestureBench(private val view: View, private val onDone: () -> Unit) : Choreographer.FrameCallback {
  data class Step(val kind: String, val durationMs: Long, val amount: Float)

  private val steps = ArrayDeque<Step>()
  private var current: Step? = null
  private var stepStart = 0L
  private var downTime = 0L
  private var pointers = 0
  private val cx get() = view.width / 2f
  private val cy get() = view.height / 2f
  private val density = view.resources.displayMetrics.density

  fun start(script: List<Step>) {
    steps.clear()
    steps.addAll(script)
    Choreographer.getInstance().postFrameCallback(this)
  }

  override fun doFrame(frameTimeNanos: Long) {
    val now = SystemClock.uptimeMillis()
    var step = current
    if (step == null) {
      step = steps.removeFirstOrNull()
      if (step == null) {
        onDone()
        return
      }
      current = step
      stepStart = now
      begin(step, now)
    }
    val t = ((now - stepStart).toFloat() / step.durationMs).coerceIn(0f, 1f)
    move(step, t, now)
    if (t >= 1f) {
      end(step, now)
      current = null
    }
    Choreographer.getInstance().postFrameCallback(this)
  }

  // Two fingers 120 dp apart, horizontally (a shove needs them level).
  private fun twoFinger(step: Step, t: Float): Array<Pair<Float, Float>> {
    val half = 60f * density
    return when (step.kind) {
      "pitch" -> {
        // amount = total vertical travel in dp; up then back down halfway
        val travel = step.amount * density
        val y = cy + 80f * density - travel * (if (t < 0.6f) t / 0.6f else 1f - (t - 0.6f) / 0.8f)
        arrayOf(cx - half to y, cx + half to y)
      }
      "rotate" -> {
        val a = Math.toRadians((step.amount * t).toDouble())
        val r = 110f * density
        arrayOf(
          (cx - r * cos(a)).toFloat() to (cy - r * sin(a)).toFloat(),
          (cx + r * cos(a)).toFloat() to (cy + r * sin(a)).toFloat(),
        )
      }
      // Round 3 disambiguation tests: each gesture with the other cues as noise.
      "tiltnoisy" -> {
        // a tilt (amount dp up) whose finger line turns 6° and spreads 5 %
        val y = cy + 80f * density - step.amount * density * t
        val a = Math.toRadians(6.0 * t)
        val h = half * (1f + 0.05f * t)
        arrayOf(
          (cx - h * cos(a)).toFloat() to (y - h * sin(a)).toFloat(),
          (cx + h * cos(a)).toFloat() to (y + h * sin(a)).toFloat(),
        )
      }
      "rotatenoisy" -> {
        // a turn of amount° with a 10 dp vertical slide and 4 % spread
        val a = Math.toRadians((step.amount * t).toDouble())
        val r = 110f * density * (1f + 0.04f * t)
        val y = cy - 10f * density * t
        arrayOf(
          (cx - r * cos(a)).toFloat() to (y - r * sin(a)).toFloat(),
          (cx + r * cos(a)).toFloat() to (y + r * sin(a)).toFloat(),
        )
      }
      "pinchnoisy" -> {
        // a spread by amount (×) with a 5° turn and a 12 dp vertical slide
        val k = 1f + (step.amount - 1f) * t
        val a = Math.toRadians(5.0 * t)
        val r = 80f * density * k
        val y = cy - 12f * density * t
        arrayOf(
          (cx - r * cos(a)).toFloat() to (y - r * sin(a)).toFloat(),
          (cx + r * cos(a)).toFloat() to (y + r * sin(a)).toFloat(),
        )
      }
      else -> arrayOf(cx to cy)
    }
  }

  private fun onePoint(step: Step, t: Float): Pair<Float, Float> {
    val travel = step.amount * density
    return when (step.kind) {
      "pan" -> {
        // a slow figure-eight-ish loop
        val a = 2 * Math.PI * t
        (cx + travel * sin(a).toFloat()) to (cy + travel * 0.6f * sin(2 * a).toFloat())
      }
      else -> (cx to cy + travel * 0.5f - travel * t) // fling: fast straight up
    }
  }

  private fun begin(step: Step, now: Long) {
    downTime = now
    if (step.kind == "pitch" || step.kind == "rotate" || step.kind.endsWith("noisy")) {
      val p = twoFinger(step, 0f)
      dispatch(MotionEvent.ACTION_DOWN, now, arrayOf(p[0]))
      dispatch(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), now, p)
      pointers = 2
    } else if (step.kind == "pan" || step.kind == "fling") {
      dispatch(MotionEvent.ACTION_DOWN, now, arrayOf(onePoint(step, 0f)))
      pointers = 1
    } else {
      pointers = 0 // "idle"
    }
  }

  private fun move(step: Step, t: Float, now: Long) {
    when (pointers) {
      2 -> dispatch(MotionEvent.ACTION_MOVE, now, twoFinger(step, t))
      1 -> dispatch(MotionEvent.ACTION_MOVE, now, arrayOf(onePoint(step, t)))
    }
  }

  private fun end(step: Step, now: Long) {
    when (pointers) {
      2 -> {
        val p = twoFinger(step, 1f)
        dispatch(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), now, p)
        dispatch(MotionEvent.ACTION_UP, now, arrayOf(p[0]))
      }
      1 -> dispatch(MotionEvent.ACTION_UP, now, arrayOf(onePoint(step, 1f)))
    }
    pointers = 0
  }

  private fun dispatch(action: Int, now: Long, pts: Array<Pair<Float, Float>>) {
    val props = Array(pts.size) { i ->
      MotionEvent.PointerProperties().apply {
        id = i
        toolType = MotionEvent.TOOL_TYPE_FINGER
      }
    }
    val coords = Array(pts.size) { i ->
      MotionEvent.PointerCoords().apply {
        x = pts[i].first
        y = pts[i].second
        pressure = 1f
        size = 1f
      }
    }
    val ev = MotionEvent.obtain(downTime, now, action, pts.size, props, coords, 0, 0, 1f, 1f, 0, 0, 0, 0)
    view.dispatchTouchEvent(ev)
    ev.recycle()
  }

  companion object {
    /** The standard script: tilt, rotate, pan, three flings, with settles between. */
    fun standardScript(): List<Step> = listOf(
      Step("idle", 600, 0f),
      Step("pitch", 3000, 260f),
      Step("idle", 300, 0f),
      Step("rotate", 3500, 300f),
      Step("idle", 300, 0f),
      Step("pan", 4000, 120f),
      Step("idle", 300, 0f),
      Step("fling", 120, 220f),
      Step("idle", 900, 0f),
      Step("fling", 120, -220f),
      Step("idle", 900, 0f),
      Step("fling", 120, 220f),
      Step("idle", 1200, 0f),
    )
  }
}
