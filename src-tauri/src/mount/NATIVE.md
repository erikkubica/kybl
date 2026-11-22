# Native drives: what comes after the WebDAV stopgap

Stage E4 (this folder) mounts a local WebDAV server. It works today on macOS and Linux with no
installs, no admin rights and no signing, but it is a stopgap: no Finder/Explorer badges, no
"Keep downloaded" / "Free up space", Finder's WebDAV client is chatty, and the drive needs Kybl
running. The native stages fix that; both need things only the owner can decide or provide.
Nothing here is implemented yet: neither can be compiled or tested from this machine (no Windows
toolchain for the C dependencies; no Apple Developer account).

What carries over from E4 unchanged: the `Storage`-backed read path (ranged reads + the block
cache in `cache.rs`), the write-back queue with conflict copies (`writeback.rs`), the clutter
rules (`junk.rs`) and the drive list / status UI (`MountInfo`, `mount-status`, Settings › Drives).
What changes is the front end the OS talks to: WebDAV → Cloud Files callbacks (Windows) or a File
Provider extension (macOS).

### The E4 drive's secret, and what it doesn't cover

The WebDAV server listens on `127.0.0.1` only and every request must carry a 128-bit random token
in its path (`server.rs`). `mount_webdav` can't take a password without a dialog, so the token is
part of the URL, and the system's mount list (`mount`, `/sbin/mount`) shows that URL to every
process and every account on the computer. Since round 3 the token is new for every mount (each
mount start, eject and remount, and app start), so a token read from the mount list stops
working as soon as that mount ends. The residual risk: while a drive is mounted, any program
running on this computer (any account) can read the token and use the drive with the same access
Kybl has. That is the same exposure as the mounted folder itself for the signed-in user, but wider
for other accounts on a shared Mac. The native stages remove it (no network server at all).

---

## E2: Windows Cloud Files API (cfapi)

**What users get:** a "Kybl" entry in Explorer's navigation pane like OneDrive: placeholders for
every file (name, size, date, no bytes), files download when opened, cloud/check/pin status icons
in Explorer, "Always keep on this device" and "Free up space" in the context menu, progress in
Explorer while a file hydrates. Windows 10 1709+ on NTFS. No driver install (`cldflt.sys` ships
with Windows), no admin rights.

**Why not WebDAV on Windows (why E4 skips it):** the WebClient service is often disabled (and
deprecated), files are capped at 50 MB unless an admin edits the registry, plain-HTTP Basic auth
is refused by default (`BasicAuthLevel`), and the first connect is slow. E4 keeps an experimental
`net use` path behind `KYBL_EXPERIMENTAL_WEBDAV_DRIVE=1` for testing only.

**Shape (`mount/windows.rs`):**

- Crate: `cloud-filter` 0.0.7 (young; Nov 2026). Fallback: the raw `windows` crate with
  `Win32_Storage_CloudFilters` + `Win32_Storage_FileSystem` (that's what `cloud-filter` wraps).
- **Register** the sync root once per drive: `StorageProviderSyncRootManager::Register` (WinRT,
  `windows::Storage::Provider`) with id `Kybl!<user SID>!<drive id>`, display name, icon (the app
  exe's icon resource), `HydrationPolicy::Full`, `PopulationPolicy::Full` or `AlwaysFull`,
  `InSyncPolicy` for timestamps/attributes. Folder: `%USERPROFILE%\Kybl\<drive name>`.
  Unregister on remove. Unpackaged apps can register (Nextcloud's MSI does; verify with our
  NSIS/MSI build: some APIs want package identity, in which case a sparse package is the fix).
- **Connect** at start: `CfConnectSyncRoot` with callbacks:
  - `FETCH_PLACEHOLDERS` (folder opened): `Storage::list`, then `CfCreatePlaceholders` with size,
    times, and the key + etag as the placeholder's file identity blob.
  - `FETCH_DATA` (file opened): `Storage::read(range)` → `CfExecute(TRANSFER_DATA)` in 4 KiB-aligned
    chunks, reporting progress (`CfReportProviderProgress`) so Explorer shows a bar. Reuse
    `cache.rs` blocks.
  - `CANCEL_FETCH_DATA`: drop the read.
  - `NOTIFY_DELETE` / `NOTIFY_RENAME`: apply on the server (`Storage::delete` / `rename`), ack.
- **Local edits:** `ReadDirectoryChangesW` on the sync root (the `notify` crate already wraps it),
  then the write-back queue uploads, then `CfSetInSyncState(IN_SYNC)` + `CfUpdatePlaceholder`
  with the new etag. Conflicts use the same `writeback.rs` rule.
- **Pinning:** `FILE_ATTRIBUTE_PINNED` / `UNPINNED` via `CfGetPlaceholderInfo`; pinned subtrees are
  hydrated in the background, "Free up space" → `CfDehydratePlaceholder`. This is where the sync
  agent's `sync.db` (`pinned` column, phase-2 §5.2) becomes the shared state.
- Kybl must run for hydration (it already starts at login in the tray). Opening a placeholder
  while Kybl isn't running fails with "The cloud file provider is not running": acceptable, same
  as OneDrive.

**Needs from the owner:** a Windows machine/VM to build and test (the C dependencies don't
cross-compile from macOS here), a decision on code signing (optional; it helps SmartScreen and
some cfapi registrations look friendlier), and accepting a `windows` crate dependency (~large
compile, small binary). Effort: about 2-3 weeks including tests on Windows 10 and 11.

---

## E5: macOS File Provider (`NSFileProviderReplicatedExtension`)

**What users get:** Kybl under Locations in Finder like iCloud Drive / Dropbox: cloud badges,
"Download Now" / "Remove Download", "Keep Downloaded" (pinning), Spotlight search of names,
progress in Finder, works when Kybl's window is closed and even when the app isn't running (the
system starts the extension). No WebDAV, no mount table entry, no `._` clutter (the system keeps
extended attributes itself).

**What's needed from the owner (not optional; File Provider extensions won't load without it):**

1. **Apple Developer Program** membership (99 USD / year), team ID.
2. **Developer ID Application** certificate for signing outside the App Store, and
   **notarization** (`notarytool`) of every release. Moving from today's self-signed certificate
   costs users one more keychain prompt once (the README already warns about this).
3. An **App ID** for the app and one for the extension (`app.kybl.desktop.FileProvider`), with:
   - an **App Group** (`group.app.kybl.desktop`) shared by app and extension (state, cache);
   - the **File Provider** capability on the extension;
   - a shared **keychain access group** (`$(TeamID).app.kybl.shared`) so the extension can read
     connection secrets (today they're in the app's own keychain item / vault).
4. **Provisioning profiles** (Developer ID) for both, embedded in the bundles.

**Build changes:**

- Tauri's bundler doesn't build `.appex` targets. Add an Xcode project for the extension
  (Swift, ~1-2k lines), built with `xcodebuild` in the release workflow, copied to
  `Kybl.app/Contents/PlugIns/`, then the whole bundle re-signed inside-out (extension first, with
  its entitlements; then the app) before notarizing.
- The extension links the Rust core as a static library with a C ABI (cbindgen). This is where the
  storage core moves into its own crate (`kybl-core`: `storage/`, `mount/cache.rs`,
  `mount/writeback.rs`), so the extension doesn't pull in Tauri.
- The app registers the domain (`NSFileProviderManager.add(domain)`) per drive; removing a drive
  removes the domain.

**Shape of the extension:**

- `item(for:)` / enumerators backed by `Storage::list`; sync anchors from Drive/OneDrive/Dropbox
  `changes(cursor)`, or a listing diff for S3 and servers.
- `fetchContents(for:)`: `Storage::read` into the URL the system hands over (with progress).
- `createItem` / `modifyItem` / `deleteItem`: uploads via the write-back logic (conflict copies),
  renames, deletes; return the new item version (etag).
- State in the App Group container (shares `sync.db` with the sync engine for pin state).
- Prefer this over XPC to the main app: it keeps working when Kybl isn't running.

**Effort:** about 3-4 weeks once the account, certificates and profiles exist, most of it in the
signing/notarization pipeline and the core-crate split. Until then E4 stays the macOS answer.

---

## Linux (E3, for completeness)

E4 already works through GVFS (`gio mount dav://…`), which every GNOME/Cinnamon/XFCE file manager
shows. A FUSE mount (`fuser` 0.19, `mount/fuse.rs`) would serve terminals and apps that don't use
GVFS, using the same cache and write-back; it needs `fusermount3` (standard) and no signing.
