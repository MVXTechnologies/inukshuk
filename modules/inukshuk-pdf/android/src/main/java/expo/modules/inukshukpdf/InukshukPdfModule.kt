package expo.modules.inukshukpdf

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class CropOptions : Record {
  @Field var x0: Double = Double.NaN
  @Field var y0: Double = Double.NaN
  @Field var x1: Double = Double.NaN
  @Field var y1: Double = Double.NaN
}

class RenderCropOptions : Record {
  @Field var fileUri: String = ""
  @Field var pageIndex: Double = Double.NaN
  @Field var pageWidthPt: Double = Double.NaN
  @Field var pageHeightPt: Double = Double.NaN
  @Field var crop: CropOptions? = null
  @Field var targetWidthPx: Double = Double.NaN
}

class InukshukPdfModule : Module() {
  private val destroyed = AtomicBoolean(false)

  override fun definition() = ModuleDefinition {
    Name("InukshukPdf")

    AsyncFunction("renderCrop") { options: RenderCropOptions, promise: Promise ->
      val context = appContext.reactContext?.applicationContext
      if (context == null || destroyed.get()) {
        promise.reject("E_PDF_CONTEXT", "PDF renderer context is unavailable", null)
      } else if (!busy.compareAndSet(false, true)) {
        promise.reject("E_PDF_BUSY", "A native PDF render is already running", null)
      } else {
        try {
          worker.execute {
            var output: Map<String, Any>? = null
            var failure: Throwable? = null
            try {
              check(!destroyed.get()) { "PDF renderer context was destroyed" }
              output = render(context, options)
              if (destroyed.get()) {
                File(Uri.parse(output["fileUri"] as String).path!!).delete()
                output = null
                throw IllegalStateException("PDF renderer context was destroyed")
              }
            } catch (error: Throwable) {
              failure = error
            } finally {
              // The synchronous renderer and all its resources have settled.
              // Do not release this gate on a JS timeout or coroutine cancellation.
              busy.set(false)
            }
            if (failure != null) promise.reject("E_PDF_RENDER", failure.message, failure)
            else promise.resolve(output)
          }
        } catch (error: Throwable) {
          busy.set(false)
          promise.reject("E_PDF_RENDER", error.message, error)
        }
      }
    }

    OnCreate {
      appContext.reactContext?.applicationContext?.registerComponentCallbacks(trimCallbacks)
    }

    OnDestroy {
      destroyed.set(true)
      appContext.reactContext?.applicationContext?.unregisterComponentCallbacks(trimCallbacks)
      worker.execute { closeHeld() }
    }
  }

  // The OS is short of memory: drop the held page (its parsed content).
  private val trimCallbacks = object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) worker.execute { closeHeld() }
    }
    override fun onConfigurationChanged(newConfig: Configuration) {}
    @Deprecated("Deprecated in Java")
    override fun onLowMemory() { worker.execute { closeHeld() } }
  }

  private fun render(context: Context, options: RenderCropOptions): Map<String, Any> {
    require(options.pageIndex.isFinite() && options.pageIndex >= 0 &&
      options.pageIndex <= Int.MAX_VALUE && options.pageIndex % 1.0 == 0.0) {
      "Invalid PDF page index"
    }
    val crop = requireNotNull(options.crop) { "PDF detail crop is required" }
    val geometry = CropGeometry.create(options.pageWidthPt, options.pageHeightPt,
      crop.x0, crop.y0, crop.x1, crop.y1, options.targetWidthPx)
    val input = PrivatePdfFiles.input(options.fileUri, context.filesDir, context.cacheDir)
    val outputDir = File(context.cacheDir, "overlays").canonicalFile
    require(PrivatePdfFiles.within(outputDir, context.cacheDir)) { "Invalid PDF output directory" }
    check(outputDir.isDirectory || outputDir.mkdirs()) { "Cannot create PDF output directory" }
    val output = File(outputDir, "pdf-detail-native-${UUID.randomUUID()}.png")
    val partial = File(outputDir, "${output.name}.tmp")
    var success = false
    try {
      val started = SystemClock.elapsedRealtime()
      // Opening the document and page parses the page's content: most of a
      // small crop's cost (~170 ms of a 200 ms 480 px tile on a US Topo sheet,
      // API 34 emulator). A burst of crops of one page reuses them.
      val held = holdPage(input, options.pageIndex.toInt())
      val result = run {
        val document = held.renderer
        val page = held.page
        run {
          CropGeometry.requirePageSize(page.width, page.height, options.pageWidthPt, options.pageHeightPt)
          val loaded = SystemClock.elapsedRealtime()
          val bitmap = Bitmap.createBitmap(geometry.widthPx, geometry.heightPx, Bitmap.Config.ARGB_8888)
          try {
            bitmap.eraseColor(Color.WHITE)
            // The white background is opaque; omit the redundant PNG alpha channel.
            bitmap.setHasAlpha(false)
            val transform = Matrix().apply {
              setValues(floatArrayOf(geometry.scale.toFloat(), 0f, geometry.offsetX.toFloat(),
                0f, geometry.scale.toFloat(), geometry.offsetY.toFloat(), 0f, 0f, 1f))
            }
            page.render(bitmap, Rect(0, 0, bitmap.width, bitmap.height), transform,
              PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            FileOutputStream(partial).use { stream ->
              check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) { "PDF PNG encoding failed" }
            }
            check(partial.renameTo(output)) { "Cannot publish PDF crop file" }
            mapOf<String, Any>("fileUri" to Uri.fromFile(output).toString(),
              "widthPx" to bitmap.width, "heightPx" to bitmap.height,
              "pageWidthPt" to options.pageWidthPt, "pageHeightPt" to options.pageHeightPt,
              "pageCount" to document.pageCount, "loadMs" to loaded - started,
              "renderMs" to SystemClock.elapsedRealtime() - loaded)
          } finally { bitmap.recycle() }
        }
      }
      success = true
      scheduleClose()
      return result
    } finally {
      partial.delete()
      if (!success) {
        output.delete()
        // A failure may leave the renderer in an unknown state: never reuse it.
        closeHeld()
      }
    }
  }

  /** One open document + page, kept between crops of the same page (worker thread only). */
  private class HeldPage(
    val descriptor: ParcelFileDescriptor,
    val renderer: PdfRenderer,
    val page: PdfRenderer.Page,
  )

  private fun holdPage(input: File, pageIndex: Int): HeldPage {
    closeFuture?.cancel(false)
    // The file's identity includes its size and modification time, so a
    // replaced PDF at the same path is opened afresh.
    val key = PageHold.key(input.canonicalPath, input.length(), input.lastModified(), pageIndex)
    return hold.acquire(key) {
      val descriptor = ParcelFileDescriptor.open(input, ParcelFileDescriptor.MODE_READ_ONLY)
      val renderer = try { PdfRenderer(descriptor) } catch (error: Throwable) {
        descriptor.close()
        throw error
      }
      try {
        require(pageIndex < renderer.pageCount) { "PDF page index is out of range" }
        HeldPage(descriptor, renderer, renderer.openPage(pageIndex))
      } catch (error: Throwable) {
        renderer.close()
        descriptor.close()
        throw error
      }
    }
  }

  private fun scheduleClose() {
    closeFuture?.cancel(false)
    closeFuture = worker.schedule({ closeHeld() }, HOLD_IDLE_MS, TimeUnit.MILLISECONDS)
  }

  private fun closeHeld() {
    closeFuture?.cancel(false)
    closeFuture = null
    hold.release()
  }

  companion object {
    // Shared across React contexts. The admission gate means the executor can
    // contain at most one accepted render; overlap is rejected, never queued.
    private val busy = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadScheduledExecutor { task ->
      Thread(task, "InukshukPdf").apply { isDaemon = true }
    }
    // Confined to the worker thread.
    private val hold = PageHold<HeldPage> { h ->
      try { h.page.close() } catch (_: Throwable) {}
      try { h.renderer.close() } catch (_: Throwable) {}
      try { h.descriptor.close() } catch (_: Throwable) {}
    }
    private var closeFuture: ScheduledFuture<*>? = null
    /** Idle time after which the held page is closed. */
    private const val HOLD_IDLE_MS = 8_000L
  }
}
