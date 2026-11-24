//! Developer touches for folders that are code: git status marks and the branch for this
//! computer's folders, and searching inside files (this computer and SFTP servers). Both use
//! the user's own tools (git, ripgrep, grep) where installed; nothing is bundled.

pub mod content;
pub mod git;
pub mod hits;
pub mod tools;

use std::sync::{atomic::AtomicBool, Arc};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;
use crate::storage::{registry, ConnKind};
use content::{ContentResult, Query};
use hits::Hit;

/// The git status of a folder of this computer; None when it isn't in a git work tree, git isn't
/// installed, or the connection isn't this computer.
#[tauri::command]
pub async fn git_status(app: AppHandle, state: State<'_, AppState>, profile_id: String, bucket: String, prefix: String, force: Option<bool>) -> Result<Option<git::GitInfo>, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    let Some(dir) = s.local_path(&bucket, &prefix) else { return Ok(None) };
    Ok(tauri::async_runtime::spawn_blocking(move || git::status_of(&dir, force.unwrap_or(false))).await.ok().flatten())
}

/// The newest commit of the repository a folder of this computer is in; None when it isn't in one.
#[tauri::command]
pub async fn git_last_commit(app: AppHandle, state: State<'_, AppState>, profile_id: String, bucket: String, prefix: String) -> Result<Option<git::LastCommit>, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    let Some(dir) = s.local_path(&bucket, &prefix) else { return Ok(None) };
    Ok(tauri::async_runtime::spawn_blocking(move || git::last_commit_of(&dir)).await.ok().flatten())
}

/// How much of a cloud drive's storage is used, for the folder info panel; None when the drive
/// doesn't say (or isn't one). One cheap request, asked only while the panel is open.
#[tauri::command]
pub async fn storage_quota(app: AppHandle, state: State<'_, AppState>, profile_id: String) -> Result<Option<crate::storage::Quota>, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    Ok(s.quota().await.ok().flatten())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ContentProgress {
    op_id: String,
    /// files found since the last event
    hits: Vec<Hit>,
    files: usize,
    matches: u64,
}

/// Searches inside the files below `prefix`: this computer's folders and SFTP servers. Files
/// found stream in as `content-search-progress` events; `cancel_transfer(op_id)` stops it.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn content_search(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    prefix: String,
    query: String,
    case_sensitive: bool,
    regex: bool,
    hidden: bool,
    op_id: String,
) -> Result<ContentResult, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    let q = Query { text: query, case_sensitive, regex, hidden };
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op_id.clone(), flag.clone());
    let emitter = {
        let (app, op_id) = (app.clone(), op_id.clone());
        move |hits: Vec<Hit>, files: usize, matches: u64| {
            let _ = app.emit("content-search-progress", ContentProgress { op_id: op_id.clone(), hits, files, matches });
        }
    };
    let r = if let Some(dir) = s.local_path(&bucket, &prefix) {
        let f = flag.clone();
        tauri::async_runtime::spawn_blocking(move || content::search_local(&dir, &prefix, &q, &f, emitter)).await.map_err(|e| e.to_string()).and_then(|r| r)
    } else if s.kind() == ConnKind::Sftp {
        // a connection of its own for the command (as custom actions run theirs)
        match registry::open_sftp(&app, &state, &profile_id).await {
            Ok(b) => {
                let r = content::search_sftp(&b, &prefix, &q, &flag, emitter).await;
                b.disconnect().await;
                r
            }
            Err(e) => Err(e),
        }
    } else {
        Ok(ContentResult { unavailable: Some("Searching inside files works on this computer and on SFTP servers.".into()), ..Default::default() })
    };
    state.cancels.lock().await.remove(&op_id);
    r
}
