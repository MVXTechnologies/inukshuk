import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct PdfCropRequest {
  let fileUri: String
  let pageIndex: Double
  let pageWidthPt: Double
  let pageHeightPt: Double
  let x0: Double
  let y0: Double
  let x1: Double
  let y1: Double
  let targetWidthPx: Double
}

enum PdfJpegCrop {
  private static func unsupported(_ reason: String) -> PdfUnsupported { PdfUnsupported(reason: reason) }

  static func render(_ request: PdfCropRequest, documents: URL, caches: URL) throws -> [String: Any] {
    // No CGPDF page drawing: it expands the 181 MP Eco image to >1 GiB.
    // ImageIO's baseline-JPEG cropped image remains lazy until the bounded draw.
    let started = ProcessInfo.processInfo.systemUptime
    let values = [request.pageIndex, request.pageWidthPt, request.pageHeightPt, request.x0, request.y0, request.x1, request.y1, request.targetWidthPx]
    guard values.allSatisfy(\.isFinite), request.pageIndex >= 0, request.pageIndex <= 100_000,
      request.pageIndex.rounded(.down) == request.pageIndex,
      request.pageWidthPt > 0, request.pageWidthPt <= 1_000_000,
      request.pageHeightPt > 0, request.pageHeightPt <= 1_000_000,
      request.x0 >= 0, request.y0 >= 0, request.x1 <= 1, request.y1 <= 1,
      request.x1 > request.x0, request.y1 > request.y0,
      request.targetWidthPx >= 1, request.targetWidthPx <= 100_000 else { throw unsupported("Invalid crop geometry") }
    let pointWidth = request.pageWidthPt * (request.x1 - request.x0)
    let pointHeight = request.pageHeightPt * (request.y1 - request.y0)
    let aspect = pointHeight / pointWidth
    guard aspect.isFinite, aspect > 0 else { throw unsupported("Invalid crop aspect") }
    // Same caller budget: a 3072 px edge and at most three megapixels.
    let widthLimit = min(request.targetWidthPx, 3072, 3072 / aspect, sqrt(Double(3 * 1024 * 1024) / aspect))
    guard widthLimit.isFinite, widthLimit >= 1, widthLimit * aspect >= 1 else { throw unsupported("Crop is too narrow") }
    let width = Int(widthLimit.rounded(.down))
    let height = max(1, Int((Double(width) * aspect).rounded(.down)))
    let input = try privateInput(request.fileUri, documents: documents, caches: caches)
    guard let document = CGPDFDocument(input as CFURL), !document.isEncrypted,
      request.pageIndex < Double(document.numberOfPages),
      let page = document.page(at: Int(request.pageIndex) + 1), let pageDict = page.dictionary else { throw unsupported("Cannot open PDF page") }
    let media = page.getBoxRect(.mediaBox), visible = page.getBoxRect(.cropBox)
    guard page.rotationAngle == 0, media.minX == 0, media.minY == 0, media == visible,
      abs(media.width - request.pageWidthPt) < 0.01, abs(media.height - request.pageHeightPt) < 0.01,
      optionalNumber(pageDict, "UserUnit", default: 1) == 1,
      !contains(pageDict, "Group"), !contains(pageDict, "OC"), emptyAnnotations(pageDict) else { throw unsupported("Unsupported page geometry or overlays") }
    guard let resources = inheritedDictionary(pageDict, "Resources"),
      let xobjects = dictionary(resources, "XObject"), CGPDFDictionaryGetCount(xobjects) == 1 else { throw unsupported("Page needs one image resource") }
    let graphics = try safeGraphics(resources)
    let colors = try safeColors(resources)
    var contentStream: CGPDFStreamRef?
    guard CGPDFDictionaryGetStream(pageDict, "Contents", &contentStream), let contentStream else { throw unsupported("Unsupported content streams") }
    guard let contentDict = CGPDFStreamGetDictionary(contentStream) else { throw unsupported("Missing content dictionary") }
    guard keys(contentDict).isSubset(of: ["Length", "Filter"]),
      let contentLength = integer(contentDict, "Length"), contentLength > 0, contentLength <= 4096,
      !contains(contentDict, "Filter") || name(contentDict, "Filter") == "FlateDecode" else { throw unsupported("Content stream exceeds recognition budget") }
    // Flate's maximum expansion is ~1032:1, so the compressed limit also
    // bounds allocation inside CGPDFStreamCopyData before the decoded check.
    var contentFormat = CGPDFDataFormat.raw
    guard let contentData = CGPDFStreamCopyData(contentStream, &contentFormat), contentFormat == .raw,
      CFDataGetLength(contentData) <= 65536,
      let content = String(data: contentData as Data, encoding: .ascii) else { throw unsupported("Cannot recognize page content") }
    let paint = try PdfCropValidation.paint(content, graphicsStates: graphics, colorSpaces: colors)
    guard abs(paint.rect.minX) < 0.000001, abs(paint.rect.minY) < 0.000001,
      abs(paint.rect.width - media.width) < 1, abs(paint.rect.height - media.height) < 1 else { throw unsupported("Image does not fill page") }
    var jpegStream: CGPDFStreamRef?
    guard CGPDFDictionaryGetStream(xobjects, paint.name, &jpegStream), let jpegStream else { throw unsupported("Missing painted JPEG") }
    guard let imageDict = CGPDFStreamGetDictionary(jpegStream) else { throw unsupported("Missing image dictionary") }
    guard keys(imageDict).isSubset(of: ["Type", "Subtype", "Width", "Height", "BitsPerComponent", "ColorSpace", "Length", "Filter"]),
      name(imageDict, "Subtype") == "Image", name(imageDict, "Filter") == "DCTDecode",
      name(imageDict, "ColorSpace") == "DeviceRGB", integer(imageDict, "BitsPerComponent") == 8,
      let sourceWidth = integer(imageDict, "Width"), let sourceHeight = integer(imageDict, "Height"),
      sourceWidth > 0, sourceHeight > 0, sourceWidth <= 20_000, sourceHeight <= 20_000,
      let jpegLength = integer(imageDict, "Length"), jpegLength > 0, jpegLength <= 64 * 1024 * 1024 else { throw unsupported("Unsupported image encoding") }
    let exact = CGRect(
      x: (request.pageWidthPt * request.x0 - paint.rect.minX) / paint.rect.width * Double(sourceWidth),
      y: (paint.rect.maxY - request.pageHeightPt * (1 - request.y0)) / paint.rect.height * Double(sourceHeight),
      width: pointWidth / paint.rect.width * Double(sourceWidth),
      height: pointHeight / paint.rect.height * Double(sourceHeight))
    let sourceBounds = CGRect(x: 0, y: 0, width: sourceWidth, height: sourceHeight)
    let integral = exact.integral.intersection(sourceBounds)
    guard !integral.isNull, integral.width > 0, integral.height > 0,
      integral.width * integral.height <= 16 * 1024 * 1024 else { throw unsupported("Source crop exceeds decode budget") }
    var jpegFormat = CGPDFDataFormat.raw
    guard let jpeg = CGPDFStreamCopyData(jpegStream, &jpegFormat), jpegFormat == .jpegEncoded,
      CFDataGetLength(jpeg) <= 64 * 1024 * 1024,
      baselineJPEG(jpeg, width: sourceWidth, height: sourceHeight) else { throw unsupported("Only baseline RGB JPEG is supported") }
    let options = [kCGImageSourceShouldCache: false, kCGImageSourceShouldCacheImmediately: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(jpeg, options), CGImageSourceGetCount(source) == 1,
      let image = CGImageSourceCreateImageAtIndex(source, 0, options), image.width == sourceWidth, image.height == sourceHeight,
      let cropped = image.cropping(to: integral),
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw unsupported("Cannot decode cropped JPEG") }
    let loaded = ProcessInfo.processInfo.systemUptime
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .high
    let scaleX = Double(width) / exact.width, scaleY = Double(height) / exact.height
    context.draw(cropped, in: CGRect(x: (integral.minX - exact.minX) * scaleX,
      y: (exact.maxY - integral.maxY) * scaleY, width: integral.width * scaleX, height: integral.height * scaleY))
    let outputDir = caches.appendingPathComponent("overlays", isDirectory: true).resolvingSymlinksInPath()
    guard within(outputDir, caches) else { throw unsupported("Invalid output directory") }
    try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
    let output = outputDir.appendingPathComponent("pdf-detail-native-\(UUID().uuidString).png")
    let partial = output.appendingPathExtension("tmp")
    var success = false
    defer {
      try? FileManager.default.removeItem(at: partial)
      if !success { try? FileManager.default.removeItem(at: output) }
    }
    guard let rendered = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(partial as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw unsupported("Cannot create crop output") }
    CGImageDestinationAddImage(destination, rendered, nil)
    guard CGImageDestinationFinalize(destination) else { throw unsupported("Cannot encode crop") }
    try FileManager.default.moveItem(at: partial, to: output)
    success = true
    return ["fileUri": output.absoluteString, "widthPx": width, "heightPx": height,
      "pageWidthPt": request.pageWidthPt, "pageHeightPt": request.pageHeightPt, "pageCount": document.numberOfPages,
      "loadMs": (loaded - started) * 1000, "renderMs": (ProcessInfo.processInfo.systemUptime - loaded) * 1000]
  }

  static func within(_ file: URL, _ root: URL) -> Bool {
    file.resolvingSymlinksInPath().path.hasPrefix(root.resolvingSymlinksInPath().path + "/")
  }

  static func privateInput(_ uri: String, documents: URL, caches: URL) throws -> URL {
    guard let input = URL(string: uri), input.isFileURL, input.host == nil || input.host == "" || input.host == "localhost",
      input.query == nil, input.fragment == nil else { throw unsupported("Only private local PDFs are accepted") }
    let canonical = input.resolvingSymlinksInPath()
    guard within(canonical, documents) || within(canonical, caches),
      (try? canonical.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { throw unsupported("PDF is outside private storage") }
    return canonical
  }

  private static func emptyAnnotations(_ dict: CGPDFDictionaryRef) -> Bool {
    if !contains(dict, "Annots") { return true }
    var array: CGPDFArrayRef?
    return CGPDFDictionaryGetArray(dict, "Annots", &array) && array.map { CGPDFArrayGetCount($0) == 0 } == true
  }

  private static func contains(_ dict: CGPDFDictionaryRef, _ key: String) -> Bool {
    var object: CGPDFObjectRef?
    return CGPDFDictionaryGetObject(dict, key, &object)
  }
  private static func keys(_ dict: CGPDFDictionaryRef) -> Set<String> {
    guard CGPDFDictionaryGetCount(dict) <= 64 else { return ["__unsupported_resource_count__"] }
    let result = NSMutableSet()
    CGPDFDictionaryApplyFunction(dict, { key, _, context in
      guard let context else { return }
      Unmanaged<NSMutableSet>.fromOpaque(context).takeUnretainedValue().add(String(cString: key))
    }, Unmanaged.passUnretained(result).toOpaque())
    return Set(result.compactMap { $0 as? String })
  }
  private static func dictionary(_ dict: CGPDFDictionaryRef, _ key: String) -> CGPDFDictionaryRef? {
    var result: CGPDFDictionaryRef?
    return CGPDFDictionaryGetDictionary(dict, key, &result) ? result : nil
  }
  private static func inheritedDictionary(_ dict: CGPDFDictionaryRef, _ key: String) -> CGPDFDictionaryRef? {
    var current: CGPDFDictionaryRef? = dict
    for _ in 0..<32 {
      guard let currentDict = current else { return nil }
      if let result = dictionary(currentDict, key) { return result }
      current = dictionary(currentDict, "Parent")
    }
    return nil
  }
  private static func name(_ dict: CGPDFDictionaryRef, _ key: String) -> String? {
    var result: UnsafePointer<CChar>?
    guard CGPDFDictionaryGetName(dict, key, &result), let result else { return nil }
    return String(cString: result)
  }
  private static func integer(_ dict: CGPDFDictionaryRef, _ key: String) -> Int? {
    var result: CGPDFInteger = 0
    return CGPDFDictionaryGetInteger(dict, key, &result) ? result : nil
  }
  private static func optionalNumber(_ dict: CGPDFDictionaryRef, _ key: String, default fallback: Double) -> Double? {
    if !contains(dict, key) { return fallback }
    var result: CGPDFReal = 0
    return CGPDFDictionaryGetNumber(dict, key, &result) ? Double(result) : nil
  }
  private static func safeGraphics(_ resources: CGPDFDictionaryRef) throws -> Set<String> {
    guard let states = dictionary(resources, "ExtGState") else { return [] }
    var accepted: Set<String> = []
    for key in keys(states) {
      guard let state = dictionary(states, key), keys(state).isSubset(of: ["Type", "SA", "SM", "ca", "CA", "AIS", "SMask", "BM"]),
        optionalNumber(state, "ca", default: 1) == 1, optionalNumber(state, "CA", default: 1) == 1,
        !contains(state, "SMask") || name(state, "SMask") == "None",
        !contains(state, "BM") || name(state, "BM") == "Normal" else { continue }
      var alphaShape: CGPDFBoolean = 0
      if contains(state, "AIS") && (!CGPDFDictionaryGetBoolean(state, "AIS", &alphaShape) || alphaShape != 0) { continue }
      accepted.insert(key)
    }
    return accepted
  }
  private static func safeColors(_ resources: CGPDFDictionaryRef) throws -> Set<String> {
    guard let colors = dictionary(resources, "ColorSpace") else { return ["DeviceRGB", "DeviceGray"] }
    guard !contains(colors, "DefaultRGB") else { throw unsupported("Custom default image color space") }
    return Set(keys(colors).filter { ["DeviceRGB", "DeviceGray"].contains(name(colors, $0) ?? "") }).union(["DeviceRGB", "DeviceGray"])
  }

  // Progressive JPEG may force full-frame allocation. Accept only the measured
  // baseline format and simple JFIF metadata, bounded before the first scan.
  static func baselineJPEG(_ data: CFData, width: Int, height: Int) -> Bool {
    let count = CFDataGetLength(data)
    guard count >= 4, let bytes = CFDataGetBytePtr(data), bytes[0] == 255, bytes[1] == 216 else { return false }
    var offset = 2
    var frameComponents: Set<UInt8> = []
    while offset + 4 <= count && offset < 1024 * 1024 {
      guard bytes[offset] == 255 else { return false }
      offset += 1
      while offset < count && bytes[offset] == 255 { offset += 1 }
      guard offset + 3 <= count else { return false }
      let marker = bytes[offset]
      offset += 1
      let length = Int(bytes[offset]) * 256 + Int(bytes[offset + 1])
      guard length >= 2, offset + length <= count else { return false }
      if marker == 0xC0 {
        guard frameComponents.isEmpty, length == 17, bytes[offset + 2] == 8,
          Int(bytes[offset + 3]) * 256 + Int(bytes[offset + 4]) == height,
          Int(bytes[offset + 5]) * 256 + Int(bytes[offset + 6]) == width,
          bytes[offset + 7] == 3 else { return false }
        frameComponents = [bytes[offset + 8], bytes[offset + 11], bytes[offset + 14]]
        guard frameComponents.count == 3 else { return false }
      } else if marker == 0xDA {
        // SOF0 also permits separate component scans. Require all three frame
        // components in one baseline scan to preserve the measured lazy-decode
        // memory contract; noninterleaved/progressive layouts use PDF.js.
        guard frameComponents.count == 3, length == 12, bytes[offset + 2] == 3,
          bytes[offset + 9] == 0, bytes[offset + 10] == 63, bytes[offset + 11] == 0 else { return false }
        let scanComponents: Set<UInt8> = [bytes[offset + 3], bytes[offset + 5], bytes[offset + 7]]
        guard scanComponents == frameComponents else { return false }
        return [4, 6, 8].allSatisfy { index in
          let tables = bytes[offset + index]
          return tables >> 4 <= 3 && tables & 15 <= 3
        }
      }
      else if ![0xE0, 0xDB, 0xC4, 0xDD].contains(marker) { return false }
      offset += length
    }
    return false
  }
}
