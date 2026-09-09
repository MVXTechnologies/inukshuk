import Foundation
import CoreGraphics
import ImageIO

var checks = 0
func expect(_ value: @autoclosure () -> Bool, _ label: String) {
  checks += 1
  guard value() else { fatalError(label) }
}
func rejected(_ content: String) {
  do { _ = try PdfCropValidation.paint(content, graphicsStates: ["GSa"], colorSpaces: ["CSp"]); fatalError("Accepted unsafe content: \(content)") }
  catch { checks += 1 }
}
let eco = """
/GSa gs /CSp cs /CSp CS
0.240000000 0 0 -0.240000000 0 3024 cm
q q Q Q q q q /GSa gs 1 0 0 1 0 0 cm
14399 0 0 -12600 0 12600 cm /Im7 Do Q Q Q
"""
do {
  let paint = try PdfCropValidation.paint(eco, graphicsStates: ["GSa"], colorSpaces: ["CSp"])
  expect(paint.name == "Im7", "Recognize actual Eco image")
  expect(abs(paint.rect.width - 3455.76) < 0.00001 && paint.rect.height == 3024, "Preserve fractional source placement")
  let simple = try PdfCropValidation.paint("q 100 0 0 200 0 0 cm /Im1 Do Q", graphicsStates: [], colorSpaces: [])
  expect(simple.rect == CGRect(x: 0, y: 0, width: 100, height: 200), "Simple image transform")
} catch { fatalError("Valid fixture rejected: \(error)") }
for content in [
  "q 100 0 0 200 0 0 cm /Im1 Do Q BT (hidden text) Tj ET",
  "q 100 0 0 200 0 0 cm /Im1 Do /Im2 Do Q",
  "q 0 0 10 10 re W n 100 0 0 200 0 0 cm /Im1 Do Q",
  "q /Unknown gs 100 0 0 200 0 0 cm /Im1 Do Q",
  "q 100 1 0 200 0 0 cm /Im1 Do Q",
  "q 100 0 0 -200 0 0 cm /Im1 Do Q",
  "q 100 0 0 200 0 0 cm /Im1 Do", "Q /Im1 Do", "q NaN 0 0 200 0 0 cm /Im1 Do Q",
  "q 100 0 0 200 0 0 cm /Im#31 Do Q", "q 100 0 0 200 0 0 cm /Im1 Do Q 7",
  String(repeating: "q ", count: 40) + "/Im1 Do", String(repeating: " ", count: 65537)
] { rejected(content) }
print("Passed \(checks) validation checks")

let tinyJPEG = Data(base64Encoded: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5Pooor+rD+az/2Q==")!
let temp = FileManager.default.temporaryDirectory.appendingPathComponent("inukshuk-pdf-tests-\(UUID().uuidString)")
let documents = temp.appendingPathComponent("Documents")
let caches = temp.appendingPathComponent("Caches")
try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: caches, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temp) }
func fixture(_ content: String = "q 100 0 0 100 0 0 cm /Im1 Do Q", pageExtra: String = "", imageExtra: String = "", resourcesExtra: String = "", jpeg: Data = tinyJPEG, width: Int = 8, height: Int = 8) throws -> URL {
  var pdf = Data("%PDF-1.4\n".utf8)
  var offsets = [0]
  let objects: [Data] = [
    Data("<< /Type /Catalog /Pages 2 0 R >>".utf8),
    Data("<< /Type /Pages /Kids [3 0 R] /Count 1 >>".utf8),
    Data("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 5 0 R >> \(resourcesExtra) >> /Contents 4 0 R \(pageExtra) >>".utf8),
    Data("<< /Length \(content.utf8.count) >>\nstream\n\(content)\nendstream".utf8),
    Data("<< /Type /XObject /Subtype /Image /Width \(width) /Height \(height) /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode /Length \(jpeg.count) \(imageExtra) >>\nstream\n".utf8) + jpeg + Data("\nendstream".utf8)
  ]
  for (index, object) in objects.enumerated() {
    offsets.append(pdf.count)
    pdf.append(Data("\(index + 1) 0 obj\n".utf8)); pdf.append(object); pdf.append(Data("\nendobj\n".utf8))
  }
  let xref = pdf.count
  pdf.append(Data("xref\n0 \(offsets.count)\n0000000000 65535 f \n".utf8))
  for offset in offsets.dropFirst() { pdf.append(Data(String(format: "%010d 00000 n \n", offset).utf8)) }
  pdf.append(Data("trailer\n<< /Size \(offsets.count) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n".utf8))
  let url = documents.appendingPathComponent("\(UUID().uuidString).pdf")
  try pdf.write(to: url)
  return url
}
func request(_ file: URL, pageIndex: Double = 0, width: Double = 100, x0: Double = 0, x1: Double = 1, target: Double = 100) -> PdfCropRequest {
  PdfCropRequest(fileUri: file.absoluteString, pageIndex: pageIndex, pageWidthPt: width, pageHeightPt: 100,
    x0: x0, y0: 0, x1: x1, y1: 1, targetWidthPx: target)
}
func render(_ request: PdfCropRequest) throws -> [String: Any] {
  try autoreleasepool { try PdfJpegCrop.render(request, documents: documents, caches: caches) }
}
func rejectRender(_ request: PdfCropRequest) {
  do { _ = try render(request); fatalError("Unsafe PDF was rendered") }
  catch is PdfUnsupported { checks += 1 }
  catch { fatalError("Unexpected error: \(error)") }
}
expect(PdfJpegCrop.baselineJPEG(tinyJPEG as CFData, width: 8, height: 8), "Baseline fixture accepted")
expect(!PdfJpegCrop.baselineJPEG(tinyJPEG as CFData, width: 9, height: 8), "JPEG dimensions verified")
var progressive = tinyJPEG
if let sof = progressive.range(of: Data([255, 192])) { progressive[sof.lowerBound + 1] = 194 }
expect(!PdfJpegCrop.baselineJPEG(progressive as CFData, width: 8, height: 8), "Progressive JPEG rejected before decode")
// A baseline frame alone does not prove a single interleaved scan. Split
// component scans can require full-frame decoding, outside the measured budget.
func replacingScan(_ payload: [UInt8]) -> Data {
  guard let marker = tinyJPEG.range(of: Data([255, 218])) else { fatalError("Missing fixture SOS") }
  let start = marker.upperBound
  let length = Int(tinyJPEG[start]) * 256 + Int(tinyJPEG[start + 1])
  var modified = tinyJPEG
  modified.replaceSubrange(start..<(start + length), with: payload)
  return modified
}
let separateScan = replacingScan([0, 8, 1, 1, 0, 0, 63, 0])
expect(!PdfJpegCrop.baselineJPEG(separateScan as CFData, width: 8, height: 8), "Noninterleaved baseline scan rejected")
for scan in [
  [0, 12, 3, 1, 0, 1, 0, 3, 0, 0, 63, 0], // Duplicate component.
  [0, 12, 3, 1, 0, 2, 0, 4, 0, 0, 63, 0], // Component absent from frame.
  [0, 12, 3, 1, 0, 2, 0, 3, 0, 1, 63, 0], // Spectral start.
  [0, 12, 3, 1, 0, 2, 0, 3, 0, 0, 62, 0], // Spectral end.
  [0, 12, 3, 1, 0, 2, 0, 3, 0, 0, 63, 1]  // Successive approximation.
] as [[UInt8]] {
  expect(!PdfJpegCrop.baselineJPEG(replacingScan(scan) as CFData, width: 8, height: 8), "Unsafe JPEG scan parameters rejected")
}
let valid = try fixture()
let emptyAnnotations = try render(request(try fixture(pageExtra: "/Annots []")))
expect(emptyAnnotations["widthPx"] as? Int == 100, "Empty annotation array remains supported")
let output = try render(request(valid))
expect(output["widthPx"] as? Int == 100 && output["heightPx"] as? Int == 100, "End-to-end PNG dimensions")
let resultURL = URL(string: output["fileUri"] as! String)!
let png = CGImageSourceCreateWithURL(resultURL as CFURL, nil)!
expect(CGImageSourceGetCount(png) == 1, "PNG is readable")
let bounded = try render(request(valid, target: 10000))
let boundedWidth = bounded["widthPx"] as! Int, boundedHeight = bounded["heightPx"] as! Int
expect(boundedWidth <= 3072 && boundedHeight <= 3072 && boundedWidth * boundedHeight <= 3 * 1024 * 1024, "Output area and edge budgets")
for pdf in [
  try fixture("q 100 0 0 100 0 0 cm /Im1 Do Q BT (label) Tj ET"),
  try fixture("q 100 0 0 100 0 0 cm /Im1 Do /Im1 Do Q"),
  try fixture(pageExtra: "/Annots [<< /Subtype /Text /Rect [0 0 10 10] >>]"), try fixture(pageExtra: "/Rotate 90"),
  try fixture(pageExtra: "/UserUnit 2"), try fixture(pageExtra: "/CropBox [10 0 100 100]"),
  try fixture(pageExtra: "/Group << /S /Transparency >>"),
  try fixture(imageExtra: "/SMask 5 0 R"), try fixture(imageExtra: "/Decode [1 0 1 0 1 0]"),
  try fixture(resourcesExtra: "/ColorSpace << /DefaultRGB /DeviceRGB >>"),
  try fixture("/G1 gs q 100 0 0 100 0 0 cm /Im1 Do Q", resourcesExtra: "/ExtGState << /G1 << /ca 0.5 >> >>"),
  try fixture(String(repeating: " ", count: 4097)), try fixture(jpeg: progressive)
] { rejectRender(request(pdf)) }
for invalid in [request(valid, pageIndex: 0.5), request(valid, pageIndex: .nan), request(valid, width: 101), request(valid, x0: -0.01), request(valid, x1: 0), request(valid, target: .infinity)] { rejectRender(invalid) }
let outside = temp.appendingPathComponent("outside.pdf")
try FileManager.default.copyItem(at: valid, to: outside)
rejectRender(request(outside))
let symlink = documents.appendingPathComponent("escape.pdf")
try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)
rejectRender(request(symlink))
expect(!PdfJpegCrop.within(temp.appendingPathComponent("Documents-other/a.pdf"), documents), "Private path sibling is rejected")

// --- #331: a single JPEG larger than the decode budget (the Eco class) ---
// ImageIO's encoder adds APP1/APP2 segments the crop grammar rejects on
// purpose (only what the measured Eco export writes is accepted); strip them
// so the fixture is the plain baseline JFIF a map exporter writes.
func stripAppSegments(_ jpeg: Data) -> Data {
  var out = Data(jpeg.prefix(2)), offset = 2
  let bytes = [UInt8](jpeg)
  while offset + 4 <= bytes.count, bytes[offset] == 255 {
    let marker = bytes[offset + 1]
    if marker == 0xDA { out.append(jpeg.suffix(from: offset)); return out }
    let length = Int(bytes[offset + 2]) * 256 + Int(bytes[offset + 3])
    if !(0xE1...0xEF).contains(marker) && marker != 0xFE { out.append(jpeg.subdata(in: offset..<(offset + 2 + length))) }
    offset += 2 + length
  }
  return out
}
/// Quadrants: top-left red, top-right green, bottom-left blue, bottom-right yellow.
func quadrantJPEG(width: Int, height: Int) -> Data {
  let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  let half = CGSize(width: Double(width) / 2, height: Double(height) / 2)
  for (color, origin) in [(CGColor(red: 1, green: 0, blue: 0, alpha: 1), CGPoint(x: 0, y: half.height)),
    (CGColor(red: 0, green: 1, blue: 0, alpha: 1), CGPoint(x: half.width, y: half.height)),
    (CGColor(red: 0, green: 0, blue: 1, alpha: 1), CGPoint(x: 0, y: 0)),
    (CGColor(red: 1, green: 1, blue: 0, alpha: 1), CGPoint(x: half.width, y: 0))] {
    context.setFillColor(color)
    context.fill(CGRect(origin: origin, size: half))
  }
  let data = NSMutableData()
  let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
  CGImageDestinationFinalize(destination)
  return stripAppSegments(data as Data)
}
func footprintMB() -> Int {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(MemoryLayout<task_vm_info>.size) / 4
  let result = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
  }
  return result == KERN_SUCCESS ? Int(info.phys_footprint / 1_048_576) : -1
}
var peakFootprint = footprintMB()
let footprintSampler = Thread { while true { peakFootprint = max(peakFootprint, footprintMB()); usleep(1000) } }
footprintSampler.start()
func peakFootprintMB() -> Int { peakFootprint }
/// RGB at an output pixel (PNG origin top-left).
func pixel(_ output: [String: Any], x: Int, y: Int) -> [Int] {
  let url = URL(string: output["fileUri"] as! String)!
  let image = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url as CFURL, nil)!, 0, nil)!
  let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  let bytes = context.data!.assumingMemoryBound(to: UInt8.self)
  let index = (y * image.width + x) * 4
  return [Int(bytes[index]), Int(bytes[index + 1]), Int(bytes[index + 2])]
}
// JPEG chroma subsampling bleeds ~40 levels at a saturated edge; the quadrant colors differ by 255.
func near(_ rgb: [Int], _ expected: [Int]) -> Bool { zip(rgb, expected).allSatisfy { abs($0 - $1) <= 80 } }
let red = [255, 0, 0], green = [0, 255, 0], blue = [0, 0, 255], yellow = [255, 255, 0]
// Pure reduction rule, with the Eco page's own numbers (14399×12600).
let ecoFrame = CGRect(x: 0, y: 0, width: 14399, height: 12600)
expect(PdfJpegCrop.decodeReduction(sourceWidth: 14399, sourceHeight: 12600, crop: CGRect(x: 0, y: 0, width: 4000, height: 4000), outputScale: 0.5) == 1, "Crops inside the budget keep the lazy full-resolution decode")
expect(PdfJpegCrop.decodeReduction(sourceWidth: 14399, sourceHeight: 12600, crop: ecoFrame, outputScale: 1896.0 / 14399) == 4, "Eco overview decodes at 1/4: 1/2 exceeds the budget, 1/8 lacks resolution")
expect(PdfJpegCrop.decodeReduction(sourceWidth: 14399, sourceHeight: 12600, crop: ecoFrame, outputScale: 0.1) == 8, "Coarser output takes the coarser reduction")
expect(PdfJpegCrop.decodeReduction(sourceWidth: 14399, sourceHeight: 12600, crop: ecoFrame, outputScale: 0.6) == 4, "When no fitting reduction carries the resolution, the finest fitting one is used")
expect(PdfJpegCrop.decodeReduction(sourceWidth: 5000, sourceHeight: 4000, crop: CGRect(x: 0, y: 0, width: 5000, height: 4000), outputScale: 0.3) == 2, "A 20 MP page needs only 1/2")
expect(PdfJpegCrop.decodeReduction(sourceWidth: 20000, sourceHeight: 20000, crop: CGRect(x: 0, y: 0, width: 20000, height: 20000), outputScale: 1) == 8, "The edge cap keeps every source decodable: 1/8 of a 20,000 px edge fits")
// End to end: a 5000×4000 (20 MP) single-JPEG page. Before #331 the full page
// was "Source crop exceeds decode budget" and fell back to PDF.js.
let bigJPEG = quadrantJPEG(width: 5000, height: 4000)
expect(PdfJpegCrop.baselineJPEG(bigJPEG as CFData, width: 5000, height: 4000), "Generated large JPEG is baseline")
let bigPage = try fixture(jpeg: bigJPEG, width: 5000, height: 4000)
func bigRequest(x0: Double, y0: Double, x1: Double, y1: Double, target: Double) -> PdfCropRequest {
  PdfCropRequest(fileUri: bigPage.absoluteString, pageIndex: 0, pageWidthPt: 100, pageHeightPt: 100, x0: x0, y0: y0, x1: x1, y1: y1, targetWidthPx: target)
}
let overview = try render(bigRequest(x0: 0, y0: 0, x1: 1, y1: 1, target: 1000))
expect(overview["widthPx"] as? Int == 1000 && overview["heightPx"] as? Int == 1000, "Full page above the decode budget renders")
expect(near(pixel(overview, x: 250, y: 250), red) && near(pixel(overview, x: 750, y: 250), green)
  && near(pixel(overview, x: 250, y: 750), blue) && near(pixel(overview, x: 750, y: 750), yellow), "Reduced decode keeps orientation and placement")
let wide = try render(bigRequest(x0: 0.1, y0: 0.1, x1: 0.95, y1: 0.95, target: 2000))
expect(wide["widthPx"] as? Int == 1773 && wide["heightPx"] as? Int == 1773, "A partial crop above the budget renders reduced within the output budget")
expect(near(pixel(wide, x: 200, y: 200), red) && near(pixel(wide, x: 1600, y: 1600), yellow), "Partial reduced crop is placed like the full-resolution path")
let quarter = try render(bigRequest(x0: 0.5, y0: 0, x1: 1, y1: 0.5, target: 500))
expect(quarter["widthPx"] as? Int == 500 && near(pixel(quarter, x: 250, y: 250), green), "Crops inside the budget still decode at full resolution")
try runMosaicTests(documents: documents, caches: caches)
if CommandLine.arguments.count > 1 {
  let original = URL(fileURLWithPath: CommandLine.arguments[1])
  let local = documents.appendingPathComponent("eco.pdf")
  try FileManager.default.copyItem(at: original, to: local)
  let ecoRequest = PdfCropRequest(fileUri: local.absoluteString, pageIndex: 0, pageWidthPt: 3456, pageHeightPt: 3024,
    x0: 0.5625, y0: 0.1875, x1: 0.8125, y1: 0.4375, targetWidthPx: 1896)
  // #331: the whole 181 MP page (the map's overview) decodes at a JPEG DCT
  // reduction instead of being refused into PDF.js, which cannot survive it.
  let ecoOverviewStart = ProcessInfo.processInfo.systemUptime
  let ecoOverview = try render(PdfCropRequest(fileUri: local.absoluteString, pageIndex: 0, pageWidthPt: 3456, pageHeightPt: 3024,
    x0: 0, y0: 0, x1: 1, y1: 1, targetWidthPx: 2048))
  expect(ecoOverview["widthPx"] as? Int == 1896 && ecoOverview["heightPx"] as? Int == 1659, "Original Eco overview size")
  print("Eco overview: \(Int((ProcessInfo.processInfo.systemUptime - ecoOverviewStart) * 1000)) ms, footprint \(footprintMB()) MB (peak \(peakFootprintMB()) MB)")
  let ecoHalf = try render(PdfCropRequest(fileUri: local.absoluteString, pageIndex: 0, pageWidthPt: 3456, pageHeightPt: 3024,
    x0: 0, y0: 0, x1: 0.5, y1: 0.5, targetWidthPx: 3072))
  expect(ecoHalf["widthPx"] as? Int == 1896, "Original Eco quarter-page crop above the decode budget renders reduced")
  let ecoOutput = try render(ecoRequest)
  expect(ecoOutput["widthPx"] as? Int == 1896 && ecoOutput["heightPx"] as? Int == 1659, "Original Eco output size")
  print("Eco integration: \(ecoOutput)")
  if CommandLine.arguments.count > 2 {
    try FileManager.default.copyItem(at: URL(string: ecoOutput["fileUri"] as! String)!, to: URL(fileURLWithPath: CommandLine.arguments[2]))
  }
}
print("Passed \(checks) total native validation/render checks")
