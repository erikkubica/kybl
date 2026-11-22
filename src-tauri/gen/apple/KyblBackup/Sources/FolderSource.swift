import Foundation

/// A Files-app folder picked for backup, kept as a security-scoped bookmark. A run opens it
/// (`startAccessingSecurityScopedResource`), offers every file inside it by its path there, and
/// uploads the files in place: no temporary copies.
final class FolderSource {
  let root: URL
  private let accessing: Bool

  init(bookmark b64: String) throws {
    guard let data = Data(base64Encoded: b64) else { throw BackupError("This folder can't be opened any more. Remove this backup and pick the folder again.") }
    var stale = false
    root = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    accessing = root.startAccessingSecurityScopedResource()
    if !accessing && !FileManager.default.isReadableFile(atPath: root.path) {
      throw BackupError("Kybl can't open this folder any more. Remove this backup and pick the folder again.")
    }
  }

  deinit {
    if accessing { root.stopAccessingSecurityScopedResource() }
  }

  /// A bookmark for a folder the document picker handed over.
  static func bookmark(_ url: URL) throws -> String {
    let ok = url.startAccessingSecurityScopedResource()
    defer { if ok { url.stopAccessingSecurityScopedResource() } }
    return try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil).base64EncodedString()
  }

  func scan(setId: String, stop: () -> Bool) throws {
    let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey, .creationDateKey, .ubiquitousItemDownloadingStatusKey]
    guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return }
    let base = root.standardizedFileURL.path
    var batch: [[String: Any]] = []
    for case let url as URL in walk {
      if stop() { return }
      guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { continue }
      var rel = url.standardizedFileURL.path
      if rel.hasPrefix(base) { rel = String(rel.dropFirst(base.count)) }
      rel = rel.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      if rel.isEmpty { continue }
      let modified = ms(v.contentModificationDate) ?? 0
      let created = ms(v.creationDate) ?? modified
      batch.append([
        "sourceId": rel,
        "kind": "file",
        "name": url.lastPathComponent,
        "size": v.fileSize ?? 0,
        "created": created,
        "modified": modified,
        "relPath": rel,
        "tzOffset": TimeZone.current.secondsFromGMT(for: v.creationDate ?? Date()) / 60,
      ])
      if batch.count >= 300 {
        try Engine.offer(setId, batch)
        batch.removeAll()
      }
    }
    try Engine.offer(setId, batch)
  }

  /// The file behind a source id, when it is here (an iCloud Drive file not on the phone yet is
  /// asked for, and backed up on a later run).
  func file(_ sourceId: String) -> URL? {
    let url = root.appendingPathComponent(sourceId)
    if FileManager.default.isReadableFile(atPath: url.path) {
      let status = (try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?.ubiquitousItemDownloadingStatus
      if status == nil || status == .current || status == .downloaded { return url }
    }
    try? FileManager.default.startDownloadingUbiquitousItem(at: url)
    return nil
  }

  func exists(_ sourceId: String) -> Bool {
    let url = root.appendingPathComponent(sourceId)
    if FileManager.default.fileExists(atPath: url.path) { return true }
    // not downloaded: iCloud keeps a ".name.icloud" placeholder next to it
    let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
    return FileManager.default.fileExists(atPath: placeholder.path)
  }
}
