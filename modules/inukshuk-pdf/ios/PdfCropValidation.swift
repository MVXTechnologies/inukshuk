import Foundation
import CoreGraphics

struct PdfUnsupported: Error { let reason: String }
struct ImagePaint { let name: String; let rect: CGRect }

enum PdfCropValidation {
  // A deliberately small PDF content grammar. Every unrecognized operator is
  // rejected, so text, paths, clipping, inline images and form paints cannot vanish.
  static func paint(_ content: String, graphicsStates: Set<String>, colorSpaces: Set<String>) throws -> ImagePaint {
    func unsupported() -> PdfUnsupported { PdfUnsupported(reason: "Page is not a single opaque JPEG paint") }
    guard content.utf8.count <= 65536, content.utf8.allSatisfy({ $0 < 128 }) else { throw unsupported() }
    let tokens = content.split(whereSeparator: { $0.isWhitespace })
    guard tokens.count <= 1024 else { throw unsupported() }
    var operands: [String] = []
    var transform = CGAffineTransform.identity
    var stack: [CGAffineTransform] = []
    var result: ImagePaint?
    func name(_ token: String) -> String? {
      guard token.first == "/", token.count > 1,
        token.dropFirst().allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }) else { return nil }
      return String(token.dropFirst())
    }
    for tokenPart in tokens {
      let token = String(tokenPart)
      if token.first == "/" || Double(token) != nil {
        guard operands.count < 6 else { throw unsupported() }
        operands.append(token)
        continue
      }
      switch token {
      case "q":
        guard operands.isEmpty, stack.count < 32 else { throw unsupported() }
        stack.append(transform)
      case "Q":
        guard operands.isEmpty, let saved = stack.popLast() else { throw unsupported() }
        transform = saved
      case "cm":
        let values = operands.compactMap(Double.init)
        guard values.count == 6, values.allSatisfy({ $0.isFinite && abs($0) <= 1_000_000 }) else { throw unsupported() }
        let matrix = CGAffineTransform(a: values[0], b: values[1], c: values[2], d: values[3], tx: values[4], ty: values[5])
        transform = matrix.concatenating(transform)
        guard [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].allSatisfy({ $0.isFinite && abs($0) <= 1_000_000 }) else { throw unsupported() }
      case "gs", "cs", "CS":
        guard operands.count == 1, let resource = name(operands[0]),
          (token == "gs" ? graphicsStates : colorSpaces).contains(resource) else { throw unsupported() }
      case "Do":
        guard result == nil, operands.count == 1, let resource = name(operands[0]),
          transform.b == 0, transform.c == 0, transform.a > 0, transform.d > 0 else { throw unsupported() }
        result = ImagePaint(name: resource, rect: CGRect(x: transform.tx, y: transform.ty, width: transform.a, height: transform.d))
      default: throw unsupported()
      }
      operands.removeAll(keepingCapacity: true)
    }
    guard operands.isEmpty, stack.isEmpty, let result else { throw unsupported() }
    return result
  }
}
