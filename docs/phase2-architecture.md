# Kybl phase 2: architecture and implementation plan

I only read the code. Nothing was changed. File references are to the worktree as it is now: HEAD `785aa5a`, with the phase-1 API contract already in `src/api.ts`.

---

## 0. What the current code means for phase 2

These facts set the constraints for the rest of the plan:

1. **Every command is S3-only and goes through `state::client_for`** (`src-tauri/src/state.rs:391`). The commands in `commands.rs`, `transfers.rs`, `sync.rs` and `thumbs.rs` all take an `aws_sdk_s3::Client`.
   - The frontend model (profile / bucket / prefix / key, with folders ending in `/`) is a good general model. **Keep it.** "Bucket" becomes "root" and "key" becomes "path".
2. **There is no streaming URI scheme today.** Video and audio play from presigned URLs (`PreviewPane.tsx:184`, `mobile/Viewer.tsx:46`). The only custom scheme is `thumb://` (`lib.rs:39`).
   - Providers that can't presign (FTP, SFTP, WebDAV, and Drive for practical purposes) need a new `media://` scheme that understands Range requests.
   - Tauri custom-protocol responses are whole `Vec<u8>` buffers, not streams. So the scheme must answer every request with a bounded `206` chunk.
3. **All secrets sit in one keychain item**: a JSON map in `vault::entry()` (`state.rs:216`).
   - On Windows, Credential Manager caps a blob at **2560 bytes**. Microsoft refresh tokens are often over 1 KB. One or two OneDrive accounts plus a dozen S3 keys would break the vault.
   - **The vault has to change before OAuth ships.**
4. **`kybl_connect.rs` already has everything OAuth needs**: PKCE (`pkce_challenge`, `random_token`), a loopback listener (`wait_for_code`), and mobile redirects through `kybl://connect` (`KyblConnectPlugin.swift` / `.kt`). Google, Microsoft and Dropbox sign-in can reuse it.
5. **Folder sync is desktop-only** (`#[cfg(desktop)] mod sync`), one-way, and keeps a per-mapping JSON database that is rewritten every 100 files (`sync.rs:523`).
   - The planning logic in `run_upload` / `run_download` is good, but it is tangled with I/O and S3.
6. **Signing and distribution:**
   - macOS is signed with a self-signed certificate and **not notarized** (README "Install", `release.yml:5-9`).
   - iOS ships as an **unsigned `.ipa`** that users sideload with AltStore/SideStore under a free Apple ID (`release.yml:133-177`).
   - Android is signed with a release keystore and uses `targetSdk = 36`, a `dataSync` foreground service, and min SDK 24.
7. **`tauri.conf.json` has `"csp": null`, and every page has full IPC access.** Untrusted HTML from DOCX or Markdown must never be injected into the main document (see feature D).
8. **There are no Hetzner workarounds in Rust beyond two things**: `RequestChecksumCalculation::WhenRequired` (`state.rs:382`) and the one-by-one delete fallback (`commands.rs:653`). There is also an AccessDenied retry in `api.ts:9`. "Keep S3 untouched" means not touching `build_client`, `upload_file`, `download_file`, `copy_one`, `copy_many`, `list_all` or `prefix_size`.

What phase 1 is adding, and what phase 2 reuses instead of rebuilding:

- `existing_keys` (name clashes)
- `update_object_props` and tags (stay S3-only, hidden by capabilities)
- `move_many` with `destBucket` (the migration engine uses it for same-connection copies)
- `share_files`, `share_text` and open-in (reused by the editor's "Open in…")
- `TransferPrefs` (concurrency, `partConcurrency`, `bandwidthLimitKbps`, `wifiOnly`), which feed into migration and backup
- menu-bar events (a "Dual pane" item gets added later)

---

## 1. Foundation: storage abstraction (feature A, core)

### 1.1 Approach

- **Recommended:** a trait object, `Arc<dyn Storage>` via `async-trait`. `S3Backend` is a thin adapter over the existing S3 functions. Other backends implement the same trait. The existing Tauri commands keep their names and argument shapes; each gets a two-line dispatch at the top that sends non-S3 connections to generic code, so **the S3 bodies stay byte-for-byte the same**.
- Rejected: **enum dispatch.** Every new provider would touch the central enum, and engines can't be tested with mocks.
- Rejected: **rewriting all commands onto the trait now.** It collides with five phase-1 branches editing `commands.rs` and puts S3 at risk.
- Rejected: **an rclone sidecar (librclone).** It adds a Go runtime (~40-60 MB), cgo cross-compiles badly for iOS and Android, and we lose control over errors and progress.

### 1.2 Rust module layout (new code)

```
src-tauri/src/
  core/                    # no `tauri::` imports: usable from the headless Android/iOS entry points and, later, the macOS extension
    mod.rs                 # Core singleton: OnceLock<Core>, tokio runtime handle, Env { config_dir, data_dir, cache_dir }
    profiles.rs            # load_profiles_from(&Path), save_profiles_to(&Path) (state.rs keeps its AppHandle wrappers)
    vault.rs               # vault v2 (moved out of state.rs, see 1.7)
    db.rs                  # rusqlite open-with-migrations helper (PRAGMA user_version, WAL)
  storage/
    mod.rs                 # trait Storage, Entry, Page, RootInfo, Capabilities, StorageError, WriteSource, WriteOpts
    registry.rs            # open(app|core, profile_id) -> Arc<dyn Storage>; cache; reserved id "local"
    generic_cmds.rs        # generic bodies of list_objects/search/head/text_preview/bytes/create_folder/delete/move_many/existing_keys/folder_size/list_all_under
    s3.rs                  # S3Backend: wraps Client + Quirks; delegates to commands::{list_all, copy_one, ...} and transfers::{upload_file, download_file}
    s3_stream.rs           # streaming multipart upload from a non-file source (owned by the migration package)
    local.rs               # LocalBackend (tokio::fs, root-confined)
    dal.rs                 # OpenDAL adapter: webdav, ftp, azblob, gcs, dropbox, onedrive
    sftp.rs                # russh + russh-sftp
    gdrive/{mod,api,paths,upload}.rs
    extras/{dropbox,onedrive}.rs   # share links, thumbnails, hashes, change cursors that OpenDAL doesn't cover
    media.rs               # `media://` Range scheme
    doc.rs                 # doc_open / doc_save (editor, feature D)
  oauth/
    mod.rs                 # providers table, authorize() flow (loopback desktop / Custom Tab / ASWebAuthenticationSession)
    token.rs               # TokenSource: single-flight refresh, rotation saved to vault, needs-reauth state
  jobs/  (B)   backup/ (C)   sync/ (split, E)   mount/ (E)
```

### 1.3 Key types and the trait

```rust
// storage/mod.rs
pub type BoxStream<T> = Pin<Box<dyn futures_core::Stream<Item = T> + Send>>;

#[derive(Serialize, Clone, Debug)] #[serde(rename_all = "camelCase")]
pub struct Entry {                       // serialized as a superset of today's ObjInfo
    pub key: String,                     // path within the root; folders end with '/'
    pub size: i64, pub modified: Option<i64>, pub etag: Option<String>,
    pub storage_class: Option<String>,
    pub id: Option<String>,              // ID-based providers (Drive, Box); React keys use it when present
    pub mime: Option<String>,
    pub hashes: Hashes,                  // md5 / sha1 / sha256 / quickxor / dropbox, whichever the provider gives
    pub native: Option<NativeDoc>,       // Google Docs/Sheets/Slides: { exports: Vec<ExportFormat> }
}
pub struct Page { pub folders: Vec<String>, pub objects: Vec<Entry>, pub next_token: Option<String> }
#[derive(Serialize)] pub struct RootInfo { pub id: String, pub name: String, pub kind: RootKind, pub created: Option<i64>, pub read_only: bool }

pub enum WriteSource {
    Path(PathBuf),                                   // re-readable; existing upload path
    Bytes(bytes::Bytes),                             // editor saves
    Stream { len: Option<u64>, body: BoxStream<io::Result<Bytes>>,
             reopen: Option<Box<dyn Fn(u64) -> BoxFuture<'static, io::Result<BoxStream<io::Result<Bytes>>>> + Send + Sync>> },
}
pub enum Precondition { None, IfMatch(String), IfNoneMatch, IfUnchanged { etag: Option<String>, size: i64, modified: Option<i64> } }
pub struct WriteOpts<'a> {
    pub content_type: Option<String>, pub preserve_meta: bool, pub precondition: Precondition,
    pub part_size: Option<u64>, pub parts_in_flight: usize,
    pub resume: Option<ResumeState>, pub on_part: Option<&'a (dyn Fn(PartRecord) + Send + Sync)>,
}
pub enum WriteOutcome { Done(Entry), Cancelled, Conflict(Option<Entry>) }

#[async_trait::async_trait]
pub trait Storage: Send + Sync + 'static {
    fn kind(&self) -> ConnKind;
    fn caps(&self) -> &Capabilities;
    async fn roots(&self) -> SResult<Vec<RootInfo>>;
    async fn create_root(&self, _name: &str) -> SResult<()> { unsupported() }
    async fn list(&self, root: &str, dir: &str, token: Option<String>) -> SResult<Page>;
    fn walk(&self, root: String, dir: String) -> BoxStream<SResult<Vec<Entry>>>;   // recursive, page by page
    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>>;
    async fn read(&self, root: &str, path: &str, range: Option<std::ops::Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream>;
    async fn write(&self, root: &str, path: &str, src: WriteSource, opts: WriteOpts<'_>,
                   progress: crate::transfers::Progress<'_>, cancel: &AtomicBool) -> SResult<WriteOutcome>;
    async fn mkdir(&self, root: &str, dir: &str) -> SResult<()>;
    async fn delete(&self, root: &str, files: &[String], dirs: &[String], cancel: &AtomicBool,
                    on_progress: &(dyn Fn(u64, u64) + Send + Sync)) -> SResult<(u64, u64)>;
    async fn copy(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> { unsupported() }   // server-side only
    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()>;                  // native, or copy+delete per caps
    async fn share_link(&self, _loc: &Loc, _ttl: Option<Duration>) -> SResult<String> { unsupported() }
    async fn thumbnail(&self, _loc: &Loc, _e: &Entry) -> SResult<Option<Bytes>> { Ok(None) }    // remote thumbnails
    async fn changes(&self, _root: &str, _cursor: Option<String>) -> SResult<ChangeBatch> { unsupported() }
    async fn quota(&self) -> SResult<Option<Quota>> { Ok(None) }
    fn as_s3(&self) -> Option<&s3::S3Backend> { None }
}

pub struct StorageError { pub kind: ErrKind, pub message: String }   // kind: NotFound | Conflict | Unsupported | NeedsAuth | RateLimited | Network | Other
impl From<StorageError> for String { /* same "plain sentence\n\ntechnical" format as state::sdk_err */ }
```

Notes on the S3 adapter:

- `S3Backend` holds the `Client` plus `Quirks { conditional_put, etag_is_md5, bulk_delete }`, looked up from `profile.provider`:
  - `aws`, `r2`, `minio`: `conditional_put = true`
  - `hetzner`, `custom`: `false`
  - `kybl`: `etag_is_md5 = false` because of server-side SSE-C, where ETags aren't MD5
- Its methods delegate to the existing functions, which become `pub(crate)` with no other change. `write(Stream)` calls `s3_stream::upload_stream`.

### 1.4 Dispatch inside the existing commands (minimal diff)

```rust
// commands.rs, each browse command gets this prelude; the rest of the body is unchanged
let conn = storage::registry::open(&app, &state, &profile_id).await?;
let Some(client) = conn.as_s3().map(|s| s.client().clone()) else {
    return storage::generic_cmds::list_objects(&*conn, &bucket, &prefix, token).await;
};
```

- `save_profile` and `delete_profile` each gain one line: `registry::forget(&id)`.
- `AppState` gains `backends: Mutex<HashMap<String, Arc<dyn Storage>>>`. `client_for` stays as it is for S3 callers.
- **Deferred consolidation**: once phase 1 and 2 have merged, the S3 bodies can move into `storage/s3.rs`.

### 1.5 How "bucket" maps to each provider (`roots()`)

| Kind | `roots()` | UI |
|---|---|---|
| S3, Azure (containers), GCS | buckets (or the profile's preset bucket) | as today |
| FTP/FTPS, SFTP, WebDAV | one root, `id=""`, named after the host or base path | `caps.roots = "single"`: the sidebar skips the bucket level and the breadcrumb starts at the connection |
| Local (`"local"` reserved id) | desktop: Home, Desktop, Documents, Downloads, volumes / drive letters; iOS: app Documents; Android: `Download/Kybl` | "This Mac / This PC" section (dual pane, transfers) |
| Google Drive | My Drive (`root`), each Shared Drive (drive id), virtual "Shared with me" (read-only) | `caps.roots = "drives"` |
| OneDrive | `me/drive` (later: SharePoint libraries) and virtual "Shared" | drives |
| Dropbox, Box | one root | single |

- The frontend keeps passing `bucket`, which is now the **root id**. Display text comes from `RootInfo.name`. Today the sidebar and breadcrumbs print the bucket string, so they need a small lookup.
- `list_buckets` keeps its shape for S3. A new `list_roots` returns `RootInfo[]` for every kind.

### 1.6 Capabilities (returned per connection)

```ts
// src/api.ts
export type Capabilities = {
  roots: "buckets" | "single" | "drives"; createRoot: boolean;
  folders: "prefix" | "real";                 // prefix: markers needed, empty folders vanish
  rename: "native" | "copy-delete"; serverCopy: "none" | "same-root" | "cross-root";
  share: "presign" | "link" | "none"; shareExpiry: boolean;
  streaming: "presign" | "proxy";             // proxy means media:// (see 1.9)
  rangeRead: boolean; conditionalWrite: "if-match" | "compare" | "rev" | "none";
  hashes: Array<"md5" | "sha1" | "sha256" | "quickxor" | "dropbox">;
  thumbnails: "local" | "remote" | "local+remote";
  metadata: "s3" | "none"; tags: boolean; storageClass: boolean;
  trash: boolean; versions: boolean; search: "scan" | "server"; changes: boolean;
  multipart: boolean; maxObjectSize: number | null; backgroundUpload: boolean;  // iOS URLSession eligibility
};
api.capabilities(profileId)  // invoke("connection_capabilities")
```

- The UI uses a `useCaps(profileId)` hook to hide things it can't do:
  - "Share link" when `share === "none"`
  - Properties and tags unless `metadata === "s3"`
  - "New bucket" unless `createRoot`
  - Storage-class columns
- When `rename === "copy-delete"`, a warning appears for folder rename.

### 1.7 Profile model and migration

```rust
pub struct Profile {
    pub id: String, pub name: String,
    #[serde(default)] pub kind: ConnKind,               // default S3: existing profiles.json loads unchanged
    // S3, flat as today (all #[serde(default)])
    pub provider: String, pub endpoint: String, pub region: String, pub access_key_id: String,
    pub bucket: Option<String>, pub path_style: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub net: Option<NetConfig>,     // ftp/sftp/webdav
    #[serde(default, skip_serializing_if = "Option::is_none")] pub cloud: Option<CloudConfig>, // oauth kinds
    #[serde(default, skip_serializing_if = "Option::is_none")] pub blob: Option<BlobConfig>,   // azure/gcs
}
pub struct NetConfig { host: String, port: u16, user: String, base_path: String,
                       tls: TlsMode /* none|explicit|implicit */, auth: NetAuth /* password|key|agent */,
                       host_key: Option<String> /* SFTP SHA256 fingerprint, trust on first use */, url: Option<String> /* webdav */ }
pub struct CloudConfig { account_email: String, account_id: String,
                         client_id: Option<String> /* "use your own" */, tenant: Option<String>, scopes: Vec<String> }
```

- **No on-disk migration is needed.** Serde defaults handle old files.
- `provider` stays the visual id: `gdrive`, `onedrive`, `sftp` and so on join `PROVIDERS` in `src/providers.ts`.
- **Downgrade caveat:** an older Kybl would show a non-S3 profile as a broken S3 entry. That is acceptable, and the release notes should say so.

### 1.8 Vault v2 (credentials on every platform)

- **Desktop and iOS**: one keychain item, `app.kybl.desktop / vault-key`, holds a random 32-byte key. Secrets live in `app_data_dir/vault.bin` as `nonce || AES-256-GCM(json map)` using `ring::aead`; ring is already a dependency.
  - This is still one keychain prompt, and it has no size limit.
- **Android**: `secrets.json` in private storage stays as it is. A key wrapped by the Android Keystore can come later.
- **Migration** happens on first read: if `vault-key` is missing and the old `connection-secrets` item exists, read the map, write `vault.bin`, write the key item, and only then delete the old item. The legacy per-connection items are already handled.
- **Key names** (the map stays `HashMap<String, String>`):
  - `"{id}"`: S3 secret / password / Azure key
  - `"{id}#oauth"`: JSON with the refresh token and the user's own client secret if they gave one
  - `"{id}#ssh"`: private key PEM and passphrase
- `delete_secret` removes `{id}` and every `{id}#*`.
- **Access tokens are never persisted.** They live in memory only.

### 1.9 `media://` streaming (range reads)

- URL: `media://localhost/<pct(profileId\nroot\nsize\netag\npath)>`, the same packing as `thumb://`.
- The handler parses `Range`, calls `Storage::read(range)`, and **caps every reply at 4 MiB** with `206` + `Content-Range`, even when the request was `bytes=0-`. Media elements accept a shorter 206 and ask for the next piece.
- The frontend's `src/media.ts::playableUrl(profile, root, entry)` returns a presigned URL when `caps.streaming === "presign"`, otherwise a `media://` URL.
- **Spike first:** WKWebView and AVFoundation behaviour with custom schemes on macOS and iOS. If it fails, use a loopback HTTP server bound to `127.0.0.1` with a random path token. The WebDAV mount (E4) shares that server.

### 1.10 Which backend for which provider: OpenDAL or hand-written

`opendal` 0.59.5 was released 2026-10-18 and has `services-webdav`, `-ftp`, `-sftp`, `-gdrive`, `-onedrive`, `-dropbox`, `-azblob`, `-gcs`, `-b2`. Rule: **use OpenDAL where the remote API is path-native; hand-write where it is ID-native or where OpenDAL can't model what the product needs.**

| Provider | Choice | Why |
|---|---|---|
| S3 family | existing `aws-sdk-s3` | Keeps presign, multipart copy, quirks, tests |
| WebDAV (Nextcloud, Synology, Box-DAV) | OpenDAL `services-webdav` | Mature, path-native |
| FTP/FTPS | OpenDAL `services-ftp` (suppaftp underneath) | Fine; fall back to hand-written suppaftp if FTPS TLS modes fall short |
| **SFTP** | **hand-written, `russh` + `russh-sftp` 4.0** (updated 2026-11-21) | OpenDAL's sftp is **Unix-only and spawns the system `ssh` binary** (`openssh` crate): no Windows, iOS or Android |
| Dropbox, OneDrive | OpenDAL for list/read/write/delete/copy/rename, plus small hand-written extras (share link, thumbnails, `content_hash`/`quickXorHash`, change cursors) | Path-native APIs; OpenDAL lacks the extras |
| **Google Drive** | **hand-written** (`reqwest` + JSON, ~1000 lines) | ID-based (duplicate names, path→id cache), Shared Drives (`supportsAllDrives`), exporting Google Docs/Sheets/Slides, `md5Checksum`, `thumbnailLink`, `changes.list` for two-way sync; OpenDAL's gdrive maps paths over My Drive only (flag: verify) |
| Azure Blob, GCS | OpenDAL | Low priority, cheap |
| Box | hand-written, later | ID-based, needs a client secret even with PKCE |
| Local | hand-written | Trivial; makes engine tests run without an S3 server |

- **Tokens with OpenDAL:** pass only an `access_token` and rebuild the `Operator` when `TokenSource` refreshes. Rebuilding is cheap.
  - Don't hand OpenDAL the refresh token. It would refresh internally and Kybl couldn't save Microsoft's rotated refresh tokens.
- **One HTTP stack:** a single shared `reqwest` client (rustls on **ring**, webpki roots on phones, as in `state::mobile_tls`) goes to OpenDAL (it accepts a custom HTTP client) and to the OAuth, Drive and Graph code.
  - CI check: `cargo tree -i aws-lc-rs` must be empty.
  - `russh` also needs its ring backend selected. Flag: its default crypto feature may pull in aws-lc-rs.

### 1.11 OAuth (desktop and phones)

```rust
// oauth/mod.rs
pub struct OAuthProvider { kind: ConnKind, auth_url: &'static str, token_url: &'static str, scopes: &'static [&'static str],
                           extra: &'static [(&'static str, &'static str)], redirect: RedirectKind }
pub enum RedirectKind { Loopback { fixed_ports: &'static [u16] /* empty = any */ }, AppScheme(&'static str) }
#[tauri::command] async fn oauth_start(app, state, kind: ConnKind, flow_id: String,
                                       client: Option<ClientOverride>, replace_id: Option<String>) -> Result<Profile, String>;
#[tauri::command] fn oauth_cancel(flow_id: String);
#[tauri::command] fn oauth_builtin_clients() -> HashMap<ConnKind, bool>;
// oauth/token.rs
pub struct TokenSource { profile_id: String, provider: &'static OAuthProvider, cache: tokio::sync::Mutex<Option<(String, Instant)>> }
impl TokenSource { pub async fn access_token(&self) -> SResult<String>; pub async fn force_refresh(&self) -> SResult<String>; }
```

**The flow** reuses `kybl_connect`'s `pkce_challenge`, `random_token`, `wait_for_code` and the loopback page; those helpers become `pub(crate)`.

- Desktop: open the system browser, redirect to `http://127.0.0.1:<port>/callback`.
- Android: a Custom Tab, via `KyblConnectPlugin.kt`, generalised.
- iOS: `ASWebAuthenticationSession`. `KyblConnectPlugin.swift` gets a `callbackScheme` argument instead of the hard-coded `"kybl"`. ASWebAuthenticationSession doesn't need the scheme registered in Info.plist.

**Per provider:**

| Provider | Desktop | Android | iOS | Notes |
|---|---|---|---|---|
| Google | "Desktop" client, loopback (any port), PKCE; the non-confidential client secret is compiled in | **Desktop client + loopback in a Custom Tab** (Google no longer accepts custom schemes for new Android clients). Spike early. Fallback: Play Services `AuthorizationClient` (silent re-authorize, no refresh token) | "iOS" client, reversed-client-id scheme `com.googleusercontent.apps.<id>:/oauth2redirect` | Scope `drive` is **restricted** (see risks) |
| Microsoft | public client, `http://localhost` (any port), PKCE, no secret, `common` tenant, `offline_access Files.ReadWrite.All User.Read` | custom scheme `kybl://oauth/onedrive` (needs an intent filter) | same scheme | **Refresh tokens rotate**: always save the new one |
| Dropbox | PKCE, `token_access_type=offline`, **fixed loopback ports must be registered** (for example 53682, 53683) | app scheme (flag: confirm Dropbox accepts custom schemes for this app type) | app scheme | Fallback: paste-the-code flow |

**Refresh behaviour:**

- A per-connection mutex makes refresh single-flight.
- Refresh when less than 120 s is left, or on a 401 (once).
- `invalid_grant` marks the connection `needs-auth` and emits `connection-auth {profileId}`. The UI then shows **Reconnect**, which reruns `oauth_start` with `replace_id` and keeps the profile id, sync mappings and jobs.

**Client IDs:**

- Built in at compile time: `option_env!("KYBL_GOOGLE_CLIENT_ID")`, `KYBL_GOOGLE_CLIENT_SECRET`, `KYBL_GOOGLE_IOS_CLIENT_ID`, `KYBL_MS_CLIENT_ID`, `KYBL_DROPBOX_APP_KEY`. They are set from GitHub secrets in `release.yml`.
- Each connection also gets an advanced **"Use your own OAuth app"** field: client id is stored in the profile, client secret in the vault as `{id}#oauth`.
- A provider with no built-in id shows "Needs your own client ID".

---

## 2. Feature B: copy and migrate between connections and providers

- **Recommended:** a persistent **job engine** in Rust. Job state lives in SQLite. It lists the source, streams each file into the target (parallel ranged reads in, multipart out), verifies, and resumes after a crash.
- Rejected: **"download to temp, then upload."** It needs disk equal to the largest file, has double latency, and fails on phones.
- Rejected: **JSON job files.** Rewriting them is O(n) per save, which is unworkable for millions of objects.

### 2.1 Modules and types

```
jobs/mod.rs    JobManager (managed state), commands, events, startup resume, notice hooks
jobs/db.rs     jobs.db schema
jobs/plan.rs   walk source -> items (INSERT OR IGNORE; resumable)
jobs/copy.rs   per item: server copy | stream copy; conflict policy; verify
jobs/hash.rs   streaming hashers: md5 (+ per-part md5 -> S3 multipart ETag), sha256 (ring), Dropbox content_hash, OneDrive quickXorHash
storage/s3_stream.rs  upload_stream(): multipart from a byte stream, Content-MD5 on every part, resumable (ListParts)
```

```rust
pub struct JobSpec { pub id: String, pub mode: JobMode /* Copy | Move */,
    pub src: Endpoint { profile_id, root, items: Vec<SelItem { path, is_dir }> },
    pub dst: Endpoint { profile_id, root, dir },
    pub conflict: Conflict /* SkipIdentical (default) | Skip | Overwrite | KeepBoth | NewerWins */,
    pub verify: Verify /* Size | Hash (default where possible) */,
    pub preserve_mtime: bool, pub ignore: Vec<String> }
pub enum JobState { Planning, Running, Paused, WaitingNetwork, NeedsAuth, Done, Failed, Cancelled }
#[derive(Serialize)] pub struct JobProgress { id, state, phase, files_done, files_total, files_failed, files_skipped,
    bytes_done, bytes_total, rate_bps, eta_secs: Option<u64>, current: Vec<String> }   // event "job-progress", at most 4/s
```

### 2.2 `jobs.db` schema

```sql
jobs(id TEXT PK, spec_json TEXT, state TEXT, error TEXT, created INT, updated INT, list_cursor_json TEXT);
items(job_id TEXT, src_path TEXT, dst_path TEXT, size INT, src_etag TEXT, src_mtime INT,
      state TEXT /* pending|running|done|skipped|failed */, attempts INT, error TEXT,
      dst_etag TEXT, sha256 TEXT, upload_id TEXT, parts_json TEXT, PRIMARY KEY(job_id, src_path));
CREATE INDEX items_pending ON items(job_id, state);
```

### 2.3 Engine behaviour

1. **Plan.** Run `Storage::walk` page by page and insert items. `list_cursor_json` holds the directory queue and page token. If S3 tokens have expired on resume, re-list and rely on `INSERT OR IGNORE`.
2. **Choose a route per item:**
   - Same profile with `serverCopy` capability: `Storage::copy`. That is phase-1 `move_many` with `destBucket` for S3 cross-bucket, or a native copy for Drive, OneDrive and Dropbox.
   - Otherwise stream. If the source has `rangeRead`, fetch parts with **parallel ranged reads**; this is fast and resumable per part. If not, read one sequential stream.
3. **Bounded memory.** A global byte-budget semaphore (256 MiB on desktop, 64 MiB on phones) is taken per part buffer. Part size starts at 16 MiB and grows to stay under 10,000 parts. Parts are in-memory `Bytes`, so a failed part can be retried.
4. **Resume.** Items left `running` at startup go back to `pending`. Their `upload_id` and `parts_json` are kept:
   - S3: confirm with `ListParts`.
   - Drive: query the resumable-session offset.
   - OneDrive: `GET uploadUrl`.

   If the source can be range-read, continue from the next part. Otherwise abort the upload and start the file again.
5. **Verify.**
   - Size, always.
   - **S3 targets: send `Content-MD5` on every PUT and UploadPart.** The server checks integrity on receipt. This works on Kybl Storage with SSE-C, where ETags aren't MD5, and on Hetzner/Ceph.
   - Drive: compare `md5Checksum` after upload. Dropbox: `content_hash`. OneDrive: `quickXorHash`. All are computed in-stream as bytes pass through.
   - Optionally store `x-amz-meta-kybl-sha256` on S3 targets for later dedupe.
6. **Move** deletes the source only after the item is verified, in batches. The same rule as `copy_many`.
7. **Bandwidth and concurrency:** use phase 1's `TransferPrefs`. **Contract with the phase-1 transfer-prefs package:** a shared limiter, `crate::transfers::throttle(n_bytes).await` (or whatever phase 1 names it), wrapped around both read and write streams. Phone jobs respect `wifiOnly`; when the network turns metered, the job goes to `WaitingNetwork`.
8. **Running in the background:**
   - Desktop: `JobManager` lives with the tray and keeps running with the window closed. The phase-1 quit warning is extended to running jobs.
   - Android: call `transfer_notice::queued(job_id, …)` so `TransferService` keeps the process alive. Android 15+ limits `dataSync` to 6 h per day: handle `onTimeout` by pausing as `WaitingNetwork`.
   - iOS: pause on going to background (after a `beginBackgroundTask` grace period) and resume on `app-resumed`.

### 2.4 Commands and frontend

```ts
api.jobCreate(spec) -> string;  api.jobList() -> JobSummary[];  api.jobPause(id); api.jobResume(id);
api.jobCancel(id); api.jobDelete(id); api.jobFailures(id, offset, limit) -> {path, error}[]; api.jobRetryFailed(id)
// event "job-progress": JobProgress
```

- New files: `src/jobs/useMigrations.ts` (a store like `useTransfers`), `src/jobs/MigrationDialog.tsx`, `src/jobs/LocationPicker.tsx` (a cross-connection tree, built on MoveDialog's tree), and a "Jobs" tab in `TransferPanel`.
- Entry points:
  - context menu "Copy to another connection…"
  - connection menu "Migrate everything to…"
  - dual-pane F5/F6 across connections (F)

---

## 3. Feature C: phone auto-backup and folder backup

- **Recommended:** Rust owns dedupe, naming, uploads and the index. Native code owns enumeration, permissions, scheduling and asset export.
  - **Every backup run happens in a native background worker**, even "Back up now", so there is one code path. It calls headless Rust entry points that need no `AppHandle`; this is why `core/` exists.
- Rejected: **running backups through the Tauri webview or app.** Android WorkManager runs without an Activity, so there is no Tauri app. An iOS BG task wakeup must not depend on the webview.
- Rejected: **reusing `sync.rs` wholesale.** It is desktop-only (notify, trash, ignore crates) and assumes a filesystem.

### 3.1 How the sync engine is reused

Split `sync.rs` (feature E, WP-E1) into a pure `sync/plan.rs` (no I/O):

```rust
pub fn plan_upload(local: &HashMap<String, LocalMeta>, db: &dyn BaseState, remote: Option<&HashMap<String, RemoteMeta>>,
                   opts: &UploadPlanOpts { mirror_deletes: bool, adopt_existing: bool }) -> UploadPlan;
```

and a generic `sync/runner.rs::run_jobs` over `Storage`, the current `run_jobs` and `RunBytes` made generic.

Backup is **`plan_upload` with `mirror_deletes = false` and `adopt_existing = true`**. The "local" map comes from native items keyed by the rendered remote path, and the base state is the backup index. On a first run against an existing folder it adopts files that already match by name and size, the same logic as `sync.rs:573`.

### 3.2 Rust (`backup/`)

```
backup/mod.rs      BackupManager, commands, events ("backup-status")
backup/index.rs    backup.db
backup/naming.rs   template rendering + collision names
backup/headless.rs JNI (Android) and C ABI (iOS) entry points
```

```rust
pub struct BackupSet { id: String, source: BackupSource /* CameraRoll | AndroidTree{uri} | IosBookmark{b64} */,
    profile_id: String, root: String, dest_prefix: String /* "Camera/" */, template: String /* "{yyyy}/{MM}/{name}" */,
    include_videos: bool, live_photo_video: bool, heic: Heic /* Keep | ConvertJpeg */, edited: Edited /* Current | Original | Both */,
    wifi_only: bool, charging_only: bool, since: Option<i64> /* "only new from now" */, enabled: bool }
```

- Template tokens: `{yyyy}` `{MM}` `{dd}` `{name}` `{ext}` `{device}` `{album}` `{type}`.
- On a name collision with different content: `IMG_0001 (2).HEIC`.
- **Deletes never propagate.** There is no option for it in v1. "Free up space" (deleting from the phone after backup) is a later item that needs OS consent dialogs.

```sql
-- backup.db
backup_items(set_id TEXT, source_id TEXT /* PHAsset localIdentifier#res | MediaStore volume:_ID | SAF docId */,
             version_key TEXT /* modified+size(+resource) */, remote_path TEXT, size INT, sha256 TEXT NULL,
             uploaded_at INT, PRIMARY KEY(set_id, source_id));
```

**Headless entry points.** Both run on `Core`'s tokio runtime, return JSON strings, and are safe to call while the Tauri app is also alive. When the Tauri app is up, `Core` sends events to it.

```rust
// Android (backup/headless.rs), called from BackupNative.kt on a worker thread
#[no_mangle] extern "system" fn Java_app_kybl_mobile_BackupNative_init(env: JNIEnv, _: JClass, ctx: JObject, data: JString, config: JString, cache: JString) -> jboolean; // also ndk_context::initialize_android_context
#[no_mangle] extern "system" fn Java_app_kybl_mobile_BackupNative_offer(env: JNIEnv, _: JClass, set_id: JString, items_json: JString) -> jstring;   // -> [{sourceId, remotePath}]
#[no_mangle] extern "system" fn Java_app_kybl_mobile_BackupNative_upload(env: JNIEnv, _: JClass, set_id: JString, source_id: JString, remote_path: JString, fd: jint, size: jlong, mtime: jlong) -> jstring; // takes ownership of fd
#[no_mangle] extern "system" fn Java_app_kybl_mobile_BackupNative_cancel(_: JNIEnv, _: JClass);
// iOS
#[no_mangle] pub extern "C" fn kybl_backup_offer(set_id: *const c_char, items_json: *const c_char) -> *mut c_char;
#[no_mangle] pub extern "C" fn kybl_backup_upload(set_id: *const c_char, source_id: *const c_char, remote_path: *const c_char, file_path: *const c_char, mtime_ms: i64) -> *mut c_char;
#[no_mangle] pub extern "C" fn kybl_backup_cancel();
#[no_mangle] pub extern "C" fn kybl_string_free(s: *mut c_char);
```

- Item JSON: `{sourceId, kind: "photo"|"video"|"livePhotoVideo"|"file", name, size, created, modified, mime, album?, relPath?}`.
- On Android, Rust reads the fd as `File::from_raw_fd` and streams it through `WriteSource::Stream` (with `reopen` via `read_at`), so big videos are **not** copied to the cache. If the fd is a pipe (cloud-backed SAF documents), the upload can't resume, which is acceptable.

### 3.3 Android (Kotlin)

- `BackupPlugin.kt` (Tauri plugin):
  - Permissions: `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_VISUAL_USER_SELECTED` for Android 14 partial access, `READ_EXTERNAL_STORAGE maxSdkVersion=32`, and **`ACCESS_MEDIA_LOCATION`** plus `MediaStore.setRequireOriginal()`. Without these, EXIF GPS is stripped.
  - SAF folder picking: `ACTION_OPEN_DOCUMENT_TREE` + `takePersistableUriPermission`. `Android/media/com.whatsapp/...` can be picked; `Android/data` can't.
  - Schedules work.
- `BackupWorker.kt`: a `CoroutineWorker`.
  - Constraints: unmetered and charging, per set.
  - Periodic every 15 min, plus a one-time worker with `addContentUriTrigger(MediaStore…EXTERNAL_CONTENT_URI)`.
  - `setForeground(ForegroundInfo(id, notif, FOREGROUND_SERVICE_TYPE_DATA_SYNC))` while uploading.
  - Enumerates MediaStore by `DATE_MODIFIED > lastRun` (with a full pass weekly), or SAF children through `DocumentsContract`. `DocumentFile` is too slow.
  - Calls `offer`, then `upload` per item with `openFileDescriptor().detachFd()`.
- `BackupNative.kt`: `System.loadLibrary("kybl_lib")` plus the `external fun` declarations.
- Gradle: `androidx.work:work-runtime-ktx`. Manifest: permissions and the `SystemForegroundService` `foregroundServiceType="dataSync"` override.

### 3.4 iOS (Swift package `gen/apple/KyblBackup`, linked from `build.rs` like KyblConnect)

- `BackupPlugin.swift`:
  - Photo access: `PHPhotoLibrary.requestAuthorization(for: .readWrite)`. Limited-library state is shown in the UI.
  - Enumeration: `PHAsset.fetchAssets` sorted by `creationDate`. Change tracking uses `PHPhotoLibrary.fetchPersistentChanges(since:)` on iOS 16+; the deployment target is 15, so iOS 15 falls back to diffing the set of local identifiers.
  - Export: `PHAssetResourceManager.writeData(for:toFile:options:)` with `isNetworkAccessAllowed = true` for **iCloud-only assets**, gated on Wi-Fi.
  - Resources: `.photo`, or `.fullSizePhoto` when edited, plus `.pairedVideo` for Live Photos. Optional HEIC to JPEG via ImageIO. Export goes to `Caches/backup/`, then `kybl_backup_upload(path)`, then the temp file is deleted.
  - Files-app folders: `UIDocumentPickerViewController(forOpeningContentTypes: [.folder])`, then `bookmarkData()`, stored as `IosBookmark`. Every run calls `startAccessingSecurityScopedResource()`.
- `BackgroundTasks`:
  - Register `app.kybl.mobile.backup` (`BGProcessingTaskRequest`, requires network, optionally external power) and `app.kybl.mobile.refresh` (`BGAppRefreshTask`, about 30 s: only checks for new assets and schedules processing).
  - Registration must happen before launch finishes. Verify that Tauri's plugin `load()` runs early enough; if not, register in `main.mm`.
- Info.plist (`project.yml`): `BGTaskSchedulerPermittedIdentifiers`, `UIBackgroundModes: [processing, fetch]`, `NSPhotoLibraryUsageDescription`.
- **v2:** background `URLSession` uploads, which continue while the app is suspended. They need pre-authorised requests, so they only work for backends with `caps.backgroundUpload`:
  - S3: presigned PUT and UploadPart per part file; completion runs in `handleEventsForBackgroundURLSession` and then Rust does `CompleteMultipartUpload`.
  - OneDrive: upload-session URLs need no auth header.
  - Drive: resumable session URI.
  - Not FTP or SFTP.

**Be honest with users:** iOS never guarantees timely background runs. v1 says "Backs up when Kybl is open, and overnight while charging."

---

## 4. Feature D: document viewer and editor

- **Recommended:** a lazy-loaded viewer registry.
  - CodeMirror 6 for text, code, JSON, YAML and CSV-as-text.
  - `marked` + `DOMPurify` for Markdown preview.
  - `papaparse` + the existing `useWindowed` for CSV tables.
  - `docx-preview` for DOCX.
  - SheetJS for XLSX, read-only.
  - PPTX shows the embedded `docProps/thumbnail.jpeg` plus a slide-text outline, extracted with JSZip; `pptx-preview` behind an "experimental" flag.
- Rejected: **Monaco.** Over 2 MB, poor on mobile.
- Rejected: **mammoth.** Its semantic HTML loses layout; docx-preview is more faithful for viewing.
- Rejected: **npm `xlsx@0.18.5`.** Stale, with CVE-2023-30533. Use the SheetJS CDN tarball pinned at 0.20.x (pnpm accepts URL deps) or `exceljs` as the fallback.

### 4.1 Frontend

```
src/viewers/registry.ts     ext/mime -> { load: () => import("./X"), canEdit, maxBytes }
src/viewers/useDocument.ts  open (bytes + meta), decode (TextDecoder fatal utf-8, BOM utf-16, otherwise read-only), dirty, save(precondition), conflicts
src/viewers/TextEditor.tsx  CodeMirror 6 (+ @codemirror/language-data lazy languages), find/replace, keeps line endings and BOM
src/viewers/MarkdownView.tsx  split view; output in a sandboxed iframe
src/viewers/CsvTable.tsx, DocxView.tsx, XlsxView.tsx, PptxView.tsx, ImageView.tsx
src/viewers/ConflictDialog.tsx  "Theirs changed: Reload / Overwrite / Save as copy"
src/viewers/SandboxFrame.tsx    <iframe sandbox="" srcdoc=...> (no allow-scripts) for every untrusted HTML
```

- **Security:** `csp` is `null` and every page can `invoke`. DOCX and Markdown HTML therefore render **only inside `sandbox` iframes**, and are also passed through DOMPurify.
- **Limits:** edit up to 5 MB; view up to 50 MB for CSV (papaparse in a worker, windowed rendering) and 30 MB for DOCX/XLSX. Above that, files open read-only or as "Open in another app" (phase-1 natives).
- **Placement:**
  - Desktop: "Open" in a full-window editor modal. A separate Tauri window per document can come later.
  - PreviewPane keeps showing small read-only previews.
  - Mobile: `Viewer.tsx` uses the same registry, with a Save/Undo bar that respects the `--a-*` insets.
- **Bundle:** each viewer is its own `import()` chunk, so it adds nothing to the first load. Rough sizes, to confirm in the build report: CodeMirror core about 130 KB gzipped, docx-preview with jszip about 100 KB, SheetJS about 140 KB.

### 4.2 Rust (`storage/doc.rs`)

```rust
#[tauri::command] async fn doc_open(app, state, profile_id: String, root: String, path: String, max_bytes: u64) -> Result<tauri::ipc::Response, String>;
// body framing: [u32 BE json_len][json DocMeta {etag, size, modified, contentType, version}][bytes], so meta and bytes come from one consistent GET
#[tauri::command] async fn doc_save(app, state, request: tauri::ipc::Request<'_>) -> Result<DocMeta, String>;
// raw body (InvokeBody::Raw); headers x-kybl-profile / x-kybl-root / x-kybl-path (pct-encoded) / x-kybl-expect (JSON Precondition)
// conflict -> Err("CONFLICT\n\n{json DocMeta of current}")
```

**Save strategy, by `caps.conditionalWrite`:**

- `if-match`: S3 on AWS, R2 and MinIO (`Quirks.conditional_put`), WebDAV, OneDrive.
- `compare`: Hetzner/Ceph and other S3, FTP, SFTP. HEAD (or stat), compare etag, size and mtime with what was opened, then PUT. The race window is a few milliseconds; this is documented.
- `rev`: Dropbox `mode=update&rev=…`.
- Drive: compare `md5Checksum` / `headRevisionId` before the update.

**S3 save keeps the object's headers.** A PUT replaces them, so first HEAD (and GetObjectTagging when `caps.tags`) and carry over Content-Type, Cache-Control, Content-Disposition, Content-Encoding, user metadata, storage class and `x-amz-tagging`.

---

## 5. Feature E: mount as a drive (files on demand) and two-way sync

### 5.1 Recommended stages

| Stage | What | Platforms | Needs |
|---|---|---|---|
| E1 | **Two-way sync v2** + "Keep on this device" folders (a fully local, two-way synced copy) | all desktops | nothing |
| E2 | **Windows Cloud Files API** (placeholders, hydrate on open, pin / free up space, Explorer badges) | Windows 10 1709+ on NTFS | No admin, no driver (`cldflt.sys` ships with Windows). Unpackaged apps can register sync roots (Nextcloud's MSI does; verify). Code signing optional but helps with SmartScreen |
| E3 | **Linux FUSE** via `fuser` 0.19 | Linux | libfuse/fusermount3 (standard) |
| E4 | **macOS "Mount (beta)"**: local WebDAV server (`dav-server` 0.12) + `open webdav://127.0.0.1:port/...` / `mount_webdav`; also `gio mount dav://` on Linux | macOS (Linux optional) | nothing; it is a stopgap |
| E5 | **macOS File Provider** (`NSFileProviderReplicatedExtension`): Finder badges, "Keep Downloaded" / "Remove Download", Spotlight | macOS 12+ | **Apple Developer Program**, Developer ID cert, provisioning profile with App Group + File Provider entitlement for the `.appex`, **notarization**, a new bundling step |

**Rejected as defaults:**

- **macFUSE**: the kext needs reduced security on Apple Silicon. Its FSKit backend is opt-in (macOS 15.4+/26) and still getting data-corruption fixes in 5.5.
- **FUSE-T**: a third-party install, and the licence terms need checking.
- **WinFsp**: a driver install with admin rights, and GPL-with-exception.
- **Windows WebDAV redirector**: WebClient is deprecated and not started by default, files are capped at 50 MB, raising the cap needs admin and a registry edit, and it is slow on first connect.
- **FSKit directly**: it also needs an extension and signing.

### 5.2 Two-way sync v2 (`sync/` split; API unchanged plus `direction: "twoway"`)

```
sync/mod.rs     manager + existing commands (sync_list/save/delete/now/set_paused/pause_all) + sync_conflicts, sync_confirm_deletes
sync/plan.rs    pure: plan_upload, plan_download, plan_twoway (shared with backup)
sync/runner.rs  generic job runner over Storage (today's run_jobs/exec_job)
sync/state.rs   sync.db (replaces sync/<id>.json; imports the json on first open and keeps it as .bak)
sync/local.rs   scan_local (+ file ids), watcher, trash, conflict naming (desktop)
sync/remote.rs  remote snapshot via walk() or changes(cursor)
```

```sql
base(mapping_id, path, kind, l_size, l_mtime, l_fileid, r_etag, r_size, r_mtime, r_id, hash NULL, pinned INT, synced_at, PRIMARY KEY(mapping_id, path));
tombstones(mapping_id, path, side /* local|remote */, deleted_at, base_json);  -- kept 30 days
cursors(mapping_id, remote_cursor TEXT, last_full_scan INT);
```

**One run of the algorithm:**

1. Take three snapshots: Local (a full scan, or the watcher's dirty set), Remote (a listing or `changes(cursor)`), and Base. **Act only on complete snapshots.**
2. **Detect renames first.**
   - Local: a vanished base path and a new path with the same file id (inode / NTFS file id), or the same size and mtime when no id exists.
   - Remote: stable ids from Drive, OneDrive and Dropbox changes. On S3, a vanished key and a new key with the same etag and size.
   - Apply a rename as a rename on the other side, not as a transfer.
3. Classify each path as ΔL and ΔR against the base: none / created / modified / deleted. Then decide:

| ΔL \ ΔR | none | modified/created | deleted |
|---|---|---|---|
| none | – | pull | delete local (to Trash) |
| modified/created | push | same content → just update base; otherwise **conflict**: remote keeps the name, local becomes `name (conflict <device> <date>).ext` and is pushed too | push (the edit wins) |
| deleted | delete remote (see the safety rules below) | pull (the edit wins) | drop base |

**Deletes and safety:**

- Local deletes go to the system Trash (already the case).
- Remote deletes use the provider's trash when `caps.trash`. On S3, with the "remote trash" option (default on for two-way), files move to `<prefix>.kybl-trash/<date>/`.
- **Mass-delete guard:** if a run would delete more than max(50, 20%) of tracked files, or one side is empty, the mapping pauses with "Confirm deletions".
- Tombstones make deletes idempotent, so files don't come back after an interrupted run.

**Correctness details:**

- Compare paths NFC-normalised (`unicode-normalization`): macOS stores NFD.
- Detect keys that collide on a case-insensitive filesystem; skip and report them.
- Set the local mtime to the remote time after a download (`filetime`) so the next scan sees no change.
- Keep atomic `.s3part` downloads.

**Pinning ("Always keep on this device"):**

- cfapi, FUSE and File Provider roots share this state database and planner. "Local present" includes dehydrated placeholders, which hold metadata only.
- `pinned` is a column. The planner keeps pinned subtrees hydrated; unpinned files can be dehydrated with "Free up space".
- On Windows, pin state comes from `FILE_ATTRIBUTE_PINNED` / `CfGetPlaceholderInfo`. On macOS it comes from File Provider content policy.

### 5.3 Implementation notes per mount backend

- **cfapi** (`mount/windows.rs`):
  - `cloud-filter` 0.0.7 (updated 2026-11-05, young; fallback is the raw `windows` crate with `Win32_Storage_CloudFilters`).
  - Registration via `StorageProviderSyncRootManager`. Placeholders are created lazily from `list()`.
  - On `FETCH_DATA`: `Storage::read(range)`, then `CfExecute(TRANSFER_DATA)` in 4 KiB-aligned chunks.
  - Local writes reach sync v2 through `ReadDirectoryChangesW`, followed by `CfSetInSyncState`.
  - Kybl must be running for hydration. It already starts at login in the tray.
- **FUSE** (`mount/fuse.rs`):
  - inode ↔ path table; metadata cache with a TTL; range reads into an on-disk block cache (`cache_dir/mount/<id>/`).
  - Write-back: write to a cache file, upload on `release`.
- **WebDAV** (`mount/webdav.rs`):
  - `dav-server` with a `DavFileSystem` backed by `Storage` and the same on-disk cache.
  - Filter `._*` and `.DS_Store`. Cache PROPFIND results.
  - Bind to `127.0.0.1` with random credentials. Finder issues full PUTs on close, so buffer to disk.
- **File Provider** (E5):
  - The extension links the Rust core as a static lib with a C ABI (generated with cbindgen). This is where `core/` gets extracted into its own crate, `kybl-core`.
  - Credentials go through a shared keychain access group, which needs a team ID. State goes in the App Group container.
  - The enumerator uses sync anchors (Drive/OneDrive delta, an S3 listing diff). `fetchContents` reads into the provided URL.
  - Prefer this over XPC to the main app: it works even when Kybl isn't running.
  - Tauri's bundler doesn't build `.appex` targets: add an `xcodebuild` step, copy into `Kybl.app/Contents/PlugIns`, then re-sign inside-out.
  - Switching from the self-signed cert to Developer ID costs users one more keychain prompt (the README already warns about this).

---

## 6. Feature F: dual-pane mode and the Local provider

- **Recommended:**
  - Extract a self-contained `BrowserPane` with hooks.
  - `App.tsx` (1488 lines) becomes a thin shell holding global dialogs, the sidebar, transfers and settings.
  - Dual pane is a layout option. **Single pane stays the default.**
  - The **Local provider** (reserved profile id `"local"`, a `LocalBackend` in Rust) makes disk just another pane source, so pane code doesn't special-case it.
- Rejected: **two copies of App's state in one component.** It would double the existing monolith.
- Rejected: **a separate "local file browser" component.** It duplicates the table, grid and selection code.

### 6.1 Frontend layout

```
src/browser/useLocation.ts     {profileId, root, prefix} + back/forward history, navigate, openRoot
src/browser/useListing.ts      load/loadRest/refresh/search with request ids (fixes audit #2, #3, #8 by construction)
src/browser/useSelection.ts    selected/anchor/cursor/moveSelection/selectAll
src/browser/useEntryActions.ts delete/rename/newFolder/download/upload/relocate/copyLink/open, gated by useCaps
src/browser/BrowserPane.tsx    pane toolbar (breadcrumbs, view, search), FileTable/GridView, empty/error states
src/browser/PaneContext.tsx    active-pane API for the menu bar, keyboard and Sidebar
src/shell/AppShell.tsx         (today's App.tsx) Sidebar, TransferPanel, Settings, Toasts, dialogs via useDialogs()
src/shell/useDialogs.tsx       ConfirmDialog/PromptDialog/MoveDialog as a context, so panes can open them
src/shell/DualPane.tsx         two BrowserPanes + splitter; key handling
src/compare/compareFolders.ts  diff of two listings (missing / size / mtime / etag); recursive via a "compare" job
```

**Behaviour:**

- `settings.layout: "single" | "dual"`, default `"single"`.
- Keys: **Tab** switches the active pane; **F5** copy, **F6** move, **F7** new folder, **F8** delete, **⌘U / Ctrl+U** swap panes, **F3 or Space** quick view (PreviewPane as an overlay in dual mode).
- "Sync browsing" toggle: navigating into a subfolder makes the other pane follow when the same subfolder exists there.
- "Compare folders" selects files that differ.
- The Sidebar works on the active pane.

**Routing F5/F6 by source and target:**

| From → to | Route |
|---|---|
| same profile, same root | `move_many` |
| same profile, other root (S3) | phase-1 `move_many` with `destBucket` |
| local → cloud | existing `startUpload` with the local path |
| cloud → local | existing `startDownload` into the pane's directory |
| cloud → other cloud | migration job (B), shown in Jobs |

**Order:** this refactor starts **after phase 1 merges**. Phase 1 touches `App.tsx` heavily. Desktop capability gating (context menus) belongs to this package because `useEntryActions` replaces those menus.

---

## 7. Dependencies (verify versions when adding)

| Crate / package | Why | Status / flags |
|---|---|---|
| `async-trait` | `dyn Storage` with async methods | dtolnay, stable |
| `futures-core` / `futures-util` | streams | already in the tree transitively |
| `opendal` 0.59.x, `default-features=false`, services `webdav, ftp, dropbox, onedrive, azblob, gcs` | non-S3 backends | Active (2026-10). **Pin the minor version**: the API changes between minors. Hand it the shared HTTP client |
| `reqwest` (rustls, ring; webpki roots on phones) | OpenDAL + OAuth + Drive/Graph | Keep it on ring; CI check `cargo tree -i aws-lc-rs` |
| `russh` + `russh-sftp` 4.0 | SFTP on all 5 OSes | Active (2026-11-21); select ring crypto |
| `rusqlite` (`bundled`) | jobs.db, sync.db, backup.db | Builds for iOS/Android through cc; about +0.7 MB |
| `md-5` | Content-MD5, S3 multipart ETag | RustCrypto; ring has no MD5 |
| `unicode-normalization`, `filetime` | sync v2 correctness | stable |
| `dav-server` 0.12 | E4 WebDAV server | active (2026-11-09) |
| `fuser` 0.19 | E3 Linux FUSE | active (2026-11-20) |
| `cloud-filter` 0.0.7 / `windows` | E2 cfapi | young; keep the raw `windows` fallback |
| `base64` (move to the common deps) | vault, OAuth | already used on mobile |
| npm `codemirror`, `@codemirror/language-data`, `@codemirror/lang-markdown`, `@codemirror/lang-json` | editor | stable |
| npm `marked`, `dompurify` | Markdown | stable |
| npm `papaparse` | CSV | stable |
| npm `docx-preview`, `jszip` | DOCX, PPTX thumbnail and outline | maintained |
| SheetJS `xlsx` from `cdn.sheetjs.com` tarball (0.20.x) | XLSX | npm copy is stale with a CVE; fallback `exceljs` |
| npm `pptx-preview` | experimental PPTX | maturity uncertain |
| Kotlin `androidx.work:work-runtime-ktx` | background backup | stable |
| Swift Photos, BackgroundTasks, UniformTypeIdentifiers | backup | system frameworks |

Binary size estimate: OpenDAL, reqwest, russh and rusqlite together add roughly 4-7 MB. I haven't measured this. If it matters, cargo features can gate providers per platform.

---

## 8. Persistence formats (summary)

| File | Format | Change |
|---|---|---|
| `app_config_dir/profiles.json` | Profile array | superset: `kind`, `net`, `cloud`, `blob` (serde defaults, no migration) |
| keychain `app.kybl.desktop/vault-key` + `app_data_dir/vault.bin` | AES-256-GCM JSON map | new; migrated from `connection-secrets` |
| Android `secrets.json` | JSON map | unchanged; namespaced keys `{id}#oauth`, `{id}#ssh` |
| `app_config_dir/sync.json` | mappings | `direction: "twoway"`, `remoteTrash`, `deleteGuard` (defaults) |
| `app_data_dir/sync.db` | SQLite (WAL) | replaces `sync/<id>.json` (imported on first open, kept as `.bak`) |
| `app_data_dir/jobs.db` | SQLite | new |
| `app_config_dir/backup.json` + `app_data_dir/backup.db` | JSON sets + SQLite index | new (phones) |
| `app_config_dir/mounts.json` + `cache_dir/mount/<id>/` | mounts + block cache | new (desktop) |

Each subsystem has its own database file, so migrations are independent, nobody contends for the write lock, and deleting a file resets just that subsystem.

---

## 9. Risks and what needs the owner

**Accounts and registrations:**

- **Google:**
  - Cloud project, OAuth consent screen, a Desktop client and an iOS client.
  - The `drive` scope is restricted. Unverified apps are capped at **100 new users** and show a warning. Verification needs a privacy policy, a verified kybl.app domain, a demo video, and takes weeks.
  - Google says the annual CASA assessment applies when restricted data passes through **a server**. Kybl is client-side, so it likely doesn't apply; confirm with Google.
  - **Ship Drive as "bring your own client ID" first**, with the built-in ID as a beta.
- **Microsoft:**
  - Entra app registration (multi-tenant plus personal accounts) as a public client with the localhost and app-scheme redirects.
  - **Publisher verification** (a free Partner Network ID), otherwise many work tenants block consent.
- **Dropbox:** an app key, registered fixed loopback ports, and a request for production status once past the development user limit (check Dropbox's current number).
- **Apple Developer Program** ($99 a year) is required for E5 (File Provider + notarization). It would also make TestFlight and a signed iOS build possible. Moving macOS to Developer ID costs users one more keychain prompt.

**Build and release changes:**

- GitHub secrets for the OAuth client ids, passed as env in `release.yml`.
- The Windows cfapi sync root is unpackaged. Nextcloud shows this works; verify early.

**Platform constraints:**

- Android 15+ limits `dataSync` foreground services to 6 h a day.
- MediaStore strips GPS from EXIF without `ACCESS_MEDIA_LOCATION`.
- Starting a foreground service from the background is restricted, so use WorkManager's `setForeground`.
- iOS backup is best-effort only. Sideloaded apps also stop working entirely when the 7-day free signing lapses.
- Extensions count against AltStore's 3-app limit. That only matters if an iOS extension is added later.

**Technical risks to spike first:**

1. `media://` video playback with Range on WKWebView (macOS and iOS).
2. Google loopback sign-in on Android in a Custom Tab.
3. Timing of `BGTaskScheduler` registration under Tauri on iOS.
4. Gaps in OpenDAL's OneDrive and Dropbox writers: upload sessions for big files.
5. `cloud-filter` maturity.

**Security:**

- Untrusted HTML must render only in sandboxed iframes. A real CSP is a separate hardening task.
- Plain FTP sends credentials in clear text: warn in the UI.
- SFTP host keys are trusted on first use, with an alert when they change.

---

## 10. Work packages for parallel agents

**Wave 0 (one agent, starts after phase 1 merges; it freezes the contracts):**

- **WP0 Storage core**
  - Owns: `core/*`, `storage/{mod,registry,s3,local,generic_cmds}.rs`, `storage/s3_stream.rs` (a **stub** returning `Unsupported`).
  - Edits: the vault and `Profile` in `state.rs`; two-line preludes in `commands.rs`; `lib.rs` registration (`list_roots`, `connection_capabilities`); `Cargo.toml` (async-trait, rusqlite, base64); `src/api.ts` + `src/types.ts` (ConnKind, RootInfo, Capabilities, the new optional Profile fields); `devMock.ts`.
  - Done when: existing tests pass unchanged, LocalBackend has unit tests, and the generic commands pass against Local.

**Wave 1 (in parallel; each owns the files listed):**

| WP | Owns | Touches (small, agreed edits) | Contract it delivers |
|---|---|---|---|
| **A1 Network backends** | `storage/{dal,sftp}.rs` | `Cargo.toml` [deps: opendal, reqwest, russh*], `registry.rs` (one match arm per kind) | `Storage` impls for webdav, ftp, sftp, azblob, gcs |
| **A2 OAuth + clouds** | `oauth/*`, `storage/gdrive/*`, `storage/extras/*` | `kybl_connect.rs` (helpers made `pub(crate)`), `KyblConnectPlugin.swift/.kt` (scheme argument), `AndroidManifest.xml` (oauth intent filter), `release.yml` (env), `registry.rs` arms | `oauth_start`, `oauth_cancel`, `oauth_builtin_clients`, the `connection-auth` event, Drive/OneDrive/Dropbox backends |
| **A3 Connections UI** | `src/connections/*` (split from `ConnectionDialog.tsx`), `src/providers.ts`, `src/components/Sidebar.tsx`, `src/useCaps.ts` | `src/mobile/MobileApp.tsx` (gating, root names), `src/mobile/SettingsScreen.tsx` | kind picker, forms, Reconnect, single-root collapse |
| **A4 Media + thumbs** | `storage/media.rs`, `src/media.ts` | `thumbs.rs` (generic read, remote thumbnails), `lib.rs` (one line), `src/thumbs.ts` | `playableUrl()`, the `media://` scheme |
| **D Viewers/editor** | `src/viewers/*`, `storage/doc.rs` | `PreviewPane.tsx`, `mobile/Viewer.tsx` (wires the registry **and** A4's `playableUrl`), `package.json`, `vite.config.ts` | `doc_open`, `doc_save` |
| **B1 Migration engine** | `jobs/*`, `storage/s3_stream.rs` (real implementation) | `lib.rs`, `transfer_notice` call sites only | `job_*` commands, the `job-progress` event |
| **E1 Sync v2** | `sync/*` (split of `sync.rs`) | `tray.rs` (conflict and confirm items) | `plan_upload` (exported for C1), `direction: "twoway"`, `sync.db` |
| **F Dual pane** | `src/App.tsx` → `src/shell/*`, `src/browser/*`, `src/compare/*` | `Toolbar.tsx`, `FileTable.tsx`, `GridView.tsx` (props only), `settings.ts` (`layout`) | `PaneContext`, `useDialogs` |
| **C1 Backup core** | `backup/*` | `lib.rs`; uses `sync/plan.rs` from E1 (until E1 lands, put `plan_upload` in `sync/plan.rs` first in a tiny shared commit) | the JNI and C ABI signatures in §3.2, the `backup_*` commands |
| **C2 Android backup** | `BackupPlugin.kt`, `BackupWorker.kt`, `BackupNative.kt` | `AndroidManifest.xml`, `app/build.gradle.kts` | follows the §3.2 JNI contract |
| **C3 iOS backup** | `gen/apple/KyblBackup/*` | `build.rs` (link the second package), `project.yml` (plist keys) | follows the §3.2 C ABI |

**Wave 2:**

- **B2** Migration UI: `src/jobs/*`, plus entry points in `src/browser/useEntryActions.ts` once F has landed.
- **C4** Mobile backup screens in `src/mobile/BackupScreen.tsx`.
- **E2** Windows cfapi (`mount/windows.rs`).
- **E3** Linux FUSE (`mount/fuse.rs`).
- **E4** macOS WebDAV mount beta (`mount/webdav.rs`), with a shared `mount/mod.rs` from whoever lands first.

**Wave 3 (needs owner decisions):**

- **E5** macOS File Provider: Apple account, crate split into `kybl-core`, `.appex` build.
- **C5** iOS background URLSession.
- Box, plus Azure/GCS extras.

**Shared hot files and merge rules:**

- `lib.rs` `generate_handler!`: each WP appends its own block with a `// WP-x` comment.
- `Cargo.toml`: each WP adds a separate commented section. Regenerate `Cargo.lock` on merge.
- `api.ts`: each WP appends its own section at the end.
- `registry.rs`: one match arm per kind.
- `PreviewPane.tsx` and `Viewer.tsx` belong to D only.
- `App.tsx` belongs to F only. A3 does gating on mobile and in Sidebar; F does it on desktop.

**Suggested order** for the best product outcome in a few focused rounds:

1. WP0
2. A1, A3, A4, D and F in parallel (SFTP, WebDAV, FTP, Local, editor and dual pane ship together)
3. A2 and B1/B2 (clouds plus migration: "move my Dropbox to Kybl")
4. E1, then C1-C3 (two-way sync, then phone backup)
5. E2, E3, E4
6. E5 when there is an Apple account

---

### Critical Files for Implementation
- src-tauri/src/state.rs
- src-tauri/src/commands.rs
- src-tauri/src/sync.rs
- src-tauri/src/kybl_connect.rs
- src/App.tsx
- src/api.ts

Sources:
- [crates.io: opendal](https://crates.io/api/v1/crates/opendal)
- [OpenDAL SFTP service docs](https://opendal.apache.org/docs/services/sftp)
- [docs.rs: opendal-service-sftp](https://docs.rs/opendal-service-sftp)
- [crates.io: cloud-filter](https://crates.io/api/v1/crates/cloud-filter)
- [crates.io: dav-server](https://crates.io/api/v1/crates/dav-server)
- [crates.io: russh-sftp](https://crates.io/api/v1/crates/russh-sftp)
- [crates.io: fuser](https://crates.io/api/v1/crates/fuser)
- [macFUSE 5.1.0 announcement](https://macfuse.github.io/2025/10/30/macfuse-5.1.0.html)
- [macFUSE 5.0.0 announcement](https://macfuse.github.io/2025/05/05/macfuse-5.0.0.html)
- [macFUSE 5.5.0 release](https://newreleases.io/project/github/macfuse/macfuse/release/macfuse-5.5.0)
- [rclone forum: fuse-t via FSKit](https://forum.rclone.org/t/macos-rclone-mount-with-fuse-t-via-fskit/53608)
- [Microsoft Q&A: WebClient deprecation](https://learn.microsoft.com/en-us/answers/questions/1609470/inquiry-about-the-deprecation-of-webclient-webdav)
- [Microsoft KB 900900: WebDAV file size limit](https://support.microsoft.com/kb/900900)
- [Google restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google OAuth verification FAQ](https://support.google.com/cloud/answer/13463817)
- [Google unverified apps](https://support.google.com/cloud/answer/7454865?hl=enref)
- [SheetJS issue #3012 (CVE in 0.18.5)](https://git.sheetjs.com/sheetjs/sheetjs/issues/3012)
- [SheetJS issue #2961 (CDN install)](https://git.sheetjs.com/sheetjs/sheetjs/issues/2961)
- [GitLab advisories: npm xlsx](https://advisories.gitlab.com/pkg/npm/xlsx/)