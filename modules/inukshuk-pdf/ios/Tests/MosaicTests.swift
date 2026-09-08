import Foundation
import CoreGraphics
import ImageIO

// Literal-colour complete PDFs catch missing tiles, swapped indexed palettes,
// incorrect page placement, cracks between paints and accidental white margins.
func runMosaicTests(documents: URL, caches: URL) throws {
  var checks = 0
  func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    checks += 1
    if !condition() { fatalError(message) }
  }
  func deflate(_ bytes: [UInt8]) -> Data {
    precondition(bytes.count < 65536)
    let count = UInt16(bytes.count), complement = ~UInt16(bytes.count)
    var data = Data([0x78, 0x01, 0x01, UInt8(count & 255), UInt8(count >> 8), UInt8(complement & 255), UInt8(complement >> 8)])
    data.append(contentsOf: bytes)
    var a: UInt32 = 1, b: UInt32 = 0
    for byte in bytes { a = (a + UInt32(byte)) % 65521; b = (b + a) % 65521 }
    let adler = b << 16 | a
    data.append(contentsOf: [24, 16, 8, 0].map { UInt8((adler >> $0) & 255) })
    return data
  }
  func stream(_ bytes: Data, _ extra: String = "") -> Data {
    Data("<< /Length \(bytes.count) \(extra) >>\nstream\n".utf8) + bytes + Data("\nendstream".utf8)
  }
  let paints = "q 40 0 0 80 10 10 cm /Left Do Q q 40 0 0 80 50 10 cm /Right Do Q"
  func fixture(content: String? = nil, indexed: Bool = false, paletteStream: Bool = false,
    pageExtra: String = "", imageExtra: String = "", malformedBytes: Bool = false,
    splitContent: Bool = false, resourceExtra: String = "", rightExtra: String = "", imageWidth: Int = 2, mediaBox: String = "0 0 100 100") throws -> URL {
    let instructions = content ?? paints
    let red = deflate(malformedBytes ? [255, 0, 0] : Array(repeating: [UInt8(255), 0, 0], count: 4).flatMap { $0 })
    let blue = deflate(indexed ? [0, 1, 0, 1] : Array(repeating: [UInt8(0), 0, 255], count: 4).flatMap { $0 })
    let palette = "<0000ff00ff00>" // index0 blue, index1 green
    let rightColor = indexed ? "[/Indexed /DeviceRGB 1 \(paletteStream ? "7 0 R" : palette)]" : "/DeviceRGB"
    let left = stream(red, "/Type /XObject /Subtype /Image /Width \(imageWidth) /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode \(imageExtra)")
    let right = stream(blue, "/Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace \(rightColor) /Filter /FlateDecode \(rightExtra)")
    let contentReference = splitContent ? "[4 0 R 8 0 R]" : "4 0 R"
    let split = splitContent ? instructions.index(instructions.startIndex, offsetBy: 29) : instructions.endIndex
    let objects = [
      Data("<< /Type /Catalog /Pages 2 0 R >>".utf8),
      Data("<< /Type /Pages /Kids [3 0 R] /Count 1 >>".utf8),
      Data("<< /Type /Page /Parent 2 0 R /MediaBox [\(mediaBox)] /Resources << /XObject << /Left 5 0 R /Right 6 0 R >> \(resourceExtra) >> /Contents \(contentReference) \(pageExtra) >>".utf8),
      stream(deflate(Array(instructions[..<split].utf8)), "/Filter /FlateDecode"), left, right,
      stream(deflate([0, 0, 255, 0, 255, 0]), "/Filter /FlateDecode"),
      stream(deflate(Array(instructions[split...].utf8)), "/Filter /FlateDecode")
    ]
    var pdf = Data("%PDF-1.4\n".utf8), offsets = [0]
    for (i, object) in objects.enumerated() {
      offsets.append(pdf.count); pdf.append(Data("\(i + 1) 0 obj\n".utf8)); pdf.append(object); pdf.append(Data("\nendobj\n".utf8))
    }
    let xref = pdf.count
    pdf.append(Data("xref\n0 \(offsets.count)\n0000000000 65535 f \n".utf8))
    for offset in offsets.dropFirst() { pdf.append(Data(String(format: "%010d 00000 n \n", offset).utf8)) }
    pdf.append(Data("trailer\n<< /Size \(offsets.count) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF".utf8))
    let url = documents.appendingPathComponent("mosaic-\(UUID().uuidString).pdf")
    try pdf.write(to: url); return url
  }
  func render(_ file: URL, x0: Double = 0, x1: Double = 1, target: Double = 100) throws -> [String: Any] {
    try autoreleasepool {
      try PdfJpegCrop.render(PdfCropRequest(fileUri: file.absoluteString, pageIndex: 0,
        pageWidthPt: 100, pageHeightPt: 100, x0: x0, y0: 0, x1: x1, y1: 1, targetWidthPx: target), documents: documents, caches: caches)
    }
  }
  func pixels(_ result: [String: Any]) -> (Int, Int, [UInt8]) {
    let source = CGImageSourceCreateWithURL(URL(string: result["fileUri"] as! String)! as CFURL, nil)!
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
    let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
      bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return (image.width, image.height, Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: image.width * image.height * 4)))
  }
  func color(_ p: (Int, Int, [UInt8]), _ x: Int, _ y: Int) -> [UInt8] {
    let offset = (y * p.0 + x) * 4; return Array(p.2[offset..<(offset + 3)])
  }
  let basic = try fixture()
  let image = pixels(try render(basic))
  require(image.0 == 100 && image.1 == 100, "Mosaic output dimensions")
  require(color(image, 25, 50) == [255, 0, 0], "Left RGB paint retained")
  require(color(image, 75, 50) == [0, 0, 255], "Right RGB paint retained")
  require(color(image, 5, 50) == [255, 255, 255] && color(image, 50, 5) == [255, 255, 255], "White page margins preserved")
  require(color(image, 49, 50) == [255, 0, 0] && color(image, 50, 50) == [0, 0, 255], "Adjacent paint seam has no white crack")
  let cropped = pixels(try render(basic, x0: 0.5, x1: 1, target: 50))
  require(color(cropped, 25, 50) == [0, 0, 255], "Crop retains page-space placement")
  for stream in [false, true] {
    let indexed = pixels(try render(fixture(indexed: true, paletteStream: stream)))
    require(color(indexed, 55, 50) == [0, 0, 255], "Indexed blue lookup")
    require(color(indexed, 85, 50) == [0, 255, 0], "Indexed green lookup")
  }
  let split = pixels(try render(fixture(splitContent: true)))
  require(color(split, 25, 50) == [255, 0, 0] && color(split, 75, 50) == [0, 0, 255], "Content array preserves graphics state across streams")
  let vertical = pixels(try render(fixture(content: "q 80 0 0 40 10 50 cm /Left Do Q q 80 0 0 40 10 10 cm /Right Do Q")))
  require(color(vertical, 50, 25) == [255, 0, 0] && color(vertical, 50, 75) == [0, 0, 255], "PDF top/bottom placement remains upright")
  let overlapping = pixels(try render(fixture(content: "q 80 0 0 80 10 10 cm /Left Do Q q 40 0 0 40 30 30 cm /Right Do Q")))
  require(color(overlapping, 50, 50) == [0, 0, 255], "Later opaque image paint wins overlaps")
  do {
    _ = try render(fixture(rightExtra: "/SMask 5 0 R"), x0: 0, x1: 0.5, target: 50)
    fatalError("Unsupported off-crop paint escaped prevalidation")
  } catch is PdfUnsupported { checks += 1 }
  let large = try render(basic, target: 10000)
  require((large["widthPx"] as! Int) * (large["heightPx"] as! Int) <= 3 * 1024 * 1024, "Mosaic output budget")
  for (index, invalid) in [
    try fixture(content: paints + " BT (label) Tj ET"),
    try fixture(content: paints + " 0 0 1 1 re f"),
    try fixture(content: "q 40 1 0 80 10 10 cm /Left Do Q"),
    try fixture(content: "q 40 0 0 -80 10 90 cm /Left Do Q"),
    try fixture(content: paints + " Q"),
    try fixture(imageExtra: "/Subtype /Form"),
    try fixture(imageExtra: "/SMask 6 0 R"),
    try fixture(imageExtra: "/Mask [0 0 0 0 0 0]"),
    try fixture(imageExtra: "/Decode [1 0 1 0 1 0]"),
    try fixture(imageExtra: "/DecodeParms << /Predictor 12 /Columns 2 >>"),
    try fixture(malformedBytes: true),
    try fixture(imageWidth: 2049),
    try fixture(pageExtra: "/Rotate 90"),
    try fixture(pageExtra: "/UserUnit 2"),
    try fixture(pageExtra: "/CropBox [0 0 90 100]"),
    try fixture(mediaBox: "10 0 110 100"),
    try fixture(pageExtra: "/Annots [<< /Subtype /Text >>]"),
    try fixture(pageExtra: "/Group << /S /Transparency >>"),
    try fixture(resourceExtra: "/ColorSpace << /DefaultRGB /DeviceRGB >>")
  ].enumerated() {
    do { _ = try render(invalid); fatalError("Unsupported mosaic accepted at index \(index)") }
    catch is PdfUnsupported { checks += 1 }
  }
  if let corpus = ProcessInfo.processInfo.environment["INUKSHUK_NORD_PDF"] {
    let local = documents.appendingPathComponent("nord-corpus.pdf")
    try FileManager.default.copyItem(at: URL(fileURLWithPath: corpus), to: local)
    for crop in [(0.0, 0.0, 1.0, 1.0), (0.5, 0.1875, 0.75, 0.4375)] {
      let result = try autoreleasepool {
        try PdfJpegCrop.render(PdfCropRequest(fileUri: local.absoluteString, pageIndex: 0,
          pageWidthPt: 3370.39, pageHeightPt: 2383.94,
          x0: crop.0, y0: crop.1, x1: crop.2, y1: crop.3, targetWidthPx: 1896), documents: documents, caches: caches)
      }
      require(result["widthPx"] as? Int == 1896 && result["heightPx"] as? Int == 1341, "Original NORD overview/crop dimensions")
      let bitmap = pixels(result)
      require(bitmap.2.enumerated().contains { $0.offset % 4 != 3 && $0.element < 128 }, "Original NORD output contains map ink")
      print("NORD integration: \(result)")
    }
  }
  print("Passed \(checks) mosaic render checks")
}
