package expo.modules.inukshukterrain

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.util.Log
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.sources.VectorSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.MultiPolygon
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon
import java.nio.ByteBuffer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.tan

/** Label theme: plate fill (rgba), ink, muted ink, water ink (rgb), 0–1. */
data class LabelTheme(
  val plate: FloatArray = floatArrayOf(0.97f, 0.95f, 0.91f, 0.94f),
  val ink: FloatArray = floatArrayOf(0.17f, 0.15f, 0.12f),
  val muted: FloatArray = floatArrayOf(0.42f, 0.39f, 0.34f),
  val water: FloatArray = floatArrayOf(0.25f, 0.45f, 0.6f),
) {
  companion object {
    fun from(v: List<Double>): LabelTheme {
      if (v.size < 13) return LabelTheme()
      val f = v.map { it.toFloat() }
      return LabelTheme(f.subList(0, 4).toFloatArray(), f.subList(4, 7).toFloatArray(),
        f.subList(7, 10).toFloatArray(), f.subList(10, 13).toFloatArray())
    }
  }
}

/**
 * What the 3D scene shows besides the terrain, read from the vector tiles
 * MapLibre already loaded (no extra downloads, nothing per frame):
 *
 * - pin labels — summits (our peaks tiles: banded rank, #549), places (by
 *   `min_zoom`), huts/shelters/viewpoints and named lakes — rendered once
 *   each into a sprite atlas as paper plates in Atkinson, then handed to the
 *   engine, which places, declutters, fades and occludes them every frame;
 * - water and glacier polygons, the surface's per-tile masks.
 *
 * Refreshed on camera idle and, while the camera moves in 3D, every
 * [REFRESH_MS]. Queries run on the main thread (MapLibre's rule); sprite
 * rasterising runs on a worker.
 */
class SceneSource(
  context: Context,
  private val map: MapLibreMap,
  /** The map view (its size bounds the label footprint). */
  private val view: android.view.View,
  private val sink: Sink,
) {
  interface Sink {
    fun uploadSprite(x: Int, y: Int, w: Int, h: Int, rgba: ByteArray)

    /** `keepMissing`: pins absent from this set stay a while (their tile is reloading); false after an atlas reset. */
    fun setLabels(values: DoubleArray, ink: FloatArray, keepMissing: Boolean)

    fun setMasks(waterXY: DoubleArray, waterCounts: IntArray, iceXY: DoubleArray, iceCounts: IntArray)
  }

  @Volatile var theme = LabelTheme()
  @Volatile var nameFields: List<String> = listOf("name")
  var labelsEnabled = true

  /** Under a drape the map paints its own water and glaciers: no masks needed. */
  @Volatile var masksWanted = true

  private val worker: ExecutorService = Executors.newSingleThreadExecutor { r ->
    Thread(r, "terrain-labels").apply {
      isDaemon = true
      priority = Thread.NORM_PRIORITY - 1
    }
  }
  private val scale = min(context.resources.displayMetrics.density, 2.0f)
  private val regular: Typeface = loadTypeface(context, 400)
  private val bold: Typeface = loadTypeface(context, 700)
  private val atlas = SpriteAtlas(ATLAS)
  private var themeKey = ""
  private var lastMaskHash = 0L
  private var lastLabelHash = 0L

  /** Main thread. */
  fun refresh() {
    val style = map.style ?: return
    if (!style.isFullyLoaded) return
    val candidates = ArrayList<Candidate>()
    var water: List<List<Point>> = emptyList()
    var ice: List<List<Point>> = emptyList()
    try {
      val base = style.getSourceAs<VectorSource>(BASEMAP)
      val peaks = style.getSourceAs<VectorSource>(PEAKS)
      if (labelsEnabled) {
        if (peaks != null) {
          for (f in peaks.querySourceFeatures(arrayOf("peaks"), null)) peak(f, true)?.let(candidates::add)
        } else if (base != null) {
          val isPeak = Expression.match(Expression.get("kind"), Expression.literal(false),
            Expression.stop("peak", true), Expression.stop("volcano", true))
          for (f in base.querySourceFeatures(arrayOf("pois"), isPeak)) peak(f, false)?.let(candidates::add)
        }
        if (base != null) {
          for (f in base.querySourceFeatures(arrayOf("places"), null)) place(f)?.let(candidates::add)
          for (f in base.querySourceFeatures(arrayOf("pois"), null)) poi(f)?.let(candidates::add)
          for (f in base.querySourceFeatures(arrayOf("water"), null)) lake(f)?.let(candidates::add)
        }
      }
      if (base != null && masksWanted) {
        water = rings(base.querySourceFeatures(arrayOf("water"), null))
        val isGlacier = Expression.eq(Expression.get("kind"), Expression.literal("glacier"))
        // Generalised glaciers at low zoom (landcover), the real outlines from z~10 (landuse).
        ice = rings(base.querySourceFeatures(arrayOf("landcover", "landuse"), isGlacier))
      }
    } catch (e: Exception) {
      Log.w(TAG, "scene query failed", e)
      return
    }
    // Keep what the view can show: the loaded vector tiles span far more than
    // the frame, and the atlas only takes the best MAX_LABELS. A generous 2D
    // footprint (relief lifts summits up the screen, so the band above the
    // top edge counts too). Twin of the iOS controller's filter.
    val proj = map.projection
    val w = view.width.toDouble()
    val h = view.height.toDouble()
    val inView = if (w > 0 && h > 0) {
      candidates.filter { c ->
        val p = proj.toScreenLocation(org.maplibre.android.geometry.LatLng(c.lat, c.lng))
        val x = p.x.toDouble()
        val y = p.y.toDouble()
        x.isFinite() && y.isFinite() && x >= -0.3 * w && x <= 1.3 * w && y >= -1.2 * h && y <= 1.3 * h
      }
    } else {
      candidates
    }
    val t = theme
    worker.execute {
      try {
        publishMasks(water, ice)
        publishLabels(inView, t)
      } catch (e: Throwable) {
        Log.w(TAG, "scene publish failed", e)
      }
    }
  }

  fun shutdown() {
    worker.shutdownNow()
  }

  // ---- candidates -------------------------------------------------------------

  private data class Candidate(
    val key: String,
    val kind: Int,
    val lng: Double,
    val lat: Double,
    val priority: Double,
    val title: String,
    val sub: String?,
    val major: Boolean,
  )

  private fun nameOf(f: Feature): String? {
    for (k in nameFields) {
      if (f.hasNonNullValueForProperty(k)) {
        val s = f.getStringProperty(k)
        if (!s.isNullOrBlank()) return s
      }
    }
    return if (f.hasNonNullValueForProperty("name")) f.getStringProperty("name") else null
  }

  private fun num(f: Feature, k: String): Double? =
    if (f.hasNonNullValueForProperty(k)) try { f.getNumberProperty(k)?.toDouble() } catch (_: Exception) { null } else null

  private fun str(f: Feature, k: String): String? =
    if (f.hasNonNullValueForProperty(k)) try { f.getStringProperty(k) } catch (_: Exception) { null } else null

  private fun pointOf(f: Feature): Point? = f.geometry() as? Point

  /** labels.ts peakPriority. */
  private fun peak(f: Feature, ours: Boolean): Candidate? {
    val p = pointOf(f) ?: return null
    val name = nameOf(f) ?: return null
    val ele = num(f, if (ours) "ele" else "elevation")
    val rank = if (ours) num(f, "rank") else null
    val pr = if (rank != null) {
      val e = ele ?: 0.0
      when {
        e >= 5000 -> -15.0 - kotlin.math.floor(e / 1000)
        e >= 4000 -> -kotlin.math.floor(e / 250)
        else -> rank
      }
    } else {
      12.0 - kotlin.math.floor((ele ?: 0.0) / 500) / 10
    }
    val sub = ele?.let { "${it.roundToInt()} m" }
    return Candidate("p|$name|${(p.latitude() * 1e3).roundToInt()}", KIND_PEAK, p.longitude(), p.latitude(), pr, name, sub, pr < 6)
  }

  /** labels.ts placePriority. */
  private fun place(f: Feature): Candidate? {
    val p = pointOf(f) ?: return null
    val name = nameOf(f) ?: return null
    val kind = str(f, "kind") ?: ""
    if (kind != "locality") return null
    val detail = str(f, "kind_detail")
    if (detail == "neighbourhood" || detail == "suburb") return null
    val mz = num(f, "min_zoom") ?: 14.0
    val bonus = if (detail == "city") -1.0 else if (detail == "town") -0.5 else 0.0
    return Candidate("c|$name", KIND_PLACE, p.longitude(), p.latitude(), mz + bonus, name, null,
      detail == "city" || detail == "town")
  }

  /** labels.ts poiPriority: huts, shelters, passes, viewpoints. */
  private fun poi(f: Feature): Candidate? {
    val kind = str(f, "kind") ?: return null
    if (kind !in POI_KINDS) return null
    val p = pointOf(f) ?: return null
    val name = nameOf(f) ?: return null
    val mz = num(f, "min_zoom") ?: 15.0
    return Candidate("i|$name|${(p.latitude() * 1e3).roundToInt()}", KIND_POI, p.longitude(), p.latitude(),
      14.0 + mz / 10, name, null, false)
  }

  /** Named lakes (the water layer's label points). */
  private fun lake(f: Feature): Candidate? {
    val p = pointOf(f) ?: return null
    val name = nameOf(f) ?: return null
    val kind = str(f, "kind") ?: ""
    if (kind != "lake" && kind != "water" && kind != "reservoir") return null
    val mz = num(f, "min_zoom") ?: 14.0
    return Candidate("w|$name", KIND_WATER, p.longitude(), p.latitude(), 12.0 + mz / 4, name, null, false)
  }

  // ---- labels -----------------------------------------------------------------

  private fun publishLabels(all: List<Candidate>, t: LabelTheme) {
    // Tiles repeat features across their buffers: one per key.
    val unique = LinkedHashMap<String, Candidate>()
    for (c in all) {
      val prev = unique[c.key]
      if (prev == null || c.priority < prev.priority) unique[c.key] = c
    }
    val chosen = unique.values.sortedBy { it.priority }.take(MAX_LABELS)
    val tk = t.plate.contentToString() + t.ink.contentToString() + nameFields
    var atlasReset = false
    if (tk != themeKey) {
      themeKey = tk
      atlas.reset()
      atlasReset = true
    }
    var hash = 1469598103934665603L
    for (c in chosen) hash = (hash xor c.key.hashCode().toLong()) * 1099511628211L
    if (hash == lastLabelHash && atlas.count > 0) return
    lastLabelHash = hash
    var rects = chosen.map { atlas.get(it.key) ?: render(it, t) }
    if (rects.any { it == null }) {
      // Atlas full: start over with only what is wanted now.
      atlas.reset()
      atlasReset = true
      rects = chosen.map { render(it, t) }
    }
    val v = DoubleArray(chosen.size * 11)
    var n = 0
    for ((i, c) in chosen.withIndex()) {
      val r = rects[i] ?: continue
      val o = n * 11
      v[o] = (c.key.hashCode() and 0x7fffffff).toDouble()
      v[o + 1] = (c.lng + 180.0) / 360.0
      v[o + 2] = mercY(c.lat)
      v[o + 3] = c.kind.toDouble()
      v[o + 4] = c.priority
      v[o + 5] = r.w / scale.toDouble()
      v[o + 6] = r.h / scale.toDouble()
      v[o + 7] = r.x / ATLAS.toDouble()
      v[o + 8] = r.y / ATLAS.toDouble()
      v[o + 9] = (r.x + r.w) / ATLAS.toDouble()
      v[o + 10] = (r.y + r.h) / ATLAS.toDouble()
      n++
    }
    sink.setLabels(v.copyOf(n * 11), t.ink, !atlasReset)
  }

  private fun color(c: FloatArray, a: Float = 1f): Int =
    Color.argb((a * 255).roundToInt(), (c[0] * 255).roundToInt(), (c[1] * 255).roundToInt(), (c[2] * 255).roundToInt())

  /** Rasterise a plate: name (and a summit's height) on a rounded paper card. */
  private fun render(c: Candidate, t: LabelTheme): SpriteAtlas.Rect? {
    val s = scale
    val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
      typeface = if (c.kind == KIND_POI || c.kind == KIND_WATER) regular else bold
      textSize = s * when (c.kind) {
        KIND_PLACE -> if (c.major) 13.5f else 12.5f
        KIND_PEAK -> 12f
        else -> 11f
      }
      color = when (c.kind) {
        KIND_WATER -> color(t.water)
        KIND_POI -> color(t.muted)
        else -> color(t.ink)
      }
      if (c.kind == KIND_WATER) textSkewX = -0.18f
    }
    val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      typeface = regular
      textSize = s * 9.5f
      color = color(t.muted)
    }
    val title = ellipsize(c.title, titlePaint, s * 150f)
    val padX = 5f * s
    val padY = 2.5f * s
    val gap = 0f
    val tw = titlePaint.measureText(title)
    val sw = c.sub?.let { subPaint.measureText(it) } ?: 0f
    val tfm = titlePaint.fontMetrics
    val sfm = subPaint.fontMetrics
    val th = tfm.descent - tfm.ascent
    val sh = if (c.sub != null) sfm.descent - sfm.ascent else 0f
    val w = (max(tw, sw) + padX * 2).roundToInt() + 2
    val h = (th + (if (c.sub != null) sh + gap else 0f) + padY * 2).roundToInt() + 2
    val rect = atlas.allocate(c.key, w, h) ?: return null
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val cv = Canvas(bmp)
    val plate = RectF(1f, 1f, w - 1f, h - 1f)
    val radius = 5f * s
    cv.drawRoundRect(plate, radius, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = color(t.plate, t.plate[3]) })
    cv.drawRoundRect(plate, radius, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = max(1f, 0.75f * s)
      color = color(t.ink, 0.22f)
    })
    var y = 1f + padY - tfm.ascent
    cv.drawText(title, (w - tw) / 2f, y, titlePaint)
    c.sub?.let {
      y += tfm.descent + gap - sfm.ascent
      cv.drawText(it, (w - sw) / 2f, y, subPaint)
    }
    val buf = ByteBuffer.allocate(w * h * 4)
    bmp.copyPixelsToBuffer(buf)  // premultiplied RGBA
    bmp.recycle()
    sink.uploadSprite(rect.x, rect.y, w, h, buf.array())
    return rect
  }

  private fun ellipsize(s: String, p: Paint, maxW: Float): String {
    if (p.measureText(s) <= maxW) return s
    var e = s
    while (e.length > 3 && p.measureText("$e…") > maxW) e = e.dropLast(1)
    return "$e…"
  }

  // ---- masks ------------------------------------------------------------------

  private fun rings(features: List<Feature>): List<List<Point>> {
    val out = ArrayList<List<Point>>()
    for (f in features) {
      when (val g = f.geometry()) {
        is Polygon -> g.coordinates().firstOrNull()?.let(out::add)
        is MultiPolygon -> g.coordinates().forEach { poly -> poly.firstOrNull()?.let(out::add) }
        else -> {}
      }
    }
    return out
  }

  private fun publishMasks(water: List<List<Point>>, ice: List<List<Point>>) {
    var hash = 1469598103934665603L
    fun pack(rings: List<List<Point>>): Pair<DoubleArray, IntArray> {
      var budget = MAX_MASK_POINTS
      val counts = ArrayList<Int>()
      val xy = ArrayList<Double>()
      for (r in rings.sortedByDescending { it.size }) {
        if (r.size < 3 || r.size > budget) continue
        budget -= r.size
        counts.add(r.size)
        for (p in r) {
          val x = (p.longitude() + 180.0) / 360.0
          val y = mercY(p.latitude())
          xy.add(x)
          xy.add(y)
          hash = (hash xor java.lang.Double.doubleToLongBits(x + y * 7.0)) * 1099511628211L
        }
      }
      return xy.toDoubleArray() to counts.toIntArray()
    }
    val (wxy, wc) = pack(water)
    val (ixy, ic) = pack(ice)
    if (hash == lastMaskHash) return
    lastMaskHash = hash
    sink.setMasks(wxy, wc, ixy, ic)
  }

  private fun mercY(lat: Double): Double {
    val l = lat.coerceIn(-85.05112878, 85.05112878) * PI / 180
    return 0.5 - ln(tan(PI / 4 + l / 2)) / (2 * PI)
  }

  /** Atkinson Hyperlegible Next (the expo-font XML family), else the system face. */
  private fun loadTypeface(context: Context, weight: Int): Typeface {
    val fallback = if (weight >= 600) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    return try {
      val res = context.resources
      val id = listOf("atkinsonhyperlegiblenext", "atkinson_hyperlegible_next")
        .map { res.getIdentifier(it, "font", context.packageName) }
        .firstOrNull { it != 0 } ?: return fallback
      if (Build.VERSION.SDK_INT < 26) return fallback
      val family = res.getFont(id)
      if (Build.VERSION.SDK_INT >= 28) Typeface.create(family, weight, false)
      else Typeface.create(family, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
    } catch (_: Exception) {
      fallback
    }
  }

  companion object {
    const val TAG = "InukshukTerrain"
    const val BASEMAP = "basemap-vector"
    const val PEAKS = "basemap-peaks"
    const val ATLAS = 2048
    const val MAX_LABELS = 220
    const val MAX_MASK_POINTS = 60_000
    const val KIND_PEAK = 0
    const val KIND_PLACE = 1
    const val KIND_POI = 2
    const val KIND_WATER = 3
    val POI_KINDS = setOf("alpine_hut", "wilderness_hut", "shelter", "viewpoint", "saddle", "mountain_pass", "camp_site")
  }
}

/** Shelf packer for the label sprites. */
class SpriteAtlas(private val size: Int) {
  data class Rect(val x: Int, val y: Int, val w: Int, val h: Int)

  private val rects = HashMap<String, Rect>()
  private var shelfY = 0
  private var shelfH = 0
  private var cursorX = 0
  val count get() = rects.size

  fun get(key: String): Rect? = rects[key]

  fun reset() {
    rects.clear()
    shelfY = 0
    shelfH = 0
    cursorX = 0
  }

  fun allocate(key: String, w: Int, h: Int): Rect? {
    rects[key]?.let { if (it.w == w && it.h == h) return it }
    if (w > size || h > size) return null
    if (cursorX + w > size) {
      shelfY += shelfH + 1
      shelfH = 0
      cursorX = 0
    }
    if (shelfY + h > size) return null
    val r = Rect(cursorX, shelfY, w, h)
    cursorX += w + 1
    shelfH = max(shelfH, h)
    rects[key] = r
    return r
  }
}
