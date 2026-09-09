import ExpoModulesCore
import Foundation

struct PdfCropOptions: Record {
  @Field var x0: Double = .nan
  @Field var y0: Double = .nan
  @Field var x1: Double = .nan
  @Field var y1: Double = .nan
}

struct PdfRenderOptions: Record {
  @Field var fileUri: String = ""
  @Field var pageIndex: Double = .nan
  @Field var pageWidthPt: Double = .nan
  @Field var pageHeightPt: Double = .nan
  @Field var crop: PdfCropOptions = PdfCropOptions()
  @Field var targetWidthPx: Double = .nan
}

public final class InukshukPdfModule: Module {
  private static let worker = DispatchQueue(label: "app.inukshuk.pdf-crop", qos: .userInitiated)
  private static let gate = NSLock()
  private static var busy = false
  private let lifecycle = NSLock()
  private var destroyed = false

  public func definition() -> ModuleDefinition {
    Name("InukshukPdf")
    AsyncFunction("renderCrop") { (options: PdfRenderOptions, promise: Promise) in
      Self.gate.lock()
      let admitted = !Self.busy
      if admitted { Self.busy = true }
      Self.gate.unlock()
      guard admitted else {
        promise.reject("E_PDF_BUSY", "A native PDF render is already running")
        return
      }
      Self.worker.async { [self] in
        var result: [String: Any]?
        var failure: Error?
        do {
          result = try autoreleasepool {
            guard !isDestroyed,
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
              throw PdfUnsupported(reason: "PDF renderer context is unavailable")
            }
            let request = PdfCropRequest(fileUri: options.fileUri, pageIndex: options.pageIndex,
              pageWidthPt: options.pageWidthPt, pageHeightPt: options.pageHeightPt,
              x0: options.crop.x0, y0: options.crop.y0, x1: options.crop.x1, y1: options.crop.y1,
              targetWidthPx: options.targetWidthPx)
            let output = try PdfJpegCrop.render(request, documents: documents, caches: caches)
            if isDestroyed {
              if let uri = output["fileUri"] as? String, let url = URL(string: uri) { try? FileManager.default.removeItem(at: url) }
              throw PdfUnsupported(reason: "PDF renderer context was destroyed")
            }
            return output
          }
        } catch { failure = error }
        // Admission stays closed until native work and autoreleased decode
        // resources settle. JS timeout/cancellation cannot open this gate.
        Self.gate.lock()
        Self.busy = false
        Self.gate.unlock()
        if let error = failure as? PdfUnsupported {
          promise.reject("E_PDF_UNSUPPORTED", error.reason)
        } else if let failure {
          promise.reject("E_PDF_RENDER", failure.localizedDescription)
        } else { promise.resolve(result) }
      }
    }
    OnDestroy {
      self.lifecycle.lock()
      self.destroyed = true
      self.lifecycle.unlock()
    }
  }

  private var isDestroyed: Bool {
    lifecycle.lock()
    defer { lifecycle.unlock() }
    return destroyed
  }
}
