package expo.modules.inukshukterrain

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Terrarium DEM tiles for the native terrain: disk cache first (the SAME
 * directory and names the JS side uses — `<cache>/dem/dem-z-x-y.png`, see
 * src/data/storage.ts — so both share one evicted cache), else HTTP. Runs on
 * a small pool; the PNG is decoded by the engine on the worker thread.
 */
class DemFetcher(
  context: Context,
  private val deliver: (z: Int, x: Int, y: Int, bytes: ByteArray?) -> Unit,
) {
  @Volatile var networkAllowed: Boolean = true

  /** Round 3 counters: DEMs served from the disk cache / fetched over the network. */
  val fromDisk = java.util.concurrent.atomic.AtomicInteger()
  val fromNetwork = java.util.concurrent.atomic.AtomicInteger()

  private val dir = File(context.cacheDir, "dem").apply { mkdirs() }
  private val pool: ExecutorService = Executors.newFixedThreadPool(4) { r ->
    Thread(r, "terrain-dem").apply {
      isDaemon = true
      priority = Thread.NORM_PRIORITY - 1
    }
  }

  fun fetch(z: Int, x: Int, y: Int) {
    pool.execute { deliver(z, x, y, load(z, x, y)) }
  }

  fun shutdown() {
    pool.shutdownNow()
  }

  private fun load(z: Int, x: Int, y: Int): ByteArray? {
    val file = File(dir, "dem-$z-$x-$y.png")
    try {
      if (file.isFile && file.length() > 0) {
        val bytes = file.readBytes()
        if (isPng(bytes)) {
          fromDisk.incrementAndGet()
          return bytes
        }
        file.delete()
      }
    } catch (_: Exception) {
      file.delete()
    }
    if (!networkAllowed) return null
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(URL_TEMPLATE.format(z, x, y)).openConnection() as HttpURLConnection).apply {
        connectTimeout = 10_000
        readTimeout = 15_000
        setRequestProperty("User-Agent", "Inukshuk/1.0 (offline trail navigation app)")
      }
      if (conn.responseCode != 200) return null
      val bytes = conn.inputStream.use { it.readBytes() }
      if (!isPng(bytes)) return null
      val tmp = File(dir, "dem-$z-$x-$y.png.${Thread.currentThread().id}.tmp")
      tmp.writeBytes(bytes)
      if (!tmp.renameTo(file)) tmp.delete()
      fromNetwork.incrementAndGet()
      bytes
    } catch (_: Exception) {
      null
    } finally {
      conn?.disconnect()
    }
  }

  private fun isPng(b: ByteArray): Boolean =
    b.size > 8 && b[0] == 0x89.toByte() && b[1] == 'P'.code.toByte() && b[2] == 'N'.code.toByte()

  companion object {
    const val URL_TEMPLATE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png"
  }
}
