import ExpoModulesCore
import UIKit

/// Switches between the primary icon and the alternates compiled into this
/// build (plugins/with-app-icons.cjs). iOS shows its own alert after every
/// change, so JavaScript calls setIconName only once a choice is final.
public class MeroSplitAppIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MeroSplitAppIcon")

    // Empty when this device cannot change icons or the build has none.
    AsyncFunction("getAvailableIcons") { () -> [String] in
      UIApplication.shared.supportsAlternateIcons ? Self.alternateNames() : []
    }.runOnQueue(.main)

    // nil means the primary icon is showing.
    AsyncFunction("getIconName") { () -> String? in
      UIApplication.shared.alternateIconName
    }.runOnQueue(.main)

    AsyncFunction("setIconName") { (name: String?, promise: Promise) in
      guard UIApplication.shared.supportsAlternateIcons else {
        promise.reject("ERR_APP_ICON_UNSUPPORTED", "This device cannot change the app icon.")
        return
      }
      if let name, !Self.alternateNames().contains(name) {
        promise.reject("ERR_APP_ICON_MISSING", "Update MeroSplit to use this icon.")
        return
      }
      if UIApplication.shared.alternateIconName == name {
        promise.resolve()
        return
      }
      UIApplication.shared.setAlternateIconName(name) { error in
        if let error {
          promise.reject("ERR_APP_ICON", error.localizedDescription)
        } else {
          promise.resolve()
        }
      }
    }.runOnQueue(.main)
  }

  private static func alternateNames() -> [String] {
    let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
    let alternates = icons?["CFBundleAlternateIcons"] as? [String: Any]
    return alternates.map { Array($0.keys).sorted() } ?? []
  }
}
