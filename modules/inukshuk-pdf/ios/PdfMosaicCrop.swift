import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Opaque RGB/indexed raster mosaics only. Never draws an arbitrary PDF page.
/// Total decoded work is distinct from live memory: one small source image is
/// decoded, drawn and released before the next image starts.
enum PdfMosaicCrop {
  private static let maxPaints = 256
  private static let maxWorkBytes = 1280 * 1024 * 1024
  private struct Tile {
    let paint: ImagePaint
    let stream: CGPDFStreamRef
    let width: Int
    let height: Int
    let channels: Int
    let colorSpace: CGColorSpace
    var decodedBytes: Int { width * height * channels }
  }
  private static func require(_ value: Bool, _ reason: String) throws {
    if !value { throw PdfUnsupported(reason: reason) }
  }

  static func render(_ request: PdfCropRequest, documents: URL, caches: URL) throws -> [String: Any] {
    let started = ProcessInfo.processInfo.systemUptime
    let values = [request.pageIndex, request.pageWidthPt, request.pageHeightPt,
      request.x0, request.y0, request.x1, request.y1, request.targetWidthPx]
    try require(values.allSatisfy(\.isFinite) && request.pageIndex >= 0 && request.pageIndex <= 100_000 &&
      request.pageIndex.rounded(.down) == request.pageIndex &&
      request.pageWidthPt > 0 && request.pageWidthPt <= 1_000_000 &&
      request.pageHeightPt > 0 && request.pageHeightPt <= 1_000_000 &&
      request.x0 >= 0 && request.y0 >= 0 && request.x1 <= 1 && request.y1 <= 1 &&
      request.x1 > request.x0 && request.y1 > request.y0 &&
      request.targetWidthPx >= 1 && request.targetWidthPx <= 100_000, "Invalid mosaic crop geometry")
    let pointWidth = request.pageWidthPt * (request.x1 - request.x0)
    let pointHeight = request.pageHeightPt * (request.y1 - request.y0)
    let aspect = pointHeight / pointWidth
    try require(aspect.isFinite && aspect > 0, "Invalid mosaic crop aspect")
    let limit = min(request.targetWidthPx, 3072, 3072 / aspect, sqrt(Double(3 * 1024 * 1024) / aspect))
    try require(limit.isFinite && limit >= 1 && limit * aspect >= 1, "Mosaic crop is too narrow")
    let width = Int(limit.rounded(.down)), height = max(1, Int((limit.rounded(.down) * aspect).rounded(.down)))
    let input = try PdfJpegCrop.privateInput(request.fileUri, documents: documents, caches: caches)
    guard let document = CGPDFDocument(input as CFURL), !document.isEncrypted,
      request.pageIndex < Double(document.numberOfPages), let page = document.page(at: Int(request.pageIndex) + 1),
      let pageDict = page.dictionary else { throw PdfUnsupported(reason: "Cannot open mosaic PDF page") }
    let media = page.getBoxRect(.mediaBox)
    try require(page.rotationAngle == 0 && media.minX == 0 && media.minY == 0 && media == page.getBoxRect(.cropBox) &&
      abs(media.width - request.pageWidthPt) < 0.01 && abs(media.height - request.pageHeightPt) < 0.01 &&
      number(pageDict, "UserUnit", fallback: 1) == 1 && !contains(pageDict, "Group") && !contains(pageDict, "OC"),
      "Unsupported mosaic page geometry")
    if contains(pageDict, "Annots") {
      var annotations: CGPDFArrayRef?
      try require(CGPDFDictionaryGetArray(pageDict, "Annots", &annotations) && annotations.map { CGPDFArrayGetCount($0) == 0 } == true,
        "Mosaic page has annotations")
    }
    guard let resources = inheritedDictionary(pageDict, "Resources"), let images = dictionary(resources, "XObject") else {
      throw PdfUnsupported(reason: "Missing mosaic image resources")
    }
    try require(CGPDFDictionaryGetCount(images) > 0 && CGPDFDictionaryGetCount(images) <= maxPaints,
      "Mosaic resource count exceeds budget")
    if let colors = dictionary(resources, "ColorSpace") {
      try require(!contains(colors, "DefaultRGB"), "Unsupported mosaic default color space")
    }
    let paints = try parsePaints(readContent(pageDict))
    // Validate every paint before drawing any output, including off-crop images.
    let tiles = try paints.map { try tile($0, images: images) }
    let crop = CGRect(x: request.pageWidthPt * request.x0, y: request.pageHeightPt * (1 - request.y1),
      width: pointWidth, height: pointHeight)
    let selected = tiles.filter { !$0.paint.rect.intersection(crop).isEmpty }
    try require(selected.reduce(0) { $0 + $1.decodedBytes } <= maxWorkBytes, "Mosaic work exceeds decode budget")
    guard let color = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: color, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw PdfUnsupported(reason: "Cannot allocate mosaic output") }
    let loaded = ProcessInfo.processInfo.systemUptime
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .high
    context.setShouldAntialias(false)
    let scale = Double(width) / pointWidth
    for tile in selected {
      try autoreleasepool {
        var format = CGPDFDataFormat.raw
        // CGPDFStreamCopyData has no output-allocation cap. Encoded input and
        // expected dimensions are bounded beforehand; verify the exact decoded
        // count afterwards. This is not a hard malformed-Flate allocation bound.
        guard let data = CGPDFStreamCopyData(tile.stream, &format), format == .raw,
          CFDataGetLength(data) == tile.decodedBytes, let provider = CGDataProvider(data: data),
          let image = CGImage(width: tile.width, height: tile.height, bitsPerComponent: 8,
            bitsPerPixel: tile.channels * 8, bytesPerRow: tile.width * tile.channels,
            space: tile.colorSpace, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else {
          throw PdfUnsupported(reason: "Mosaic image sample count or encoding mismatch")
        }
        let rect = tile.paint.rect
        // Anchor at the crop's TOP edge, matching the PDF.js viewport when
        // the integer output height rounds down by a fractional pixel.
        context.draw(image, in: CGRect(x: (rect.minX - crop.minX) * scale,
          y: Double(height) - (crop.maxY - rect.minY) * scale, width: rect.width * scale, height: rect.height * scale))
      }
    }
    let outputDir = caches.appendingPathComponent("overlays", isDirectory: true).resolvingSymlinksInPath()
    try require(PdfJpegCrop.within(outputDir, caches), "Invalid mosaic output directory")
    try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
    let output = outputDir.appendingPathComponent("pdf-detail-native-\(UUID().uuidString).png")
    let partial = output.appendingPathExtension("tmp")
    var success = false
    defer {
      try? FileManager.default.removeItem(at: partial)
      if !success { try? FileManager.default.removeItem(at: output) }
    }
    guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(partial as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      throw PdfUnsupported(reason: "Cannot create mosaic output")
    }
    CGImageDestinationAddImage(destination, image, nil)
    try require(CGImageDestinationFinalize(destination), "Cannot encode mosaic PNG")
    try FileManager.default.moveItem(at: partial, to: output)
    success = true
    return ["fileUri": output.absoluteString, "widthPx": width, "heightPx": height,
      "pageWidthPt": request.pageWidthPt, "pageHeightPt": request.pageHeightPt, "pageCount": document.numberOfPages,
      "loadMs": (loaded - started) * 1000, "renderMs": (ProcessInfo.processInfo.systemUptime - loaded) * 1000]
  }

  static func parsePaints(_ content: String) throws -> [ImagePaint] {
    try require(content.utf8.count <= 65536 && content.utf8.allSatisfy { $0 < 128 }, "Mosaic content exceeds budget")
    let tokens = content.split(whereSeparator: { $0.isWhitespace })
    try require(tokens.count <= 8192, "Mosaic token count exceeds budget")
    var operands: [String] = [], stack: [CGAffineTransform] = [], paints: [ImagePaint] = []
    var transform = CGAffineTransform.identity
    for part in tokens {
      let token = String(part)
      if token.first == "/" || Double(token) != nil {
        try require(operands.count < 6, "Unsupported mosaic operands")
        operands.append(token); continue
      }
      switch token {
      case "q":
        try require(operands.isEmpty && stack.count < 32, "Invalid mosaic graphics stack")
        stack.append(transform)
      case "Q":
        guard operands.isEmpty, let saved = stack.popLast() else { throw PdfUnsupported(reason: "Unbalanced mosaic graphics stack") }
        transform = saved
      case "cm":
        let values = operands.compactMap(Double.init)
        try require(values.count == 6 && values.allSatisfy { $0.isFinite && abs($0) <= 1_000_000 }, "Invalid mosaic transform")
        transform = CGAffineTransform(a: values[0], b: values[1], c: values[2], d: values[3], tx: values[4], ty: values[5]).concatenating(transform)
        try require([transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].allSatisfy { $0.isFinite && abs($0) <= 1_000_000 }, "Mosaic transform exceeds budget")
      case "Do":
        guard operands.count == 1, let operand = operands.first, operand.first == "/", operand.count > 1,
          operand.dropFirst().allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }) else {
          throw PdfUnsupported(reason: "Unsupported mosaic resource name")
        }
        try require(paints.count < maxPaints && transform.b == 0 && transform.c == 0 && transform.a > 0 && transform.d > 0,
          "Unsupported mosaic image placement")
        paints.append(ImagePaint(name: String(operand.dropFirst()), rect: CGRect(x: transform.tx, y: transform.ty, width: transform.a, height: transform.d)))
      default: throw PdfUnsupported(reason: "Unsupported mosaic drawing operator")
      }
      operands.removeAll(keepingCapacity: true)
    }
    try require(operands.isEmpty && stack.isEmpty && !paints.isEmpty, "Incomplete mosaic content")
    return paints
  }

  private static func tile(_ paint: ImagePaint, images: CGPDFDictionaryRef) throws -> Tile {
    var stream: CGPDFStreamRef?
    guard CGPDFDictionaryGetStream(images, paint.name, &stream), let stream, let dict = CGPDFStreamGetDictionary(stream),
      keys(dict).isSubset(of: ["Type", "Subtype", "Name", "Width", "Height", "BitsPerComponent", "ColorSpace", "Length", "Filter"]),
      name(dict, "Subtype") == "Image", name(dict, "Filter") == "FlateDecode",
      integer(dict, "BitsPerComponent") == 8, let width = integer(dict, "Width"), let height = integer(dict, "Height"),
      width > 0, height > 0, width <= 2048, height <= 2048,
      let length = integer(dict, "Length"), length > 0, length <= 4 * 1024 * 1024 else {
      throw PdfUnsupported(reason: "Unsupported mosaic image dictionary or size")
    }
    let rgb = CGColorSpaceCreateDeviceRGB()
    if name(dict, "ColorSpace") == "DeviceRGB" {
      return Tile(paint: paint, stream: stream, width: width, height: height, channels: 3, colorSpace: rgb)
    }
    var indexed: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(dict, "ColorSpace", &indexed), let indexed, CGPDFArrayGetCount(indexed) == 4 else {
      throw PdfUnsupported(reason: "Unsupported mosaic color space")
    }
    var kind: UnsafePointer<CChar>?, base: UnsafePointer<CChar>?, last: CGPDFInteger = 0
    guard CGPDFArrayGetName(indexed, 0, &kind), let kind, String(cString: kind) == "Indexed",
      CGPDFArrayGetName(indexed, 1, &base), let base, String(cString: base) == "DeviceRGB",
      CGPDFArrayGetInteger(indexed, 2, &last), last >= 0, last <= 255 else {
      throw PdfUnsupported(reason: "Unsupported mosaic indexed palette")
    }
    let count = (last + 1) * 3
    var string: CGPDFStringRef?, paletteStream: CGPDFStreamRef?
    let palette: Data
    if CGPDFArrayGetString(indexed, 3, &string), let string, let bytes = CGPDFStringGetBytePtr(string) {
      try require(CGPDFStringGetLength(string) == count, "Mosaic palette length mismatch")
      palette = Data(bytes: bytes, count: count)
    } else if CGPDFArrayGetStream(indexed, 3, &paletteStream), let paletteStream {
      palette = try smallStream(paletteStream, decodedLimit: 768)
      try require(palette.count == count, "Mosaic palette length mismatch")
    } else { throw PdfUnsupported(reason: "Unsupported mosaic palette storage") }
    let color = palette.withUnsafeBytes { bytes in
      CGColorSpace(indexedBaseSpace: rgb, last: last, colorTable: bytes.baseAddress!)
    }
    guard let color else { throw PdfUnsupported(reason: "Cannot create mosaic palette") }
    return Tile(paint: paint, stream: stream, width: width, height: height, channels: 1, colorSpace: color)
  }

  private static func readContent(_ page: CGPDFDictionaryRef) throws -> String {
    var stream: CGPDFStreamRef?, array: CGPDFArrayRef?
    var streams: [CGPDFStreamRef] = []
    if CGPDFDictionaryGetStream(page, "Contents", &stream), let stream { streams = [stream] }
    else if CGPDFDictionaryGetArray(page, "Contents", &array), let array {
      try require(CGPDFArrayGetCount(array) > 0 && CGPDFArrayGetCount(array) <= 32, "Mosaic contents count exceeds budget")
      for i in 0..<CGPDFArrayGetCount(array) {
        var value: CGPDFStreamRef?
        guard CGPDFArrayGetStream(array, i, &value), let value else { throw PdfUnsupported(reason: "Unsupported mosaic contents") }
        streams.append(value)
      }
    } else { throw PdfUnsupported(reason: "Unsupported mosaic contents") }
    var content = ""
    for stream in streams {
      guard let part = String(data: try smallStream(stream, decodedLimit: 65536), encoding: .ascii) else {
        throw PdfUnsupported(reason: "Unsupported mosaic content encoding")
      }
      try require(content.utf8.count + part.utf8.count + 1 <= 65536, "Mosaic content exceeds budget")
      content += part + " "
    }
    return content
  }
  private static func smallStream(_ stream: CGPDFStreamRef, decodedLimit: Int) throws -> Data {
    guard let dict = CGPDFStreamGetDictionary(stream), keys(dict).isSubset(of: ["Length", "Filter"]),
      let length = integer(dict, "Length"), length > 0, length <= 4096,
      !contains(dict, "Filter") || name(dict, "Filter") == "FlateDecode" else {
      throw PdfUnsupported(reason: "Unsupported mosaic auxiliary stream")
    }
    var format = CGPDFDataFormat.raw
    guard let data = CGPDFStreamCopyData(stream, &format), format == .raw, CFDataGetLength(data) <= decodedLimit else {
      throw PdfUnsupported(reason: "Mosaic auxiliary stream exceeds decoded budget")
    }
    return data as Data
  }
  private static func contains(_ dict: CGPDFDictionaryRef, _ key: String) -> Bool {
    var object: CGPDFObjectRef?; return CGPDFDictionaryGetObject(dict, key, &object)
  }
  private static func keys(_ dict: CGPDFDictionaryRef) -> Set<String> {
    guard CGPDFDictionaryGetCount(dict) <= 32 else { return ["__unsupported_dictionary__"] }
    let result = NSMutableSet()
    CGPDFDictionaryApplyFunction(dict, { key, _, context in
      guard let context else { return }
      Unmanaged<NSMutableSet>.fromOpaque(context).takeUnretainedValue().add(String(cString: key))
    }, Unmanaged.passUnretained(result).toOpaque())
    return Set(result.compactMap { $0 as? String })
  }
  private static func dictionary(_ dict: CGPDFDictionaryRef, _ key: String) -> CGPDFDictionaryRef? {
    var result: CGPDFDictionaryRef?; return CGPDFDictionaryGetDictionary(dict, key, &result) ? result : nil
  }
  private static func inheritedDictionary(_ dict: CGPDFDictionaryRef, _ key: String) -> CGPDFDictionaryRef? {
    var current: CGPDFDictionaryRef? = dict
    for _ in 0..<32 {
      guard let value = current else { return nil }
      if let result = dictionary(value, key) { return result }
      current = dictionary(value, "Parent")
    }
    return nil
  }
  private static func name(_ dict: CGPDFDictionaryRef, _ key: String) -> String? {
    var result: UnsafePointer<CChar>?
    guard CGPDFDictionaryGetName(dict, key, &result), let result else { return nil }
    return String(cString: result)
  }
  private static func integer(_ dict: CGPDFDictionaryRef, _ key: String) -> Int? {
    var result: CGPDFInteger = 0; return CGPDFDictionaryGetInteger(dict, key, &result) ? result : nil
  }
  private static func number(_ dict: CGPDFDictionaryRef, _ key: String, fallback: Double) -> Double? {
    if !contains(dict, key) { return fallback }
    var result: CGPDFReal = 0; return CGPDFDictionaryGetNumber(dict, key, &result) ? Double(result) : nil
  }
}
