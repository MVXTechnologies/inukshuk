import ExpoModulesCore
import UIKit

struct TerrainConfig: Record {
  @Field var look: [Double] = []
  @Field var enabled: Bool = true
  @Field var networkAllowed: Bool = true
  @Field var maxPitch: Double = 80
}

struct BenchStep: Record {
  @Field var kind: String = "idle"
  @Field var durationMs: Double = 0
  @Field var amount: Double = 0
}

/// Native 3D terrain inside the MapLibre map (docs/plans/native-terrain.md).
/// JS attaches it to a host view that contains the <Map>; every frame after
/// that is native (INKTerrainController: shared C++ engine + Metal).
public final class InukshukTerrainModule: Module {
  private var controllers: [Int: INKTerrainController] = [:]

  public func definition() -> ModuleDefinition {
    Name("InukshukTerrain")

    Constant("supported") { true }

    OnDestroy {
      DispatchQueue.main.async { [controllers] in
        controllers.values.forEach { $0.detach() }
      }
    }

    AsyncFunction("attach") { (viewTag: Int, config: TerrainConfig) -> Bool in
      guard let host = self.appContext?.findView(withTag: viewTag, ofType: UIView.self),
        let mapView = INKTerrainController.findMapView(in: host),
        let controller = INKTerrainController(mapView: mapView)
      else { return false }
      self.controllers.removeValue(forKey: viewTag)?.detach()
      let ok = controller.attach(
        withLook: config.look.map { NSNumber(value: $0) },
        enabled: config.enabled,
        networkAllowed: config.networkAllowed,
        maxPitch: config.maxPitch)
      if ok { self.controllers[viewTag] = controller }
      return ok
    }.runOnQueue(.main)

    Function("update") { (viewTag: Int, config: TerrainConfig) in
      let look = config.look.map { NSNumber(value: $0) }
      let enabled = config.enabled
      let net = config.networkAllowed
      DispatchQueue.main.async {
        self.controllers[viewTag]?.update(withLook: look, enabled: enabled, networkAllowed: net)
      }
    }

    AsyncFunction("detach") { (viewTag: Int) in
      self.controllers.removeValue(forKey: viewTag)?.detach()
    }.runOnQueue(.main)

    AsyncFunction("stats") { (viewTag: Int) -> [Double] in
      (self.controllers[viewTag]?.stats() ?? []).map { $0.doubleValue }
    }.runOnQueue(.main)

    AsyncFunction("trimMemory") { (viewTag: Int) in
      self.controllers[viewTag]?.trimMemory()
    }.runOnQueue(.main)

    AsyncFunction("runBench") { (viewTag: Int, script: [BenchStep], promise: Promise) in
      guard let c = self.controllers[viewTag] else {
        promise.resolve(nil)
        return
      }
      let steps: [[String: Any]] = script.map {
        ["kind": $0.kind, "durationMs": $0.durationMs, "amount": $0.amount]
      }
      c.setRecording(true)
      c.runBench(withSteps: steps) {
        let times = c.takeFrameTimes(false).map { $0.doubleValue }
        let costs = c.takeFrameTimes(true).map { $0.doubleValue }
        c.setRecording(false)
        promise.resolve([
          "frameTimesNs": times,
          "costNs": costs,
          "stats": c.stats().map { $0.doubleValue },
        ])
      }
    }.runOnQueue(.main)

    AsyncFunction("record") { (viewTag: Int, on: Bool) -> [String: [Double]]? in
      guard let c = self.controllers[viewTag] else { return nil }
      if on {
        c.setRecording(true)
        return nil
      }
      let times = c.takeFrameTimes(false).map { $0.doubleValue }
      let costs = c.takeFrameTimes(true).map { $0.doubleValue }
      c.setRecording(false)
      return ["frameTimesNs": times, "costNs": costs]
    }.runOnQueue(.main)
  }
}
