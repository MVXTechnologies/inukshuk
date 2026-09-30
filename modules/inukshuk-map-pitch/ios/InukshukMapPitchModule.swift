import ExpoModulesCore
import UIKit

/// Raises the maximum camera pitch of the MapLibre maps on screen (#480).
///
/// @maplibre/maplibre-react-native 11.4 exposes no max-pitch prop, so every
/// map keeps `MLNMapView.maximumPitch`'s default of 60°. JS calls
/// `setMaxPitch` once a map has finished loading; this walks the app's
/// windows and sets `maximumPitch` on every `MLNMapView` (MLRNMapView is a
/// subclass) it finds.
///
/// By class NAME and key-value coding on purpose: the module then needs no
/// link-time MapLibre dependency (the RN wrapper pulls MapLibre in through
/// Swift Package Manager), and a missing class or key degrades to "still 60°"
/// rather than a build break.
public class InukshukMapPitchModule: Module {
  public func definition() -> ModuleDefinition {
    Name("InukshukMapPitch")

    AsyncFunction("setMaxPitch") { (degrees: Double) -> Int in
      guard let mapClass = NSClassFromString("MLNMapView") else { return 0 }
      var applied = 0
      for scene in UIApplication.shared.connectedScenes {
        guard let windowScene = scene as? UIWindowScene else { continue }
        for window in windowScene.windows {
          Self.forEachView(window) { view in
            guard view.isKind(of: mapClass),
              view.responds(to: NSSelectorFromString("setMaximumPitch:"))
            else { return }
            view.setValue(NSNumber(value: degrees), forKey: "maximumPitch")
            applied += 1
          }
        }
      }
      return applied
    }.runOnQueue(.main)
  }

  private static func forEachView(_ view: UIView, _ visit: (UIView) -> Void) {
    visit(view)
    for child in view.subviews {
      forEachView(child, visit)
    }
  }
}
