import ExpoModulesCore
import UIKit

/// CoreBluetooth state restoration: when iOS relaunches the app in the
/// background for an event of our central (the receiver came back in range,
/// a notification arrived), the central must be recreated with the same
/// restore identifier during launch so `willRestoreState` is delivered.
/// On any other launch nothing happens here: creating the central early
/// would show the Bluetooth permission prompt to users who never use a
/// receiver.
public class InukshukGnssAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let ids = launchOptions?[.bluetoothCentrals] as? [String], ids.contains(GnssLink.restoreIdentifier) {
      GnssLink.shared.restoreAtLaunch()
    }
    return true
  }
}
