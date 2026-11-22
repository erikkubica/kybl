import Photos
import PhotosUI
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

struct RunNowArgs: Decodable {
  let setId: String?
}

/// The iOS half of src/backup/mod.rs: Photos access (with the limited-library state), picking a
/// Files folder, scheduling the background tasks and "Back up now".
class KyblBackupPlugin: Plugin, UIDocumentPickerDelegate {
  private var picking: Invoke?

  public override func load(webview: WKWebView) {
    Net.start()
    DispatchQueue.main.async { Power.watch() }
    BackupTasks.schedule()
    // "Backs up while Kybl is open": opening Kybl, and coming back to it, start a run
    NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    // the device name for the {device} token, read on the main thread
    let name = UIDevice.current.name
    DispatchQueue.global(qos: .utility).async {
      _ = try? Engine.call("device", ["name": name])
      self.kick()
    }
  }

  @objc private func becameActive() {
    DispatchQueue.global(qos: .utility).async { self.kick() }
  }

  /// A run, when a set is on (and Photos access allows it for camera roll sets).
  private func kick() {
    let sets = (try? Engine.sets()) ?? []
    if sets.contains(where: { $0["enabled"] as? Bool ?? true }) {
      BackupRunner.shared.start(manual: false)
    }
  }

  private func state() -> [String: Any] {
    return ["photos": PhotoSource.state(), "location": true, "notifications": true]
  }

  @objc public func permission(_ invoke: Invoke) {
    invoke.resolve(state())
  }

  @objc public func requestPermission(_ invoke: Invoke) {
    PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
      BackupTasks.schedule()
      invoke.resolve(self.state())
    }
  }

  /// Limited access: the picker to choose more photos. Otherwise Kybl's page in Settings.
  @objc public func manageAccess(_ invoke: Invoke) {
    DispatchQueue.main.async {
      if PhotoSource.access() == .limited, let vc = self.presenter() {
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: vc)
        invoke.resolve(self.state())
        return
      }
      if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
      }
      invoke.resolve(self.state())
    }
  }

  private func presenter() -> UIViewController? {
    var vc = manager.viewController
    while let next = vc?.presentedViewController, !next.isBeingDismissed {
      vc = next
    }
    return vc
  }

  /// A folder from Files (on the phone, iCloud Drive, or another app's storage).
  @objc public func pickFolder(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let vc = self.presenter() else {
        invoke.reject("Kybl isn't on screen.")
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
      picker.delegate = self
      picker.allowsMultipleSelection = false
      self.picking = invoke
      vc.present(picker, animated: true)
    }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let invoke = picking else { return }
    picking = nil
    guard let url = urls.first else {
      invoke.resolve([:])
      return
    }
    do {
      invoke.resolve(["type": "iosBookmark", "bookmark": try FolderSource.bookmark(url), "label": url.lastPathComponent])
    } catch {
      invoke.reject("Kybl can't keep access to this folder. Try another one.")
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    picking?.resolve([:])
    picking = nil
  }

  @objc public func schedule(_ invoke: Invoke) {
    BackupTasks.schedule()
    invoke.resolve()
  }

  /// "Back up now" (and "Try again").
  @objc public func runNow(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(RunNowArgs.self)
    BackupRunner.shared.start(only: args.setId, manual: true)
    invoke.resolve()
  }
}

@_cdecl("init_plugin_kyblbackup")
func initPlugin() -> Plugin {
  // before launch ends, as iOS requires (see BackupTasks.register)
  BackupTasks.register()
  return KyblBackupPlugin()
}
