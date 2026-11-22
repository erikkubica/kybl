import Foundation
import ImageIO
import Photos
import UniformTypeIdentifiers

/// A camera roll set's options, from the set the engine keeps.
struct PhotoOptions {
  let includeVideos: Bool
  let livePhotoVideo: Bool
  let convertHeic: Bool
  /// "current" | "original" | "both"
  let edited: String
  let wifiOnly: Bool

  init(_ set: [String: Any]) {
    includeVideos = set["includeVideos"] as? Bool ?? true
    livePhotoVideo = set["livePhotoVideo"] as? Bool ?? true
    convertHeic = (set["heic"] as? String) == "convertJpeg"
    edited = set["edited"] as? String ?? "current"
    wifiOnly = set["wifiOnly"] as? Bool ?? true
  }
}

/// The Photos library side of a backup: what to offer, and exporting one item to a file.
///
/// Items are the resources of an asset, each with its own source id `localIdentifier#tag`:
/// `photo` (the original, or the current edit with "current"), `edit` (the edit next to the
/// original with "both", named like Photos does: IMG_E0001.HEIC), `video` / `vedit` for videos,
/// and `live` for the video half of a Live Photo.
enum PhotoSource {
  static func access() -> PHAuthorizationStatus {
    return PHPhotoLibrary.authorizationStatus(for: .readWrite)
  }

  static func state() -> String {
    switch access() {
    case .authorized: return "granted"
    case .limited: return "limited"
    case .notDetermined: return "notDetermined"
    default: return "denied"
    }
  }

  // ------------------------------------------------------------ which resource is which

  private static func find(_ res: [PHAssetResource], _ types: [PHAssetResourceType]) -> PHAssetResource? {
    for t in types {
      if let r = res.first(where: { $0.type == t }) { return r }
    }
    return nil
  }

  private static func isHeic(_ r: PHAssetResource) -> Bool {
    let uti = r.uniformTypeIdentifier.lowercased()
    return uti == "public.heic" || uti == "public.heif"
  }

  private static func ext(of r: PHAssetResource) -> String {
    if let t = UTType(r.uniformTypeIdentifier), let e = t.preferredFilenameExtension { return e.uppercased() }
    return (r.originalFilename as NSString).pathExtension
  }

  /// The resource behind a tag, and the file name it goes up as.
  static func resource(_ asset: PHAsset, tag: String, _ o: PhotoOptions) -> (PHAssetResource, String, Bool)? {
    let res = PHAssetResource.assetResources(for: asset)
    let isVideo = asset.mediaType == .video
    guard let original = isVideo ? find(res, [.video]) : find(res, [.photo, .alternatePhoto]) else { return nil }
    let stem = (original.originalFilename as NSString).deletingPathExtension
    let edit = isVideo ? find(res, [.fullSizeVideo]) : find(res, [.fullSizePhoto])
    func named(_ r: PHAssetResource, _ s: String) -> (PHAssetResource, String, Bool) {
      let convert = o.convertHeic && isHeic(r)
      return (r, "\(s).\(convert ? "JPG" : ext(of: r))", convert)
    }
    switch tag {
    case "photo", "video":
      if o.edited == "current", let e = edit { return named(e, stem) }
      return named(original, stem)
    case "edit", "vedit":
      guard let e = edit else { return nil }
      // IMG_0001 → IMG_E0001, as Photos names exported edits
      let s = stem.hasPrefix("IMG_") ? "IMG_E" + stem.dropFirst(4) : stem + "_edited"
      return named(e, String(s))
    case "live":
      let video = (o.edited == "original" ? nil : find(res, [.fullSizePairedVideo])) ?? find(res, [.pairedVideo])
      guard let v = video else { return nil }
      return (v, "\(stem).\(ext(of: v))", false)
    default:
      return nil
    }
  }

  /// The items of one asset, as the engine takes them.
  static func items(_ asset: PHAsset, _ o: PhotoOptions) -> [[String: Any]] {
    let isVideo = asset.mediaType == .video
    if isVideo && !o.includeVideos { return [] }
    if !isVideo && asset.mediaType != .image { return [] }
    let res = PHAssetResource.assetResources(for: asset)
    let hasEdit = find(res, isVideo ? [.fullSizeVideo] : [.fullSizePhoto]) != nil
    var tags = [isVideo ? "video" : "photo"]
    if o.edited == "both" && hasEdit { tags.append(isVideo ? "vedit" : "edit") }
    if !isVideo && o.livePhotoVideo && asset.mediaSubtypes.contains(.photoLive) { tags.append("live") }
    let created = ms(asset.creationDate)
    let modified = ms(asset.modificationDate)
    let tz = TimeZone.current.secondsFromGMT(for: asset.creationDate ?? Date()) / 60
    return tags.compactMap { tag in
      guard let (r, name, _) = resource(asset, tag: tag, o) else { return nil }
      // an original never changes; an edit is new whenever the asset changed with one
      let isEdit = (tag == "photo" || tag == "video") ? (o.edited == "current" && hasEdit) : tag != "live"
      let version = isEdit ? "e:\(modified ?? 0)" : "o:\(r.uniformTypeIdentifier)"
      var item: [String: Any] = [
        "sourceId": "\(asset.localIdentifier)#\(tag)",
        "kind": tag == "live" ? "livePhotoVideo" : (isVideo ? "video" : "photo"),
        "name": name,
        // the real size is known once exported; the engine checks it then
        "size": 0,
        "version": version + (o.convertHeic ? ":jpg" : ""),
        "tzOffset": tz,
      ]
      if let c = created { item["created"] = c }
      if let m = modified { item["modified"] = m }
      return item
    }
  }

  // ------------------------------------------------------------ enumeration

  private static func fetchOptions(_ o: PhotoOptions) -> PHFetchOptions {
    let f = PHFetchOptions()
    f.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
    f.includeAssetSourceTypes = [.typeUserLibrary, .typeiTunesSynced, .typeCloudShared]
    f.predicate = o.includeVideos
      ? NSPredicate(format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
      : NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
    return f
  }

  private static let defaults = UserDefaults.standard
  private static let week: TimeInterval = 7 * 24 * 3600

  /// Forgets a removed set's scan state.
  static func forget(_ setId: String) {
    defaults.removeObject(forKey: "backup.token.\(setId)")
    defaults.removeObject(forKey: "backup.full.\(setId)")
    try? FileManager.default.removeItem(at: seenFile(setId))
  }

  /// Offers what is new or changed since the last scan: persistent change tokens on iOS 16+;
  /// on iOS 15 the identifiers and modification dates seen last time. Once a week, or when the
  /// token expired, everything is offered (the engine skips what it has).
  static func scan(setId: String, _ o: PhotoOptions, stop: @escaping () -> Bool) throws {
    let lastFull = defaults.double(forKey: "backup.full.\(setId)")
    let full = Date().timeIntervalSince1970 - lastFull > week
    if #available(iOS 16.0, *) {
      let lib = PHPhotoLibrary.shared()
      // taken before scanning: what changes during the scan is caught next time
      let next = lib.currentChangeToken
      var done = false
      if !full, let data = defaults.data(forKey: "backup.token.\(setId)"),
        let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: PHPersistentChangeToken.self, from: data)
      {
        done = (try? changedSince(token, setId: setId, o, stop: stop)) ?? false
      }
      if !done {
        var none: [String: Int64]? = nil
        try everything(setId: setId, o, stop: stop, seen: &none)
        defaults.set(Date().timeIntervalSince1970, forKey: "backup.full.\(setId)")
      }
      if !stop(), let data = try? NSKeyedArchiver.archivedData(withRootObject: next, requiringSecureCoding: true) {
        defaults.set(data, forKey: "backup.token.\(setId)")
      }
    } else {
      var seen: [String: Int64]? = full ? [:] : ((NSDictionary(contentsOf: seenFile(setId)) as? [String: Int64]) ?? [:])
      try everything(setId: setId, o, stop: stop, seen: &seen)
      if !stop(), let s = seen {
        (s as NSDictionary).write(to: seenFile(setId), atomically: true)
        if full { defaults.set(Date().timeIntervalSince1970, forKey: "backup.full.\(setId)") }
      }
    }
  }

  private static func seenFile(_ setId: String) -> URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("backup", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("seen-\(setId).plist")
  }

  /// Every asset; with `seen` (iOS 15), only those new or modified since they were last seen.
  private static func everything(setId: String, _ o: PhotoOptions, stop: @escaping () -> Bool, seen: inout [String: Int64]?) throws {
    let all = PHAsset.fetchAssets(with: fetchOptions(o))
    var batch: [[String: Any]] = []
    var failure: Error?
    var known = seen
    all.enumerateObjects { asset, _, halt in
      if stop() {
        halt.pointee = true
        return
      }
      autoreleasepool {
        if known != nil {
          let m = ms(asset.modificationDate) ?? 0
          if known?[asset.localIdentifier] == m { return }
          known?[asset.localIdentifier] = m
        }
        batch.append(contentsOf: items(asset, o))
      }
      if batch.count >= 200 {
        do { try Engine.offer(setId, batch) } catch { failure = error; halt.pointee = true }
        batch.removeAll()
      }
    }
    seen = known
    if let f = failure { throw f }
    try Engine.offer(setId, batch)
  }

  /// The assets inserted or changed since `token`. False when the token can't be used.
  @available(iOS 16.0, *)
  private static func changedSince(_ token: PHPersistentChangeToken, setId: String, _ o: PhotoOptions, stop: @escaping () -> Bool) throws -> Bool {
    var ids = Set<String>()
    let changes = try PHPhotoLibrary.shared().fetchPersistentChanges(since: token)
    for change in changes {
      if stop() { return true }
      let details = try change.changeDetails(for: .asset)
      ids.formUnion(details.insertedLocalIdentifiers)
      ids.formUnion(details.updatedLocalIdentifiers)
    }
    let list = Array(ids)
    var i = 0
    while i < list.count && !stop() {
      let chunk = Array(list[i..<min(i + 300, list.count)])
      let assets = PHAsset.fetchAssets(withLocalIdentifiers: chunk, options: nil)
      var batch: [[String: Any]] = []
      assets.enumerateObjects { asset, _, _ in batch.append(contentsOf: items(asset, o)) }
      try Engine.offer(setId, batch)
      i += 300
    }
    return true
  }

  // ------------------------------------------------------------ export

  enum Exported {
    case file(URL)
    /// the asset or resource isn't in the library any more
    case gone
    /// iCloud has the original and fetching it now isn't allowed ("Wi-Fi only" on mobile data)
    case later
    case failed(String)
  }

  /// Writes one item to a temporary file in `dir`: the original from iCloud when only iCloud has
  /// it (allowed on Wi-Fi, or always when "Wi-Fi only" is off), HEIC turned into JPEG on request.
  static func export(sourceId: String, _ o: PhotoOptions, to dir: URL, stop: @escaping () -> Bool) -> Exported {
    let parts = sourceId.components(separatedBy: "#")
    guard parts.count == 2 else { return .gone }
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [parts[0]], options: nil).firstObject,
      let (resource, name, convert) = resource(asset, tag: parts[1], o)
    else { return .gone }
    let url = dir.appendingPathComponent("\(UUID().uuidString)-\(name)")
    let network = !(o.wifiOnly && Net.expensive)
    switch write(resource, to: url, network: network, stop: stop) {
    case .some(let e):
      try? FileManager.default.removeItem(at: url)
      let ns = e as NSError
      if ns.domain == PHPhotosErrorDomain && ns.code == PHPhotosError.Code.networkAccessRequired.rawValue { return .later }
      if ns.domain == NSCocoaErrorDomain && ns.code == NSUserCancelledError { return .later }
      return .failed(ns.localizedDescription)
    case .none:
      break
    }
    if !convert { return .file(url) }
    let jpg = dir.appendingPathComponent("\(UUID().uuidString)-\(name)")
    defer { try? FileManager.default.removeItem(at: url) }
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let dst = CGImageDestinationCreateWithURL(jpg as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
    else { return .failed("Couldn't turn this HEIC photo into a JPEG.") }
    // keeps the photo's metadata (date, camera, location)
    CGImageDestinationAddImageFromSource(dst, src, 0, [kCGImageDestinationLossyCompressionQuality as String: 0.92] as CFDictionary)
    guard CGImageDestinationFinalize(dst) else {
      try? FileManager.default.removeItem(at: jpg)
      return .failed("Couldn't turn this HEIC photo into a JPEG.")
    }
    return .file(jpg)
  }

  /// Streams a resource into `url`; the request is cancelled when `stop` turns true.
  private static func write(_ r: PHAssetResource, to url: URL, network: Bool, stop: @escaping () -> Bool) -> Error? {
    guard FileManager.default.createFile(atPath: url.path, contents: nil), let out = try? FileHandle(forWritingTo: url) else {
      return BackupError("Couldn't make a temporary file.")
    }
    defer { try? out.close() }
    let opts = PHAssetResourceRequestOptions()
    opts.isNetworkAccessAllowed = network
    let done = DispatchSemaphore(value: 0)
    var failure: Error?
    let manager = PHAssetResourceManager.default()
    let id = manager.requestData(
      for: r, options: opts,
      dataReceivedHandler: { data in out.write(data) },
      completionHandler: { e in
        failure = e
        done.signal()
      })
    while done.wait(timeout: .now() + 1) == .timedOut {
      if stop() {
        manager.cancelDataRequest(id)
        done.wait()
        return failure ?? BackupError("Stopped")
      }
    }
    return failure
  }
}
