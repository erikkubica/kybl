//! What the frontend sends and receives (see the WP-B1 section of `src/core/api.ts`).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum JobMode {
    #[default]
    Copy,
    /// copy, then delete each original once its copy is verified
    Move,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelItem {
    /// a file, or a folder ending with `/`; "" (a folder) is the whole root
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub profile_id: String,
    pub root: String,
    pub items: Vec<SelItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Dest {
    pub profile_id: String,
    pub root: String,
    /// "" for the top of the root, else ending with `/`
    #[serde(default)]
    pub dir: String,
}

/// What to do with a file that is already at the destination.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    /// skip it when it is the same file (size, and hash or time); replace it otherwise
    #[default]
    SkipIdentical,
    Skip,
    Overwrite,
    /// copy next to it as "name (1).ext" (unless it is the same file)
    KeepBoth,
    /// replace it only when the source changed more recently
    NewerWins,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Verify {
    Size,
    /// sizes, plus content hashes wherever both sides can give one
    #[default]
    Hash,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub mode: JobMode,
    pub src: Source,
    pub dst: Dest,
    #[serde(default)]
    pub conflict: Conflict,
    #[serde(default)]
    pub verify: Verify,
    #[serde(default)]
    pub preserve_mtime: bool,
    #[serde(default)]
    pub ignore: Vec<String>,
    #[serde(default)]
    pub title: String,
    /// "Mirror": exactly these files, then the deletions (see `mirror.rs`). Planned when the job
    /// is made; the lists aren't kept in the stored spec, only their counts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirror: Option<Mirror>,
}

/// A mirror's plan, worked out (and shown) by the page before the job starts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    /// files to copy, and folders to make (ending with `/`), relative to the source folder and
    /// to `dst.dir` alike
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub copy: Vec<MirrorFile>,
    /// files, and folders (ending with `/`), to delete at the destination, relative to `dst.dir`
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delete: Vec<String>,
    #[serde(default)]
    pub copies: u64,
    #[serde(default)]
    pub deletes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MirrorFile {
    pub rel: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub mtime: Option<i64>,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(default)]
    pub md5: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Planning,
    Running,
    Paused,
    /// offline, or on mobile data with "Wi-Fi only" on: carries on by itself
    WaitingNetwork,
    /// the connection's sign-in expired: Reconnect, then Resume
    NeedsAuth,
    Done,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            JobState::Planning => "planning",
            JobState::Running => "running",
            JobState::Paused => "paused",
            JobState::WaitingNetwork => "waitingNetwork",
            JobState::NeedsAuth => "needsAuth",
            JobState::Done => "done",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> JobState {
        match s {
            "planning" => JobState::Planning,
            "running" => JobState::Running,
            "paused" => JobState::Paused,
            "waitingNetwork" => JobState::WaitingNetwork,
            "needsAuth" => JobState::NeedsAuth,
            "done" => JobState::Done,
            "cancelled" => JobState::Cancelled,
            _ => JobState::Failed,
        }
    }

    /// The job still has work it will do by itself (resumed at startup).
    pub fn is_live(self) -> bool {
        matches!(self, JobState::Planning | JobState::Running | JobState::WaitingNetwork)
    }

    pub fn is_finished(self) -> bool {
        matches!(self, JobState::Done | JobState::Failed | JobState::Cancelled)
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Planning,
    Copying,
    Deleting,
    Finished,
}

/// Event `job-progress`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub id: String,
    pub state: JobState,
    pub phase: Phase,
    pub files_done: u64,
    pub files_total: u64,
    pub files_failed: u64,
    pub files_skipped: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub rate_bps: u64,
    pub eta_secs: Option<u64>,
    pub current: Vec<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub id: String,
    pub title: String,
    pub spec: JobSpec,
    pub created: i64,
    pub updated: i64,
    pub progress: JobProgress,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub path: String,
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spec_reads_the_frontend_shape_with_defaults() {
        let s: JobSpec = serde_json::from_str(
            r#"{"mode":"move","src":{"profileId":"a","root":"r","items":[{"path":"x/","isDir":true}]},
                "dst":{"profileId":"local","root":"/tmp","dir":"in/"},"conflict":"keepBoth","verify":"size",
                "preserveMtime":true,"ignore":["*.tmp"]}"#,
        )
        .unwrap();
        assert_eq!(s.mode, JobMode::Move);
        assert_eq!(s.conflict, Conflict::KeepBoth);
        assert_eq!(s.verify, Verify::Size);
        assert!(s.id.is_empty() && s.title.is_empty());
        let minimal: JobSpec = serde_json::from_str(r#"{"src":{"profileId":"a","root":"r","items":[]},"dst":{"profileId":"b","root":"q"}}"#).unwrap();
        assert_eq!((minimal.mode, minimal.conflict, minimal.verify), (JobMode::Copy, Conflict::SkipIdentical, Verify::Hash));
    }

    #[test]
    fn states_round_trip_with_the_frontend_names() {
        for s in [JobState::Planning, JobState::Running, JobState::Paused, JobState::WaitingNetwork, JobState::NeedsAuth, JobState::Done, JobState::Failed, JobState::Cancelled] {
            assert_eq!(serde_json::to_string(&s).unwrap(), format!("\"{}\"", s.as_str()));
            assert_eq!(JobState::parse(s.as_str()), s);
        }
    }
}
