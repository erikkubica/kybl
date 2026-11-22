import BackgroundTasks
import Foundation
import UIKit

/// Runs backups, one at a time, on a background queue: while Kybl is open (it opening or coming
/// back counts as a reason), on "Back up now", and in the background tasks below. The Rust engine
/// decides what goes up and where; this side enumerates, exports and hands over files.
final class BackupRunner {
  static let shared = BackupRunner()

  private let queue = DispatchQueue(label: "app.kybl.backup.run", qos: .utility)
  private let lock = NSLock()
  private var running = false
  private var stopping = false
  private var waiters: [(Bool) -> Void] = []

  private var temp: URL {
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("backup", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// Starts a run (of one set, or all). `manual` ("Back up now") goes ahead on battery;
  /// `deadline` ends it early (a 30-second refresh task). `done` hears whether it finished
  /// without stopping for the network; a run already going on is joined instead.
  func start(only: String? = nil, manual: Bool, deadline: Date? = nil, done: ((Bool) -> Void)? = nil) {
    lock.lock()
    if let d = done { waiters.append(d) }
    if running {
      lock.unlock()
      return
    }
    running = true
    stopping = false
    lock.unlock()

    var task = UIBackgroundTaskIdentifier.invalid
    // a little time to finish the file in flight when Kybl is left
    task = UIApplication.shared.beginBackgroundTask(withName: "Kybl backup") { [weak self] in
      self?.stop()
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
    queue.async {
      let ok = self.runAll(only: only, manual: manual, deadline: deadline)
      self.lock.lock()
      self.running = false
      let w = self.waiters
      self.waiters = []
      self.lock.unlock()
      w.forEach { $0(ok) }
      DispatchQueue.main.async {
        if task != .invalid {
          UIApplication.shared.endBackgroundTask(task)
          task = .invalid
        }
      }
    }
  }

  /// Stops the run: the upload in flight ends, the loop stops at the next item.
  func stop() {
    lock.lock()
    stopping = true
    lock.unlock()
    Engine.cancel()
  }

  private var stopped: Bool {
    lock.lock()
    defer { lock.unlock() }
    return stopping
  }

  private func runAll(only: String?, manual: Bool, deadline: Date?) -> Bool {
    // leftovers of a run that was killed mid-file
    if let old = try? FileManager.default.contentsOfDirectory(at: temp, includingPropertiesForKeys: nil) {
      old.forEach { try? FileManager.default.removeItem(at: $0) }
    }
    guard let sets = try? Engine.sets() else { return false }
    var ok = true
    for set in sets {
      if stopped || deadline.map({ Date() > $0 }) == true { break }
      guard let id = set["id"] as? String, set["enabled"] as? Bool ?? true else { continue }
      if let o = only, o != id { continue }
      if !manual && (set["chargingOnly"] as? Bool ?? false) && !Power.charging { continue }
      if !runSet(set, id: id, deadline: deadline) { ok = false }
    }
    return ok
  }

  /// One set's run. False when it stopped for the network (the background task asks again).
  private func runSet(_ set: [String: Any], id: String, deadline: Date?) -> Bool {
    guard let start = try? Engine.call("runStart", ["setId": id]) as? [String: Any], start["run"] as? Bool == true else { return true }
    var error: String?
    var ok = true
    defer {
      var args: [String: Any] = ["setId": id]
      if let e = error { args["error"] = e }
      _ = try? Engine.call("runEnd", args)
    }
    let source = set["source"] as? [String: Any] ?? [:]
    let wifiOnly = set["wifiOnly"] as? Bool ?? true
    let isStopped = { [weak self] () -> Bool in
      guard let self = self else { return true }
      return self.stopped || deadline.map({ Date() > $0 }) == true
    }
    do {
      var folder: FolderSource?
      let photos = PhotoOptions(set)
      switch source["type"] as? String {
      case "cameraRoll":
        let access = PhotoSource.access()
        guard access == .authorized || access == .limited else {
          error = "Kybl isn't allowed to see your photos. Open the backup screen to allow it."
          return true
        }
        try PhotoSource.scan(setId: id, photos, stop: isStopped)
      case "iosBookmark":
        let f = try FolderSource(bookmark: source["bookmark"] as? String ?? "")
        try f.scan(setId: id, stop: isStopped)
        folder = f
      default:
        return true
      }
      if !Net.online {
        _ = try? Engine.call("wait", ["setId": id, "reason": "network"])
        return false
      }
      if wifiOnly && Net.expensive {
        // not even originals from iCloud: they would come over mobile data
        _ = try? Engine.call("wait", ["setId": id, "reason": "wifi"])
        return true
      }
      let pending = (try Engine.call("pending", ["setId": id]) as? [[String: Any]]) ?? []
      for p in pending {
        if isStopped() { break }
        guard let sourceId = p["sourceId"] as? String else { continue }
        let remote = p["remotePath"] as? String ?? ""
        var file: URL?
        var temporary = false
        if let f = folder {
          file = f.file(sourceId)
          if file == nil {
            if !f.exists(sourceId) { _ = try? Engine.call("gone", ["setId": id, "sourceId": sourceId]) }
            continue
          }
        } else {
          switch PhotoSource.export(sourceId: sourceId, photos, to: temp, stop: isStopped) {
          case .file(let u):
            file = u
            temporary = true
          case .gone:
            _ = try? Engine.call("gone", ["setId": id, "sourceId": sourceId])
            continue
          case .later:
            continue
          case .failed(let why):
            _ = try? Engine.call("fail", ["setId": id, "sourceId": sourceId, "error": why])
            continue
          }
        }
        guard let url = file else { continue }
        let mtime = ms((try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate) ?? 0
        let r = Engine.upload(id, sourceId, remote, file: url, mtimeMs: temporary ? 0 : mtime)
        if temporary { try? FileManager.default.removeItem(at: url) }
        switch r["status"] as? String {
        case "cancelled", "waitingWifi", "needsAuth":
          return true
        case "retryLater":
          ok = false
          return false
        default:
          break
        }
      }
    } catch let e {
      error = "\(e)"
    }
    return ok
  }
}

/// The background tasks: `app.kybl.mobile.backup` (a processing task: overnight while charging,
/// with time for a long backlog) and `app.kybl.mobile.refresh` (an app refresh task: about 30
/// seconds now and then, for what is new). iOS decides when, or whether, they run.
enum BackupTasks {
  static let processing = "app.kybl.mobile.backup"
  static let refresh = "app.kybl.mobile.refresh"
  private static var registered = false

  /// Must happen before the app finishes launching. Called from the plugin's init function,
  /// which Tauri runs while building the app (`Builder::build` initialises the plugins), before
  /// `UIApplicationMain` starts: well before launch ends.
  static func register() {
    if registered { return }
    registered = true
    BGTaskScheduler.shared.register(forTaskWithIdentifier: processing, using: nil) { task in
      handle(task, deadline: nil)
    }
    BGTaskScheduler.shared.register(forTaskWithIdentifier: refresh, using: nil) { task in
      handle(task, deadline: Date().addingTimeInterval(25))
    }
  }

  private static func handle(_ task: BGTask, deadline: Date?) {
    schedule()
    task.expirationHandler = { BackupRunner.shared.stop() }
    BackupRunner.shared.start(manual: false, deadline: deadline) { ok in
      task.setTaskCompleted(success: ok)
    }
  }

  /// Asks iOS for the next background runs (only while a set is on).
  static func schedule() {
    DispatchQueue.global(qos: .utility).async {
      let any = ((try? Engine.sets()) ?? []).contains { $0["enabled"] as? Bool ?? true }
      if !any {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: processing)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: refresh)
        return
      }
      let p = BGProcessingTaskRequest(identifier: processing)
      p.requiresNetworkConnectivity = true
      // "overnight while charging", as the backup screen says
      p.requiresExternalPower = true
      p.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
      try? BGTaskScheduler.shared.submit(p)
      let r = BGAppRefreshTaskRequest(identifier: refresh)
      r.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
      try? BGTaskScheduler.shared.submit(r)
    }
  }
}
