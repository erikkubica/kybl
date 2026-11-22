import LocalAuthentication
import Network
import Photos
import Tauri
import UIKit
import WebKit

struct OpenArgs: Decodable {
  let path: String
}

struct ShareArgs: Decodable {
  let paths: [String]?
  let text: String?
}

struct PhotoArgs: Decodable {
  let path: String
  let mime: String
}

struct HapticArgs: Decodable {
  let kind: String
}

struct BiometricArgs: Decodable {
  let reason: String
}

struct PrivacyArgs: Decodable {
  let enabled: Bool
}

/// The iOS half of src/platform.rs: open a file with a preview or "Open in…", the share sheet,
/// Save to Photos, haptics, Face ID / Touch ID, and a blur over the app in the app switcher.
class KyblPlatformPlugin: Plugin, UIDocumentInteractionControllerDelegate {
  /// kept while its preview or menu is up (UIKit holds it weakly)
  private var document: UIDocumentInteractionController?
  private var privacy = false
  private var cover: UIView?

  public override func load(webview: WKWebView) {
    // start watching the network now, so the first "on mobile data?" question has an answer
    _ = network
    NotificationCenter.default.addObserver(
      self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  /// The screen on top, to present over (a sheet may already be up).
  private func presenter() -> UIViewController? {
    var vc = manager.viewController
    while let next = vc?.presentedViewController, !next.isBeingDismissed {
      vc = next
    }
    return vc
  }

  /// iPad shows sheets as popovers, which need a place to point at: the middle of the screen,
  /// with no arrow.
  private func anchor(_ popover: UIPopoverPresentationController?, in vc: UIViewController) {
    guard let pop = popover else { return }
    pop.sourceView = vc.view
    pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 0, height: 0)
    pop.permittedArrowDirections = []
  }

  @objc public func openFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    let url = URL(fileURLWithPath: args.path)
    DispatchQueue.main.async {
      guard let vc = self.presenter() else {
        invoke.reject("Kybl isn't on screen.")
        return
      }
      let doc = UIDocumentInteractionController(url: url)
      doc.delegate = self
      self.document = doc
      // a preview (with "Open in…" in its share button) where iOS can show the file...
      if doc.presentPreview(animated: true) {
        invoke.resolve()
        return
      }
      // ...else straight to the apps that can open it
      let rect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 0, height: 0)
      if doc.presentOptionsMenu(from: rect, in: vc.view, animated: true) {
        invoke.resolve()
      } else {
        self.document = nil
        invoke.reject("No app on this device can open \(url.lastPathComponent).")
      }
    }
  }

  func documentInteractionControllerViewControllerForPreview(_ controller: UIDocumentInteractionController)
    -> UIViewController
  {
    return presenter() ?? UIViewController()
  }

  func documentInteractionControllerDidEndPreview(_ controller: UIDocumentInteractionController) {
    if document === controller { document = nil }
  }

  func documentInteractionControllerDidDismissOptionsMenu(_ controller: UIDocumentInteractionController) {
    if document === controller { document = nil }
  }

  @objc public func share(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareArgs.self)
    var items: [Any] = []
    if let text = args.text { items.append(text) }
    for p in args.paths ?? [] { items.append(URL(fileURLWithPath: p)) }
    DispatchQueue.main.async {
      guard let vc = self.presenter() else {
        invoke.reject("Kybl isn't on screen.")
        return
      }
      let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
      self.anchor(sheet.popoverPresentationController, in: vc)
      vc.present(sheet, animated: true) { invoke.resolve() }
    }
  }

  /// Add-only access: Kybl can put photos in the library but never sees what is there.
  @objc public func saveToPhotos(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PhotoArgs.self)
    let url = URL(fileURLWithPath: args.path)
    let video = args.mime.hasPrefix("video/")
    // the app targets iOS 15, the Swift package is built for 13: ask the iOS 14 way when available
    let ask: (@escaping (PHAuthorizationStatus) -> Void) -> Void = { done in
      if #available(iOS 14, *) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly, handler: done)
      } else {
        PHPhotoLibrary.requestAuthorization(done)
      }
    }
    ask { status in
      var allowed = status == .authorized
      if #available(iOS 14, *) { allowed = allowed || status == .limited }
      guard allowed else {
        invoke.reject("Kybl isn't allowed to add to Photos. You can allow it in Settings › Kybl › Photos.")
        return
      }
      PHPhotoLibrary.shared().performChanges({
        PHAssetCreationRequest.forAsset().addResource(with: video ? .video : .photo, fileURL: url, options: nil)
      }) { ok, error in
        if ok {
          invoke.resolve()
        } else {
          let why = error?.localizedDescription ?? "Photos doesn't support this file."
          invoke.reject("Couldn't add \(url.lastPathComponent) to Photos: \(why)")
        }
      }
    }
  }

  @objc public func haptic(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(HapticArgs.self)
    DispatchQueue.main.async {
      switch args.kind {
      case "selection": UISelectionFeedbackGenerator().selectionChanged()
      case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
      case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
      case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
      case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
      default: break
      }
      invoke.resolve()
    }
  }

  /// Face ID / Touch ID, falling back to the passcode. `{ok: false}` when cancelled.
  @objc public func biometric(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BiometricArgs.self)
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      invoke.reject("Set up Face ID, Touch ID or a passcode on this device to lock Kybl.")
      return
    }
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: args.reason) { ok, _ in
      invoke.resolve(["ok": ok])
    }
  }

  @objc public func privacyScreen(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PrivacyArgs.self)
    DispatchQueue.main.async {
      self.privacy = args.enabled
      if !args.enabled { self.uncover() }
      invoke.resolve()
    }
  }

  /// The app switcher shows a snapshot taken as the app stops being active: blur it first.
  @objc private func willResignActive() {
    guard privacy, cover == nil, let window = manager.viewController?.view.window else { return }
    let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    blur.frame = window.bounds
    blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.addSubview(blur)
    cover = blur
  }

  @objc private func didBecomeActive() {
    uncover()
  }

  private func uncover() {
    cover?.removeFromSuperview()
    cover = nil
  }
}

@_cdecl("init_plugin_kyblplatform")
func initPlugin() -> Plugin {
  return KyblPlatformPlugin()
}

// MARK: - Called straight from Rust (src/platform/ios.rs)

/// Keeps transfers going for a while after the app is left. Only touched on the main queue.
private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

@_cdecl("kybl_background_begin")
public func kyblBackgroundBegin() {
  DispatchQueue.main.async {
    guard backgroundTask == .invalid else { return }
    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Kybl transfers") {
      // out of time: iOS suspends the app now, and what didn't finish resumes when it's back
      UIApplication.shared.endBackgroundTask(backgroundTask)
      backgroundTask = .invalid
    }
  }
}

@_cdecl("kybl_background_end")
public func kyblBackgroundEnd() {
  DispatchQueue.main.async {
    guard backgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTask)
    backgroundTask = .invalid
  }
}

private let network: NWPathMonitor = {
  let monitor = NWPathMonitor()
  monitor.start(queue: DispatchQueue(label: "app.kybl.network"))
  return monitor
}()

/// Mobile data, a personal hotspot (expensive) or Low Data Mode (constrained).
@_cdecl("kybl_network_expensive")
public func kyblNetworkExpensive() -> Bool {
  let path = network.currentPath
  return path.isExpensive || path.isConstrained
}

/// Takes a file opened "in Kybl" into `dest`. Files from the Files app are only lent (a
/// security-scoped URL, possibly still in iCloud: the coordinated read downloads it); files iOS
/// copied into Documents/Inbox are moved, so they don't linger in the Files app.
@_cdecl("kybl_copy_opened")
public func kyblCopyOpened(_ url: UnsafePointer<CChar>, _ dest: UnsafePointer<CChar>) -> Bool {
  guard let src = URL(string: String(cString: url)) else { return false }
  let dst = URL(fileURLWithPath: String(cString: dest))
  let fm = FileManager.default
  if src.path.contains("/Documents/Inbox/") {
    return (try? fm.moveItem(at: src, to: dst)) != nil
  }
  let scoped = src.startAccessingSecurityScopedResource()
  defer { if scoped { src.stopAccessingSecurityScopedResource() } }
  var copied = false
  var error: NSError?
  NSFileCoordinator().coordinate(readingItemAt: src, options: .withoutChanges, error: &error) { readable in
    copied = (try? fm.copyItem(at: readable, to: dst)) != nil
  }
  return copied
}
