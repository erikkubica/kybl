//! What a backup is (a set: where from, where to, how files are named) and what the phone hands
//! over about each photo, video or file.

use serde::{Deserialize, Serialize};

/// Where a set's files come from.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BackupSource {
    /// The phone's photos and videos (MediaStore on Android, the Photos library on iOS).
    CameraRoll,
    /// An Android folder picked with the system picker (a persisted SAF tree URI).
    #[serde(rename_all = "camelCase")]
    AndroidTree { uri: String, label: String },
    /// An iOS Files-app folder (a security-scoped bookmark, base64).
    #[serde(rename_all = "camelCase")]
    IosBookmark { bookmark: String, label: String },
}

impl BackupSource {
    pub fn is_camera_roll(&self) -> bool {
        matches!(self, BackupSource::CameraRoll)
    }
}

/// iOS: what happens to HEIC photos.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Heic {
    #[default]
    Keep,
    ConvertJpeg,
}

/// iOS: which version of an edited photo or video goes up.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Edited {
    /// what the Photos app shows (the edit when there is one)
    #[default]
    Current,
    Original,
    /// the original and, next to it, the edit ("IMG_E0001.HEIC")
    Both,
}

/// One backup: a source, a destination folder, and how files are named there.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupSet {
    pub id: String,
    pub source: BackupSource,
    pub profile_id: String,
    pub root: String,
    /// the folder inside the root, "" or ending with "/" ("Camera/")
    pub dest_prefix: String,
    /// how the destination is called, for the screens ("Hetzner / photos / Camera")
    pub dest_label: String,
    /// "{yyyy}/{MM}/{name}"; see `naming`
    pub template: String,
    pub include_videos: bool,
    pub live_photo_video: bool,
    pub heic: Heic,
    pub edited: Edited,
    pub wifi_only: bool,
    pub charging_only: bool,
    /// "Only new from now": items made before this time (ms) are left out
    pub since: Option<i64>,
    /// false: paused (no runs start, a running one stops)
    pub enabled: bool,
    pub created: i64,
}

impl Default for BackupSet {
    fn default() -> Self {
        Self {
            id: String::new(),
            source: BackupSource::CameraRoll,
            profile_id: String::new(),
            root: String::new(),
            dest_prefix: String::new(),
            dest_label: String::new(),
            template: crate::backup::naming::DEFAULT_TEMPLATE.to_string(),
            include_videos: true,
            live_photo_video: true,
            heic: Heic::Keep,
            edited: Edited::Current,
            wifi_only: true,
            charging_only: false,
            since: None,
            enabled: true,
            created: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    #[default]
    Photo,
    Video,
    /// the video half of a Live Photo
    LivePhotoVideo,
    File,
}

impl ItemKind {
    /// For the `{type}` token.
    pub fn folder_name(self) -> &'static str {
        match self {
            ItemKind::Photo => "Photos",
            ItemKind::Video | ItemKind::LivePhotoVideo => "Videos",
            ItemKind::File => "Files",
        }
    }
}

/// What the phone says about one thing to back up (`offer`).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    /// stable id on the phone: "PHAsset localIdentifier#res", "volume:_ID", a SAF document id
    pub source_id: String,
    pub kind: ItemKind,
    /// the file name to use ("IMG_0001.HEIC")
    pub name: String,
    /// bytes; 0 when the phone doesn't know before exporting
    pub size: i64,
    /// when it was taken or made (ms)
    pub created: Option<i64>,
    /// when it last changed (ms)
    pub modified: Option<i64>,
    pub mime: Option<String>,
    pub album: Option<String>,
    /// folder sets: the path inside the picked folder ("Sent/IMG-1.jpg")
    pub rel_path: Option<String>,
    /// minutes east of UTC where it was taken, for the date folders
    pub tz_offset: Option<i32>,
    /// what changes when the content does, when the phone knows better than modified + size
    pub version: Option<String>,
}

impl Item {
    /// The index entry stays valid while this is unchanged.
    pub fn version_key(&self) -> String {
        match &self.version {
            Some(v) if !v.is_empty() => v.clone(),
            _ => format!("{}:{}", self.modified.unwrap_or(0), self.size),
        }
    }
}

/// An item that needs uploading (`offer`, `pending`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub source_id: String,
    pub remote_path: String,
    pub name: String,
    pub kind: ItemKind,
    pub size: i64,
}

/// One that couldn't be backed up, for the failures list.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub source_id: String,
    pub name: String,
    pub error: String,
    pub at: i64,
    pub attempts: i64,
}

/// What a set is doing right now.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
    #[default]
    Idle,
    Running,
    /// "Wi-Fi only" and the phone is on mobile data
    WaitingWifi,
    /// the network dropped or the server is busy: the next run carries on
    WaitingNetwork,
    /// the connection's sign-in expired
    NeedsAuth,
    Paused,
}

/// The file going up now.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    pub name: String,
    pub done: u64,
    pub total: u64,
}

/// A set and how it is doing: the `backup-status` event and `backup_list`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetStatus {
    pub set: BackupSet,
    pub state: RunState,
    pub backed_up: u64,
    pub pending: u64,
    pub failed: u64,
    /// when the last run ended (ms)
    pub last_run: Option<i64>,
    /// why the last run stopped early, in plain words
    pub last_error: Option<String>,
    pub current: Option<Current>,
    /// this run: done of total
    pub run_done: u64,
    pub run_total: u64,
}

/// How an upload went, for the phone's loop (`upload`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    /// done | adopted | skipped | failed | cancelled | waitingWifi | retryLater | needsAuth
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl UploadResult {
    pub fn of(status: &str) -> Self {
        Self { status: status.into(), remote_path: None, error: None }
    }
    pub fn at(status: &str, path: &str) -> Self {
        Self { status: status.into(), remote_path: Some(path.into()), error: None }
    }
    pub fn err(status: &str, e: impl Into<String>) -> Self {
        Self { status: status.into(), remote_path: None, error: Some(e.into()) }
    }
}
