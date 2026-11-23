//! The storage core: one trait, [`Storage`], for every place files can live (S3 today, the local
//! disk, and the network and cloud providers that build on it).
//!
//! The frontend's model stays as it is: a connection (profile id), a root (the "bucket" argument
//! of every command), and keys inside it where folders end with `/`. For S3 a root is a bucket;
//! for the local disk it is a folder such as Home; for Google Drive it will be a drive.
//!
//! The existing S3 commands keep their bodies: each starts with [`connect`], which hands back
//! the S3 client for S3 connections and sends everything else to [`generic_cmds`].
//!
//! The types here are a contract for the backends and engines still to come (network and cloud
//! providers, copying between connections, the editor), so not all of them are used yet.
#![allow(dead_code)]

pub mod certtrust;
pub mod dal;
pub mod ftp;
pub mod generic_cmds;
pub mod local;
pub(crate) mod net;
// WP-A4: video and audio through media:// or a loopback server
pub mod media;
pub mod registry;
pub mod s3;
pub mod s3_stream;
pub mod sftp;
pub mod webdav;
// WP-A2: cloud drives
pub mod dropbox;
pub mod extras;
pub mod gdrive;
pub mod onedrive;

use std::{
    fmt,
    future::Future,
    io,
    ops::Range,
    path::PathBuf,
    pin::Pin,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

use bytes::Bytes;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::state::AppState;

pub type SResult<T> = Result<T, StorageError>;
pub type BoxStream<'a, T> = Pin<Box<dyn Stream<Item = T> + Send + 'a>>;
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// The body of a read, or of a write from something that isn't a file.
pub type ByteStream = BoxStream<'static, io::Result<Bytes>>;
/// Progress callback: (bytes done, total bytes). Same type the S3 transfers use.
pub type Progress<'a> = crate::transfers::Progress<'a>;

// ---------------------------------------------------------------- kinds

/// What kind of storage a connection is. Profiles saved before this existed have no `kind` and
/// load as S3. A kind written by a newer Kybl loads as `Unknown` instead of breaking the list.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase", from = "String")]
pub enum ConnKind {
    #[default]
    S3,
    /// This computer or phone (the reserved connection id `registry::LOCAL_ID`)
    Local,
    Ftp,
    Sftp,
    Webdav,
    Gdrive,
    Onedrive,
    Dropbox,
    Azblob,
    Gcs,
    #[serde(rename = "box")]
    BoxCom,
    Unknown,
}

impl ConnKind {
    const NAMES: [(ConnKind, &'static str); 11] = [
        (ConnKind::S3, "s3"),
        (ConnKind::Local, "local"),
        (ConnKind::Ftp, "ftp"),
        (ConnKind::Sftp, "sftp"),
        (ConnKind::Webdav, "webdav"),
        (ConnKind::Gdrive, "gdrive"),
        (ConnKind::Onedrive, "onedrive"),
        (ConnKind::Dropbox, "dropbox"),
        (ConnKind::Azblob, "azblob"),
        (ConnKind::Gcs, "gcs"),
        (ConnKind::BoxCom, "box"),
    ];

    /// How people call it, for messages.
    pub fn label(self) -> &'static str {
        match self {
            ConnKind::S3 => "S3",
            ConnKind::Local => "This device",
            ConnKind::Ftp => "FTP",
            ConnKind::Sftp => "SFTP",
            ConnKind::Webdav => "WebDAV",
            ConnKind::Gdrive => "Google Drive",
            ConnKind::Onedrive => "OneDrive",
            ConnKind::Dropbox => "Dropbox",
            ConnKind::Azblob => "Azure Blob Storage",
            ConnKind::Gcs => "Google Cloud Storage",
            ConnKind::BoxCom => "Box",
            ConnKind::Unknown => "This kind of",
        }
    }
}

impl From<String> for ConnKind {
    fn from(s: String) -> Self {
        Self::NAMES.iter().find(|(_, n)| *n == s).map(|(k, _)| *k).unwrap_or(ConnKind::Unknown)
    }
}

// ---------------------------------------------------------------- entries

/// Content hashes a provider reports; whichever it has.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hashes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quickxor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropbox: Option<String>,
}

impl Hashes {
    pub fn is_empty(&self) -> bool {
        self.md5.is_none() && self.sha1.is_none() && self.sha256.is_none() && self.quickxor.is_none() && self.dropbox.is_none()
    }
}

/// A Google Docs / Sheets / Slides file: no bytes of its own, only exports.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDoc {
    pub exports: Vec<ExportFormat>,
    /// where the file opens in the browser (it can only be edited there); a mounted drive shows
    /// the file as a shortcut to this page (`mount::link`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportFormat {
    pub mime: String,
    /// file extension without the dot, e.g. "docx"
    pub ext: String,
    pub label: String,
}

/// One file (or, in walks, one folder: key ending with `/`). Serializes exactly like the S3
/// listing always did (`key`, `size`, `modified`, `etag`, `storageClass`); the other fields only
/// appear when a provider fills them. It is the `ObjInfo` of the S3 commands.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// path within the root; folders end with '/'
    pub key: String,
    pub size: i64,
    /// milliseconds since the epoch
    pub modified: Option<i64>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
    /// providers that address files by id (Drive, Box); the UI keys rows by it when present
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Hashes::is_empty")]
    pub hashes: Hashes,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native: Option<NativeDoc>,
}

impl Entry {
    pub fn is_dir(&self) -> bool {
        self.key.ends_with('/')
    }
}

/// One page of a folder listing: subfolders (full keys ending with `/`) and files.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub folders: Vec<String>,
    pub objects: Vec<Entry>,
    pub next_token: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RootKind {
    /// an S3 / Azure / GCS bucket or container
    Bucket,
    /// a cloud drive (My Drive, a Shared Drive, OneDrive)
    Drive,
    /// a virtual "Shared with me"
    Shared,
    /// the one root of a server connection (FTP, SFTP, WebDAV, Dropbox)
    Folder,
    Home,
    Desktop,
    Documents,
    Downloads,
    /// a disk, volume or drive letter
    Volume,
}

/// Where browsing starts: what `list_roots` answers. The `id` is what the frontend passes as
/// `bucket`. Local roots use the folder's absolute path as their id.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub id: String,
    pub name: String,
    pub kind: RootKind,
    pub created: Option<i64>,
    pub read_only: bool,
}

/// A place inside a connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Loc {
    pub root: String,
    pub path: String,
}

impl Loc {
    pub fn new(root: impl Into<String>, path: impl Into<String>) -> Self {
        Self { root: root.into(), path: path.into() }
    }
}

/// A read: the bytes, and what the server said about them.
pub struct ReadStream {
    pub body: ByteStream,
    /// bytes this body will carry, when known
    pub len: Option<u64>,
    /// size of the whole file, when known
    pub total: Option<u64>,
    /// the range actually sent; None when the whole file comes
    pub range: Option<Range<u64>>,
    pub etag: Option<String>,
    pub content_type: Option<String>,
}

impl ReadStream {
    /// Reads the body into memory, refusing (TooLarge) once it passes `max` bytes.
    pub async fn collect(mut self, max: u64) -> SResult<Vec<u8>> {
        use futures_util::StreamExt;
        if self.len.is_some_and(|l| l > max) {
            return Err(StorageError::too_large());
        }
        let mut buf = Vec::with_capacity(self.len.unwrap_or(0).min(max) as usize);
        while let Some(chunk) = self.body.next().await {
            buf.extend_from_slice(&chunk?);
            if buf.len() as u64 > max {
                return Err(StorageError::too_large());
            }
        }
        Ok(buf)
    }
}

// ---------------------------------------------------------------- writes

/// Opens the source again from a byte offset (a retry of a failed part, or a resumed upload).
pub type Reopen = Box<dyn Fn(u64) -> BoxFuture<'static, io::Result<ByteStream>> + Send + Sync>;

pub enum WriteSource {
    /// A local file: re-readable, so uploads can retry parts and resume.
    Path(PathBuf),
    /// Small content in memory (editor saves).
    Bytes(Bytes),
    /// Bytes coming from elsewhere (copying between connections).
    Stream { len: Option<u64>, body: ByteStream, reopen: Option<Reopen> },
}

/// What must be true of the destination for a write to go ahead.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Precondition {
    #[default]
    None,
    /// the current file has this ETag
    IfMatch(String),
    /// nothing is there yet
    IfNoneMatch,
    /// the file is still what was read earlier (stores without ETags compare size and time)
    IfUnchanged { etag: Option<String>, size: i64, modified: Option<i64> },
}

/// One part of a multipart upload that made it, kept so the upload can resume.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PartRecord {
    pub number: u32,
    pub size: u64,
    pub etag: String,
}

/// An interrupted multipart upload to carry on with.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResumeState {
    pub upload_id: String,
    pub part_size: u64,
    pub parts: Vec<PartRecord>,
}

#[derive(Default)]
pub struct WriteOpts<'a> {
    /// None: guessed from the file name
    pub content_type: Option<String>,
    /// keep the headers and metadata of the file being replaced (editor saves)
    pub preserve_meta: bool,
    pub precondition: Precondition,
    /// None: the backend picks
    pub part_size: Option<u64>,
    /// 0: the transfer settings say how many
    pub parts_in_flight: usize,
    pub resume: Option<ResumeState>,
    /// called as each part completes, so a job can save it for resuming
    pub on_part: Option<&'a (dyn Fn(PartRecord) + Send + Sync)>,
    /// modification time to set where the store keeps one (local disk, SFTP), in ms
    pub modified: Option<i64>,
}

pub enum WriteOutcome {
    Done(Entry),
    Cancelled,
    /// the precondition failed; what is there now, when known
    Conflict(Option<Entry>),
}

// ---------------------------------------------------------------- other results

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub key: String,
    /// None: removed
    pub entry: Option<Entry>,
    pub id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangeBatch {
    pub changes: Vec<Change>,
    pub cursor: String,
    pub has_more: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub used: u64,
    pub total: Option<u64>,
}

// ---------------------------------------------------------------- capabilities

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RootsMode {
    /// many roots the user can pick from (S3 buckets)
    Buckets,
    /// one root: the UI skips the root level
    Single,
    /// a few named roots (cloud drives, the folders of this computer)
    Drives,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FolderMode {
    /// folders are key prefixes: empty ones need a marker and vanish without one
    Prefix,
    Real,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RenameMode {
    Native,
    /// a rename copies everything and deletes the originals (slow for big folders)
    CopyDelete,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ServerCopy {
    None,
    SameRoot,
    CrossRoot,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ShareMode {
    Presign,
    Link,
    None,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamingMode {
    /// media plays from a presigned URL
    Presign,
    /// media plays through the app's `media://` scheme
    Proxy,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CondWrite {
    IfMatch,
    /// checked by reading first (not atomic)
    Compare,
    Rev,
    None,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HashKind {
    Md5,
    Sha1,
    Sha256,
    Quickxor,
    Dropbox,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThumbMode {
    #[serde(rename = "local")]
    Local,
    #[serde(rename = "remote")]
    Remote,
    #[serde(rename = "local+remote")]
    LocalRemote,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MetaMode {
    /// S3 headers and user metadata (the Properties editor)
    S3,
    None,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SearchMode {
    Scan,
    Server,
}

/// What a connection can do; the UI hides what it can't (`connection_capabilities`).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub roots: RootsMode,
    pub create_root: bool,
    pub folders: FolderMode,
    pub rename: RenameMode,
    pub server_copy: ServerCopy,
    pub share: ShareMode,
    pub share_expiry: bool,
    pub streaming: StreamingMode,
    pub range_read: bool,
    pub conditional_write: CondWrite,
    pub hashes: Vec<HashKind>,
    pub thumbnails: ThumbMode,
    pub metadata: MetaMode,
    pub tags: bool,
    pub storage_class: bool,
    /// deleting moves things to a trash the user can restore from
    pub trash: bool,
    pub versions: bool,
    pub search: SearchMode,
    pub changes: bool,
    pub multipart: bool,
    pub max_object_size: Option<u64>,
    /// iOS background URLSession uploads can work (needs presigned requests)
    pub background_upload: bool,
    /// files are real files on this device: `local_path` resolves them, and they can be opened
    /// and revealed directly
    pub local_paths: bool,
}

impl Default for Capabilities {
    /// A plain path-based store with one root (a starting point for new backends).
    fn default() -> Self {
        Self {
            roots: RootsMode::Single,
            create_root: false,
            folders: FolderMode::Real,
            rename: RenameMode::Native,
            server_copy: ServerCopy::None,
            share: ShareMode::None,
            share_expiry: false,
            streaming: StreamingMode::Proxy,
            range_read: false,
            conditional_write: CondWrite::None,
            hashes: vec![],
            thumbnails: ThumbMode::Local,
            metadata: MetaMode::None,
            tags: false,
            storage_class: false,
            trash: false,
            versions: false,
            search: SearchMode::Scan,
            changes: false,
            multipart: false,
            max_object_size: None,
            background_upload: false,
            local_paths: false,
        }
    }
}

// ---------------------------------------------------------------- errors

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrKind {
    NotFound,
    /// something is already there
    Exists,
    /// changed since it was read (a precondition failed)
    Conflict,
    Unsupported,
    /// the sign-in expired or was revoked: the connection needs Reconnect
    NeedsAuth,
    PermissionDenied,
    RateLimited,
    Network,
    Cancelled,
    TooLarge,
    /// SFTP: a server not seen before; the detail carries its key's fingerprint for the user to
    /// trust (see BACKENDS.md)
    UnknownHost,
    /// SFTP: the server's key isn't the one trusted earlier
    HostKeyChanged,
    /// FTPS / WebDAV: the server's TLS certificate didn't check out and none was trusted; the
    /// detail carries what the user checks before trusting it (see `certtrust`)
    UntrustedCert,
    /// FTPS / WebDAV: the certificate isn't the one trusted earlier
    CertChanged,
    Other,
}

/// An error as people read it: `message` is a plain sentence, `detail` the technical text the UI
/// keeps behind "Details". As a `String` it is "message\n\ndetail", like `state::sdk_err`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageError {
    pub kind: ErrKind,
    pub message: String,
    pub detail: Option<String>,
}

/// The text of a stopped operation; the UI shows it as "Cancelled", not as a failure.
pub const CANCELLED: &str = "Cancelled";

impl StorageError {
    pub fn new(kind: ErrKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), detail: None }
    }
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
    pub fn other(message: impl Into<String>) -> Self {
        Self::new(ErrKind::Other, message)
    }
    pub fn not_found() -> Self {
        Self::new(ErrKind::NotFound, "This file or folder isn't there any more. It may have been moved or deleted.")
    }
    pub fn unsupported() -> Self {
        Self::new(ErrKind::Unsupported, "This connection doesn't support that.")
    }
    pub fn cancelled() -> Self {
        Self::new(ErrKind::Cancelled, CANCELLED)
    }
    pub fn too_large() -> Self {
        Self::new(ErrKind::TooLarge, "This file is too large to preview.")
    }
    pub fn exists() -> Self {
        Self::new(ErrKind::Exists, "Something with this name is already there.")
    }
    pub fn conflict() -> Self {
        Self::new(ErrKind::Conflict, "This file changed since it was opened.")
    }
    pub fn is_cancelled(&self) -> bool {
        self.kind == ErrKind::Cancelled
    }
}

pub fn unsupported<T>() -> SResult<T> {
    Err(StorageError::unsupported())
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(d) => write!(f, "{}\n\n{d}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<StorageError> for String {
    fn from(e: StorageError) -> Self {
        e.to_string()
    }
}

/// The S3 code reports errors as strings ("sentence\n\ndetails"); read one back.
impl From<String> for StorageError {
    fn from(s: String) -> Self {
        if s == CANCELLED {
            return Self::cancelled();
        }
        let kind = if s.contains("NoSuchKey") || s.contains("NoSuchBucket") || s.contains("status: 404") {
            ErrKind::NotFound
        } else if s.contains("AccessDenied") || s.contains("status: 403") {
            ErrKind::PermissionDenied
        } else if s.contains("SlowDown") || s.contains("status: 429") {
            ErrKind::RateLimited
        } else {
            ErrKind::Other
        };
        match s.split_once("\n\n") {
            Some((say, detail)) => Self { kind, message: say.to_string(), detail: Some(detail.to_string()) },
            None => Self { kind, message: s, detail: None },
        }
    }
}

impl From<io::Error> for StorageError {
    fn from(e: io::Error) -> Self {
        use io::ErrorKind as K;
        let (kind, say) = match e.kind() {
            K::NotFound => (ErrKind::NotFound, "This file or folder isn't there any more. It may have been moved or deleted."),
            K::PermissionDenied => (
                ErrKind::PermissionDenied,
                if cfg!(target_os = "macos") {
                    "Kybl isn't allowed to open this. Check the file's permissions, or allow Kybl under System Settings › Privacy & Security › Files and Folders."
                } else {
                    "Kybl isn't allowed to open this. Check the file's permissions."
                },
            ),
            K::AlreadyExists => (ErrKind::Exists, "Something with this name is already there."),
            K::StorageFull => (ErrKind::Other, "The disk is full."),
            K::ReadOnlyFilesystem => (ErrKind::PermissionDenied, "This disk is read-only."),
            K::DirectoryNotEmpty => (ErrKind::Other, "The folder isn't empty."),
            K::TimedOut => (ErrKind::Network, "The server didn't answer in time. Check your internet connection."),
            K::ConnectionRefused | K::ConnectionReset | K::ConnectionAborted | K::BrokenPipe => {
                (ErrKind::Network, "The connection to the server dropped. Try again.")
            }
            _ => return Self::other(e.to_string()),
        };
        Self::new(kind, say).with_detail(e.to_string())
    }
}

// ---------------------------------------------------------------- the trait

/// One connection. Paths are keys inside a root, with `/` separators; folders end with `/`.
/// Every method may be called concurrently.
#[async_trait::async_trait]
pub trait Storage: Send + Sync + 'static {
    fn kind(&self) -> ConnKind;
    fn caps(&self) -> &Capabilities;

    async fn roots(&self) -> SResult<Vec<RootInfo>>;
    async fn create_root(&self, _name: &str) -> SResult<()> {
        unsupported()
    }

    /// One page of the folder `dir` ("" for the top, else ending with `/`).
    async fn list(&self, root: &str, dir: &str, token: Option<String>) -> SResult<Page>;

    /// Everything below `dir`, however deep, a batch at a time. Folders come as entries whose key
    /// ends with `/` where the store has them (real folders always; prefix stores only marker
    /// objects), before what is inside them. The default walks folder by folder with [`list`].
    ///
    /// [`list`]: Storage::list
    fn walk<'a>(&'a self, root: &'a str, dir: &'a str) -> BoxStream<'a, SResult<Vec<Entry>>> {
        walk_by_listing(self, root, dir)
    }

    /// The file or folder (`path` ending with `/`) at `path`; None when nothing is there.
    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>>;

    /// `range` in bytes (end exclusive); `if_match` fails with Conflict when the file changed.
    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream>;

    async fn write(
        &self,
        root: &str,
        path: &str,
        src: WriteSource,
        opts: WriteOpts<'_>,
        progress: Progress<'_>,
        cancel: &Arc<AtomicBool>,
    ) -> SResult<WriteOutcome>;

    /// Creates the folder `dir` (ending with `/`) and any missing parents.
    async fn mkdir(&self, root: &str, dir: &str) -> SResult<()>;

    /// Deletes `files` and the folders `dirs` with everything inside them. Answers (done, total)
    /// in files (a folder counts as one where the store removes it in one go); `on_progress` gets
    /// the same as it goes. Stops between batches when `cancel` is set (error Cancelled).
    async fn delete(
        &self,
        root: &str,
        files: &[String],
        dirs: &[String],
        cancel: &AtomicBool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> SResult<(u64, u64)>;

    /// Server-side copy, without the bytes passing through here (see `caps().server_copy`).
    async fn copy(&self, _from: &Loc, _to: &Loc, _is_dir: bool) -> SResult<()> {
        unsupported()
    }

    /// Moves or renames, natively or by copy and delete (see `caps().rename`).
    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()>;

    async fn share_link(&self, _loc: &Loc, _ttl: Option<Duration>) -> SResult<String> {
        unsupported()
    }

    /// A thumbnail the provider makes itself (JPEG or PNG bytes); None to make one locally.
    async fn thumbnail(&self, _loc: &Loc, _e: &Entry) -> SResult<Option<Bytes>> {
        Ok(None)
    }

    async fn changes(&self, _root: &str, _cursor: Option<String>) -> SResult<ChangeBatch> {
        unsupported()
    }

    async fn quota(&self) -> SResult<Option<Quota>> {
        Ok(None)
    }

    /// The real file behind a path, for stores that are this device's own disk.
    fn local_path(&self, _root: &str, _path: &str) -> Option<PathBuf> {
        None
    }

    fn as_s3(&self) -> Option<&s3::S3Backend> {
        None
    }

    /// Where this connection's data lives (e.g. an S3 endpoint), so two connections saved for the
    /// same place are known to be the same storage. None when unknown.
    fn place_id(&self) -> Option<String> {
        None
    }
}

/// Names that differ only in letter case are the same file here: this device's disk on macOS,
/// iOS and Windows (their usual disks), and OneDrive, Dropbox and Box. Google Drive keeps both.
pub fn case_insensitive(kind: ConnKind) -> bool {
    let local_insensitive = cfg!(any(target_os = "macos", target_os = "ios", target_os = "windows"));
    matches!(kind, ConnKind::Onedrive | ConnKind::Dropbox | ConnKind::BoxCom) || (kind == ConnKind::Local && local_insensitive)
}

/// A path as the store tells files apart: lowercased where case doesn't count, and on Windows
/// without the trailing dots and spaces it drops from every name.
pub fn fold_path(kind: ConnKind, path: &str) -> String {
    if !case_insensitive(kind) {
        return path.to_string();
    }
    let lower = path.to_lowercase();
    if kind == ConnKind::Local && cfg!(windows) {
        let dir = lower.ends_with('/');
        let mut out = lower.trim_end_matches('/').split('/').map(|p| p.trim_end_matches(['.', ' '])).collect::<Vec<_>>().join("/");
        if dir {
            out.push('/');
        }
        return out;
    }
    lower
}

/// [`Storage::walk`] for stores that can only list one folder at a time.
pub fn walk_by_listing<'a, S: Storage + ?Sized>(s: &'a S, root: &'a str, dir: &'a str) -> BoxStream<'a, SResult<Vec<Entry>>> {
    struct St {
        dirs: Vec<String>,
        current: Option<(String, Option<String>)>,
        failed: bool,
    }
    let start = St { dirs: vec![dir.to_string()], current: None, failed: false };
    Box::pin(futures_util::stream::unfold(start, move |mut st| async move {
        if st.failed {
            return None;
        }
        let (d, token) = match st.current.take() {
            Some(c) => c,
            None => (st.dirs.pop()?, None),
        };
        match s.list(root, &d, token).await {
            Ok(page) => {
                if let Some(next) = page.next_token {
                    st.current = Some((d, Some(next)));
                }
                let mut batch: Vec<Entry> = page.folders.iter().map(|f| Entry { key: f.clone(), ..Default::default() }).collect();
                // depth first, in name order
                st.dirs.extend(page.folders.into_iter().rev());
                batch.extend(page.objects);
                Some((Ok(batch), st))
            }
            Err(e) => {
                st.failed = true;
                Some((Err(e), st))
            }
        }
    }))
}

// ---------------------------------------------------------------- dispatch

/// What a command works with: the S3 client (the existing code path, unchanged) or another
/// backend (the generic code in [`generic_cmds`]).
#[derive(Clone)]
pub enum Conn {
    S3(aws_sdk_s3::Client),
    Other(Arc<dyn Storage>),
}

/// The prelude of every browse command:
///
/// ```ignore
/// let client = match storage::connect(&app, &state, &profile_id).await? {
///     Conn::S3(c) => c,
///     Conn::Other(s) => return generic_cmds::list_objects(&*s, &bucket, &prefix, token).await,
/// };
/// ```
pub async fn connect<R: Runtime>(app: &AppHandle<R>, state: &AppState, profile_id: &str) -> Result<Conn, String> {
    // a live S3 client: the same fast path `client_for` always took
    if let Some(c) = state.clients.lock().await.get(profile_id) {
        return Ok(Conn::S3(c.clone()));
    }
    let s = registry::open(app, state, profile_id).await?;
    Ok(match s.as_s3() {
        Some(b) => Conn::S3(b.client().clone()),
        None => Conn::Other(s),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_read_old_and_unknown_profiles() {
        assert_eq!(serde_json::from_str::<ConnKind>("\"sftp\"").unwrap(), ConnKind::Sftp);
        assert_eq!(serde_json::from_str::<ConnKind>("\"box\"").unwrap(), ConnKind::BoxCom);
        assert_eq!(serde_json::from_str::<ConnKind>("\"teleport\"").unwrap(), ConnKind::Unknown);
        assert_eq!(serde_json::to_string(&ConnKind::BoxCom).unwrap(), "\"box\"");
        assert_eq!(serde_json::to_string(&ConnKind::S3).unwrap(), "\"s3\"");
    }

    #[test]
    fn an_entry_serializes_like_the_s3_listing() {
        let e = Entry { key: "a.txt".into(), size: 3, modified: Some(1), etag: Some("x".into()), ..Default::default() };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"key":"a.txt","size":3,"modified":1,"etag":"x","storageClass":null}"#
        );
        let e = Entry { id: Some("i".into()), hashes: Hashes { md5: Some("m".into()), ..Default::default() }, ..e };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["id"], "i");
        assert_eq!(v["hashes"]["md5"], "m");
    }

    #[test]
    fn capabilities_use_the_frontend_names() {
        let v = serde_json::to_value(Capabilities { thumbnails: ThumbMode::LocalRemote, rename: RenameMode::CopyDelete, ..Default::default() }).unwrap();
        assert_eq!(v["thumbnails"], "local+remote");
        assert_eq!(v["rename"], "copy-delete");
        assert_eq!(v["serverCopy"], "none");
        assert_eq!(v["conditionalWrite"], "none");
        assert_eq!(v["localPaths"], false);
        assert_eq!(v["maxObjectSize"], serde_json::Value::Null);
    }

    #[test]
    fn errors_read_back_from_s3_strings() {
        let e = StorageError::from("Access denied.\n\nAccessDenied: nope".to_string());
        assert_eq!(e.kind, ErrKind::PermissionDenied);
        assert_eq!(e.message, "Access denied.");
        assert_eq!(String::from(e), "Access denied.\n\nAccessDenied: nope");
        assert!(StorageError::from(CANCELLED.to_string()).is_cancelled());
        assert_eq!(String::from(StorageError::cancelled()), CANCELLED);
    }
}
