import Foundation
import KyblBackupFFI
import Network
import UIKit

struct BackupError: Error, CustomStringConvertible {
  let description: String
  init(_ s: String) { description = s }
}

/// The Rust engine (src/backup/headless.rs). Every call blocks: never on the main thread.
enum Engine {
  private static func json(_ o: Any) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return "{}" }
    return s
  }

  private static func take(_ p: UnsafeMutablePointer<CChar>?) -> Any? {
    guard let p = p else { return nil }
    defer { kybl_string_free(p) }
    return try? JSONSerialization.jsonObject(with: Data(String(cString: p).utf8), options: [.fragmentsAllowed])
  }

  /// A call's `ok` value; an `error` answer throws.
  @discardableResult
  static func call(_ method: String, _ args: [String: Any] = [:]) throws -> Any? {
    let answer = take(kybl_backup_call(method, json(args))) as? [String: Any]
    if let e = answer?["error"] as? String { throw BackupError(e) }
    guard let a = answer else { throw BackupError("The backup engine didn't answer.") }
    return a["ok"] is NSNull ? nil : a["ok"]
  }

  static func sets() throws -> [[String: Any]] {
    return (try call("sets") as? [[String: Any]]) ?? []
  }

  static func offer(_ setId: String, _ items: [[String: Any]]) throws {
    if items.isEmpty { return }
    if let e = (take(kybl_backup_offer(setId, json(items))) as? [String: Any])?["error"] as? String { throw BackupError(e) }
  }

  /// `{status, remotePath?, error?}`
  static func upload(_ setId: String, _ sourceId: String, _ remotePath: String, file: URL, mtimeMs: Int64) -> [String: Any] {
    return (take(kybl_backup_upload(setId, sourceId, remotePath, file.path, mtimeMs)) as? [String: Any]) ?? ["status": "failed"]
  }

  static func cancel() {
    kybl_backup_cancel()
  }
}

/// Wi-Fi or not, for "Wi-Fi only" (mobile data, a hotspot and Low Data Mode count as not).
enum Net {
  private static let monitor: NWPathMonitor = {
    let m = NWPathMonitor()
    m.start(queue: DispatchQueue(label: "app.kybl.backup.net"))
    return m
  }()

  static func start() { _ = monitor }
  static var expensive: Bool { monitor.currentPath.isExpensive || monitor.currentPath.isConstrained }
  static var online: Bool { monitor.currentPath.status == .satisfied }
}

enum Power {
  /// Read on the main thread (UIDevice): kept here for the background queue.
  private static var plugged = false
  private static var watching = false

  /// Call on the main thread.
  static func watch() {
    guard !watching else { return }
    watching = true
    UIDevice.current.isBatteryMonitoringEnabled = true
    update()
    NotificationCenter.default.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main) { _ in update() }
  }

  private static func update() {
    let s = UIDevice.current.batteryState
    plugged = s == .charging || s == .full
  }

  static var charging: Bool { plugged }
}

func ms(_ d: Date?) -> Int64? {
  guard let d = d else { return nil }
  return Int64(d.timeIntervalSince1970 * 1000)
}
