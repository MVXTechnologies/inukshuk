package expo.modules.inukshukterrain

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Satellite imagery tiles for the 3D surface (Esri World Imagery — the same
 * service as the 2D satellite basemap): a small disk cache of the JPEGs
 * (`<cache>/terrain-imagery`, trimmed to [MAX_CACHE_BYTES]), decoded to 256²
 * RGBA8 for the engine's texture slots.
 */
class ImageryFetcher(
  context: Context,
  private val deliver: (z: Int, x: Int, y: Int, rgba: ByteArray?) -> Unit,
) {
  @Volatile var networkAllowed: Boolean = true

  private val dir = File(context.cacheDir, "terrain-imagery").apply { mkdirs() }
  private val pool: ExecutorService = Executors.newFixedThreadPool(4) { r ->
    Thread(r, "terrain-imagery").apply {
      isDaemon = true
      priority = Thread.NORM_PRIORITY - 1
    }
  }
  @Volatile private var writes = 0

  fun fetch(z: Int, x: Int, y: Int) {
    pool.execute {
      val rgba = try {
        load(z, x, y)?.let { decode(it) }
      } catch (_: Throwable) {
        null
      }
      deliver(z, x, y, rgba)
    }
  }

  fun shutdown() {
    pool.shutdownNow()
  }

  private fun load(z: Int, x: Int, y: Int): ByteArray? {
    val file = File(dir, "img-$z-$x-$y.jpg")
    if (file.isFile && file.length() > 0) {
      file.setLastModified(System.currentTimeMillis())
      return file.readBytes()
    }
    if (!networkAllowed) return null
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(URL_TEMPLATE.format(z, y, x)).openConnection() as HttpURLConnection).apply {
        connectTimeout = 10_000
        readTimeout = 15_000
        setRequestProperty("User-Agent", "Inukshuk/1.0 (offline trail navigation app)")
      }
      if (conn.responseCode != 200) return null
      val bytes = conn.inputStream.use { it.readBytes() }
      val tmp = File(dir, "img-$z-$x-$y.jpg.${Thread.currentThread().id}.tmp")
      tmp.writeBytes(bytes)
      if (!tmp.renameTo(file)) tmp.delete()
      if (++writes % 64 == 0) trimCache()
      bytes
    } catch (_: Exception) {
      null
    } finally {
      conn?.disconnect()
    }
  }

  private fun decode(bytes: ByteArray): ByteArray? {
    val opts = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
    val src = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
    val bmp =
      if (src.width == SIZE && src.height == SIZE) src
      else Bitmap.createScaledBitmap(src, SIZE, SIZE, true).also { src.recycle() }
    val buf = ByteBuffer.allocate(SIZE * SIZE * 4)
    bmp.copyPixelsToBuffer(buf)  // RGBA byte order for ARGB_8888 (opaque: no premultiply effect)
    bmp.recycle()
    return buf.array()
  }

  private fun trimCache() {
    val files = dir.listFiles()?.filter { it.isFile } ?: return
    var total = files.sumOf { it.length() }
    if (total <= MAX_CACHE_BYTES) return
    for (f in files.sortedBy { it.lastModified() }) {
      if (total <= MAX_CACHE_BYTES * 3 / 4) break
      total -= f.length()
      f.delete()
    }
  }

  companion object {
    const val SIZE = 256
    const val MAX_CACHE_BYTES = 120L * 1024 * 1024
    const val URL_TEMPLATE =
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/%d/%d/%d"
  }
}
