package expo.modules.inukshukpdf

import android.content.Context
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

    OnDestroy { destroyed.set(true) }
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
      val descriptor = ParcelFileDescriptor.open(input, ParcelFileDescriptor.MODE_READ_ONLY)
      val renderer = try { PdfRenderer(descriptor) } catch (error: Throwable) {
        descriptor.close()
        throw error
      }
      val result = renderer.use { document ->
        require(options.pageIndex < document.pageCount) { "PDF page index is out of range" }
        document.openPage(options.pageIndex.toInt()).use { page ->
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
      return result
    } finally {
      partial.delete()
      if (!success) output.delete()
    }
  }

  companion object {
    // Shared across React contexts. The admission gate means the executor can
    // contain at most one accepted render; overlap is rejected, never queued.
    private val busy = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadExecutor { task ->
      Thread(task, "InukshukPdf").apply { isDaemon = true }
    }
  }
}
