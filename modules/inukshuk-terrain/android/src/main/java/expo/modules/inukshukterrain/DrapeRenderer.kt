package expo.modules.inukshukterrain

import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.snapshotter.MapSnapshot
import org.maplibre.android.snapshotter.MapSnapshotter
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.pow
import kotlin.math.sinh

/**
 * The per-tile drape (docs/plans/native-terrain.md, "Match Outmap"): each
 * terrain tile samples a texture of the 2D style rendered by MapLibre's own
 * offscreen renderer — the Android twin of the iOS controller's snapshot
 * pump. One snapshot renders a 2×2 block of tiles (four drapes), up to
 * [MAX_SNAPSHOTTERS] in parallel. Map: one zoom out at 2× (the 2D map at the
 * scale a terrain tile shows); satellite: the tile's zoom at 1×. Drape
 * textures are [texture]² px (by device memory); the mip chain is built natively.
 *
 * Threads: [request] from any thread; everything else on the main thread
 * (MapSnapshotter is a UI-thread API); pixels are copied on a worker.
 */
class DrapeRenderer(
  private val context: Context,
  /** z, x, y, rgba (null = failed), size, generation */
  private val deliver: (Int, Int, Int, ByteArray?, Int, Int) -> Unit,
  private val generation: () -> Int,
) {
  private class Job(val z: Int, val x: Int, val y: Int, val gen: Int)

  /** Draws no logo or attribution over the drape (the app credits its sources in Settings). */
  private class BareSnapshotter(context: Context, options: Options) : MapSnapshotter(context, options) {
    override fun addOverlay(mapSnapshot: MapSnapshot) = Unit
  }

  private val main = Handler(Looper.getMainLooper())
  private val jobs = ArrayDeque<Job>()
  private val snapshotters = ArrayList<MapSnapshotter>()
  private val busy = ArrayList<Boolean>()
  private val pixels: ExecutorService = Executors.newFixedThreadPool(2) { r ->
    Thread(r, "terrain-drape").apply {
      isDaemon = true
      priority = Thread.NORM_PRIORITY - 1
    }
  }
  private var styleJson: String? = null
  private var styleGen = 0
  private var shift = -1
  @Volatile private var closed = false
  private var rendered = 0
  /** Round 3 counters: snapshot renders and drape tiles served from the disk cache. */
  val renders = java.util.concurrent.atomic.AtomicInteger()
  val diskHits = java.util.concurrent.atomic.AtomicInteger()
  private val diskRoot = java.io.File(context.cacheDir, "terrain-drape-tiles")
  @Volatile private var tileDir: java.io.File? = null
  private var writes = 0
  private var msTotal = 0.0

  /**
   * Drape budget by device memory: enough slots for every tile in view plus
   * its fallbacks (≥ 128), with the texture size scaled instead —
   * 256² × 160 (~56 MB) under 4 GB, 512² × 128 (~179 MB) under 6 GB,
   * 512² × 160 (~224 MB) above. [full] (QA) forces the top tier.
   */
  private val lowTier: Pair<Int, Int> = run {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
    val info = ActivityManager.MemoryInfo()
    am?.getMemoryInfo(info)
    val gb = info.totalMem / (1L shl 30)
    when {
      am == null || am.isLowRamDevice || gb < 4 -> 256 to 160
      gb < 6 -> 512 to 128
      else -> 512 to 160
    }
  }
  @Volatile var full = false
  val texture: Int
    get() = if (full) 512 else lowTier.first
  val slotBudget: Int
    get() = if (full) 160 else lowTier.second

  val active: Boolean
    get() = styleJson != null

  /** Main thread. A new style (or base map) drops every snapshotter and queued job. */
  fun setStyle(json: String?, satellite: Boolean) {
    styleJson = json
    shift = if (satellite) 0 else -1
    // Drapes persist on disk per style and drape parameters: a revisit never re-renders.
    tileDir = json?.let {
      java.io.File(diskRoot, "${Integer.toHexString(it.hashCode())}-${it.length}-$texture-$shift").apply { mkdirs() }
    }
    styleGen++
    for (s in snapshotters) {
      try {
        s.cancel()
      } catch (_: Exception) {}
    }
    snapshotters.clear()
    busy.clear()
    jobs.clear()
  }

  /** Any thread: the engine wants the drape of tile z/x/y. */
  fun request(z: Int, x: Int, y: Int) {
    val gen = generation()
    main.post {
      if (closed) return@post
      if (styleJson == null) {
        deliver(z, x, y, null, texture, gen)
        return@post
      }
      val file = tileDir?.let { java.io.File(it, "$z-$x-$y.jpg") }
      val tex = texture
      if (file != null && file.isFile) {
        pixels.execute {
          val px = decodeTile(file, tex)
          if (px != null) {
            diskHits.incrementAndGet()
            deliver(z, x, y, px, tex, gen)
          } else {
            file.delete()
            main.post {
              if (!closed) {
                jobs.addLast(Job(z, x, y, gen))
                pump()
              }
            }
          }
        }
        return@post
      }
      jobs.addLast(Job(z, x, y, gen))
      pump()
    }
  }

  fun shutdown() {
    closed = true
    main.post { setStyle(null, false) }
    pixels.shutdownNow()
  }

  private fun pump() {
    val json = styleJson ?: return
    while (!closed && jobs.isNotEmpty()) {
      var idle = busy.indexOf(false)
      if (idle < 0 && snapshotters.size >= MAX_SNAPSHOTTERS) return
      val job = jobs.pollFirst() ?: return
      if (job.gen != generation()) continue
      val k = if (job.z >= 1) 2 else 1
      val x0 = job.x / k * k
      val y0 = job.y / k * k
      jobs.removeAll { it.z == job.z && it.x / k * k == x0 && it.y / k * k == y0 }
      val n = 2.0.pow(job.z)
      val lng = (x0 + 0.5 * k) / n * 360.0 - 180.0
      val lat = atan(sinh(PI * (1.0 - 2.0 * (y0 + 0.5 * k) / n))) * 180.0 / PI
      val pts = (512.0 * 2.0.pow(shift)).toInt() * k
      val camera = CameraPosition.Builder()
        .target(LatLng(lat, lng))
        .zoom((job.z + shift).toDouble())
        .bearing(0.0)
        .tilt(0.0)
        .build()
      val snap: MapSnapshotter
      if (idle < 0) {
        val scale = texture / (512.0 * 2.0.pow(shift))
        val options = MapSnapshotter.Options(pts, pts)
          .withStyleJson(json)
          .withCameraPosition(camera)
          .withPixelRatio(scale.toFloat())
          .withLogo(false)
          .withAttribution(false)
        snap = try {
          BareSnapshotter(context, options)
        } catch (e: Exception) {
          Log.w(TAG, "snapshotter not created", e)
          deliver(job.z, job.x, job.y, null, texture, job.gen)
          return
        }
        snapshotters.add(snap)
        busy.add(false)
        idle = snapshotters.size - 1
      } else {
        snap = snapshotters[idle]
        snap.setSize(pts, pts)
        snap.setCameraPosition(camera)
      }
      busy[idle] = true
      val tex = texture
      // The cache folder of the style this snapshot renders: a render that
      // finishes after a style change must not land in the new style's folder.
      val dir = tileDir
      val gen = styleGen
      val started = System.nanoTime()
      val slot = idle
      // Posted: MapSnapshotter clears its callback only after ours returns, so
      // restarting it from inside the callback would throw "already started".
      val finish = { main.post { finishJob(gen, slot, started) } }
      try {
        snap.start(
          { snapshot ->
            val bmp = snapshot.bitmap
            pixels.execute { slice(bmp, job, x0, y0, k, tex, dir) }
            finish()
          },
          { error ->
            Log.w(TAG, "drape snapshot failed: $error")
            for (j in 0 until k) for (i in 0 until k) deliver(job.z, x0 + i, y0 + j, null, texture, job.gen)
            finish()
          },
        )
      } catch (e: Exception) {
        Log.w(TAG, "drape snapshot not started", e)
        busy[idle] = false
        for (j in 0 until k) for (i in 0 until k) deliver(job.z, x0 + i, y0 + j, null, texture, job.gen)
        return
      }
    }
  }

  private fun finishJob(gen: Int, slot: Int, started: Long) {
    if (closed) return
    if (gen == styleGen && slot < busy.size) busy[slot] = false
    rendered++
    renders.incrementAndGet()
    msTotal += (System.nanoTime() - started) / 1e6
    if (rendered % 40 == 0) {
      Log.i(TAG, "drape snapshots $rendered (2x2 blocks), mean ${"%.0f".format(msTotal / rendered)} ms, queue ${jobs.size}")
    }
    pump()
  }

  /** Worker: the k×k block's bitmap → k² tile textures. */
  private fun slice(bmp: Bitmap, job: Job, x0: Int, y0: Int, k: Int, tex: Int, dir: java.io.File?) {
    try {
      val full = tex * k
      val src = if (bmp.width == full && bmp.height == full) bmp
      else Bitmap.createScaledBitmap(bmp, full, full, true)
      for (j in 0 until k) {
        for (i in 0 until k) {
          val tile = Bitmap.createBitmap(src, i * tex, j * tex, tex, tex)
          val buf = ByteBuffer.allocate(tex * tex * 4)
          tile.copyPixelsToBuffer(buf) // RGBA bytes for ARGB_8888 (opaque map: no premultiply effect)
          if (dir != null && dir == tileDir) writeTile(tile, java.io.File(dir, "${job.z}-${x0 + i}-${y0 + j}.jpg"))
          if (tile !== src) tile.recycle()
          deliver(job.z, x0 + i, y0 + j, buf.array(), tex, job.gen)
        }
      }
      if (src !== bmp) src.recycle()
    } catch (t: Throwable) {
      Log.w(TAG, "drape slice failed", t)
      for (j in 0 until k) for (i in 0 until k) deliver(job.z, x0 + i, y0 + j, null, tex, job.gen)
    }
  }

  private fun decodeTile(file: java.io.File, tex: Int): ByteArray? = try {
    val opts = android.graphics.BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
    val bmp = android.graphics.BitmapFactory.decodeFile(file.path, opts)
    if (bmp == null || bmp.width != tex || bmp.height != tex) {
      bmp?.recycle()
      null
    } else {
      val buf = ByteBuffer.allocate(tex * tex * 4)
      bmp.copyPixelsToBuffer(buf)
      bmp.recycle()
      file.setLastModified(System.currentTimeMillis())
      buf.array()
    }
  } catch (_: Throwable) {
    null
  }

  private fun writeTile(tile: Bitmap, file: java.io.File) {
    try {
      val tmp = java.io.File(file.path + ".${Thread.currentThread().id}.tmp")
      tmp.outputStream().use { tile.compress(Bitmap.CompressFormat.JPEG, 90, it) }
      if (!tmp.renameTo(file)) tmp.delete()
      if (++writes % 64 == 0) trimDisk()
    } catch (_: Throwable) {}
  }

  /** Oldest-first trim of every style's drapes to 3/4 of [DISK_BYTES]. */
  private fun trimDisk() {
    val files = diskRoot.walkTopDown().filter { it.isFile && it.name.endsWith(".jpg") }.toList()
    var total = files.sumOf { it.length() }
    if (total <= DISK_BYTES) return
    for (f in files.sortedBy { it.lastModified() }) {
      if (total <= DISK_BYTES * 3 / 4) break
      total -= f.length()
      f.delete()
    }
  }

  companion object {
    const val DISK_BYTES = 150L * 1024 * 1024
    const val TAG = "InukshukTerrain"
    const val MAX_SNAPSHOTTERS = 3
  }
}
