import AuthenticationServices
import Tauri
import UIKit
import WebKit

struct SignInArgs: Decodable {
  let url: String
  /// The scheme that ends the sign-in: "kybl" (Kybl Storage, OneDrive, and the loopback sign-ins,
  /// which come back through kybl://oauth/done) or Google's reversed client id.
  let callbackScheme: String?
}

/// Browser sign-in on iOS: "Connect Kybl Storage" (src/kybl_connect.rs) and the cloud drives
/// (src/oauth/mod.rs). `signIn` opens the page in an ASWebAuthenticationSession sheet and resolves
/// with the redirect to `callbackScheme` (`kybl://connect?code=…&state=…` by default). Closing the
/// sheet without approving resolves with `{cancelled: true}`.
class KyblConnectPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?
  private var pending: Invoke?

  @objc public func signIn(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SignInArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("The sign-in address isn't valid.")
      return
    }
    DispatchQueue.main.async {
      self.finish(["cancelled": true])
      self.session?.cancel()
      self.pending = invoke
      let scheme = args.callbackScheme.flatMap { $0.isEmpty ? nil : $0 } ?? "kybl"
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] back, error in
        DispatchQueue.main.async {
          guard let self = self, self.pending === invoke else { return }
          self.session = nil
          if let back = back {
            self.finish(["url": back.absoluteString])
          } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
            self.finish(["cancelled": true])
          } else if let error = error {
            self.pending = nil
            invoke.reject("Couldn't sign in: \(error.localizedDescription)")
          } else {
            self.finish(["cancelled": true])
          }
        }
      }
      session.presentationContextProvider = self
      // share Safari's cookies: someone already signed in to the account site just taps Connect
      session.prefersEphemeralWebBrowserSession = false
      self.session = session
      if !session.start() {
        self.session = nil
        self.pending = nil
        invoke.reject("Couldn't open the sign-in page. Use a code instead.")
      }
    }
  }

  @objc public func cancel(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.finish(["cancelled": true])
      self.session?.cancel()
      self.session = nil
      invoke.resolve()
    }
  }

  /// What the user calls this device. Since iOS 16 apps without a special entitlement get the
  /// model ("iPhone"), which still beats nothing.
  @objc public func deviceName(_ invoke: Invoke) {
    DispatchQueue.main.async {
      invoke.resolve(["name": UIDevice.current.name])
    }
  }

  private func finish(_ data: JsonObject) {
    guard let inv = pending else { return }
    pending = nil
    inv.resolve(data)
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    if let w = manager.viewController?.view.window { return w }
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? ASPresentationAnchor()
  }
}

@_cdecl("init_plugin_kyblconnect")
func initPlugin() -> Plugin {
  return KyblConnectPlugin()
}
