import ExpoModulesCore

/// The Convert tool's PROJ engine (docs/ARCHITECTURE.md, Convert). Every
/// function is synchronous: a pinned pipeline on a handful of points is
/// microseconds, and the screen recomputes on each keystroke.
public final class InukshukProjModule: Module {
  public func definition() -> ModuleDefinition {
    Name("InukshukProj")

    Constant("supported") { true }

    Function("init") { (gridDirs: [String]) -> [String: Any] in
      INKProj.start(withGridDirs: gridDirs)
    }

    Function("transform") { (pipeline: String, coords: [Double], dim: Int) -> [String: Any] in
      INKProj.transform(pipeline, coords: coords.map { NSNumber(value: $0) }, dim: dim)
    }

    Function("transformCrs") { (src: String, dst: String, coords: [Double], dim: Int) -> [String: Any] in
      INKProj.transformCrs(src, dst: dst, coords: coords.map { NSNumber(value: $0) }, dim: dim)
    }

    Function("epsgOperation") { (code: String) -> [String: Any] in
      INKProj.epsgOperation(code)
    }
  }
}
