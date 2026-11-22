//! Phone backup (WP-C): the camera roll and picked folders, backed up to any connection.
//!
//! Rust owns dedupe, naming, uploads and the index (`backup.db`); the native side owns
//! enumeration, permissions, scheduling and exporting assets.
//!
//! - Every run happens in the native worker, also "Back up now", so there is one code path:
//!   Android `BackupWorker.kt` (WorkManager: every 15 minutes, on new photos, and on demand),
//!   iOS `BackupRunner.swift` (while the app is open, and `BGProcessingTask` overnight while
//!   charging). The worker calls the entry points in [`headless`], which need no `AppHandle`:
//!   WorkManager wakes the process without an Activity, so there may be no Tauri app at all.
//!   When the app is up, connections come from its registry and status reaches the page as
//!   `backup-status` events ([`live`]).
//! - Dedupe: an item is uploaded once per version (`index`); on a first run against a folder
//!   that already holds the photos, a file with the same name and size counts as backed up.
//!   A different file with the name gets "IMG_0001 (2).HEIC" ([`naming`]).
//! - Deletes never propagate: nothing here deletes anything on the destination.
//! - The page's commands below manage sets and ask the native plugin (`BackupPlugin.kt`,
//!   `KyblBackupPlugin.swift`) for permissions, folder picking, scheduling and "Back up now".

mod engine;
pub mod headless;
mod index;
mod live;
pub mod naming;
pub mod types;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Wry};

use engine::Core;
pub use live::Paths;
use live::LiveHost;
use types::*;

static CORE: Mutex<Option<Arc<Core>>> = Mutex::new(None);

/// The engine, opened on first use from whichever side gets there first (the app's setup or a
/// background worker); both then share it.
pub fn core_at(paths: Paths) -> Result<Arc<Core>, String> {
    let mut g = CORE.lock().unwrap();
    if let Some(c) = g.as_ref() {
        return Ok(c.clone());
    }
    let conn = crate::db::open(&paths.data.join("backup.db"), index::MIGRATIONS)?;
    let core = Arc::new(Core::new(conn, Arc::new(LiveHost::new(paths))));
    *g = Some(core.clone());
    Ok(core)
}

pub fn core() -> Result<Arc<Core>, String> {
    CORE.lock().unwrap().clone().ok_or_else(|| "Backup isn't ready yet. Try again in a moment.".into())
}

/// App start-up: opens backup.db where Tauri keeps app data.
pub fn setup(app: &AppHandle) {
    let (Ok(config), Ok(data)) = (app.path().app_config_dir(), app.path().app_data_dir()) else { return };
    if let Err(e) = core_at(Paths { config, data }) {
        eprintln!("backup.db: {e}");
    }
}

// ---------------------------------------------------------------- the native plugin

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_kyblbackup);

#[cfg(mobile)]
struct Native(tauri::plugin::PluginHandle<Wry>);

pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("kyblbackup")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _app.manage(Native(_api.register_android_plugin("app.kybl.mobile", "BackupPlugin")?));
            #[cfg(target_os = "ios")]
            _app.manage(Native(_api.register_ios_plugin(init_plugin_kyblbackup)?));
            Ok(())
        })
        .build()
}

/// Runs a command of the native plugin (permissions, the folder picker, scheduling).
#[cfg(mobile)]
async fn native(app: &AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    let Some(n) = app.try_state::<Native>() else {
        return Err("Kybl isn't ready yet. Try again in a moment.".into());
    };
    n.0.run_mobile_plugin_async(cmd, args).await.map_err(|e| match e {
        tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r) => r.message.unwrap_or_else(|| "Something went wrong.".into()),
        e => e.to_string(),
    })
}

#[cfg(not(mobile))]
async fn native(_app: &AppHandle, _cmd: &str, _args: Value) -> Result<Value, String> {
    Err("Phone backup runs on phones.".into())
}

/// The sets changed: the native side schedules its work to match (it reads them back itself).
async fn reschedule(app: &AppHandle) {
    if cfg!(mobile)
        && let Err(e) = native(app, "schedule", json!({})).await
    {
        eprintln!("backup schedule: {e}");
    }
}

// ---------------------------------------------------------------- commands

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// "android" | "ios" | "desktop"
    platform: &'static str,
    sets: Vec<SetStatus>,
}

const PLATFORM: &str = if cfg!(target_os = "android") {
    "android"
} else if cfg!(target_os = "ios") {
    "ios"
} else {
    "desktop"
};

#[tauri::command]
pub async fn backup_overview() -> Result<Overview, String> {
    Ok(Overview { platform: PLATFORM, sets: core()?.statuses()? })
}

#[tauri::command]
pub async fn backup_save(app: AppHandle, set: BackupSet) -> Result<SetStatus, String> {
    let core = core()?;
    let saved = core.save_set(set)?;
    reschedule(&app).await;
    core.status(&saved.id)
}

#[tauri::command]
pub async fn backup_delete(app: AppHandle, id: String) -> Result<(), String> {
    core()?.delete_set(&id)?;
    reschedule(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn backup_set_paused(app: AppHandle, id: String, paused: bool) -> Result<SetStatus, String> {
    let core = core()?;
    core.set_enabled(&id, !paused)?;
    reschedule(&app).await;
    core.status(&id)
}

/// "Back up now": the native worker runs the set (or every set) as soon as it can.
#[tauri::command]
pub async fn backup_run_now(app: AppHandle, id: Option<String>) -> Result<(), String> {
    native(&app, "runNow", json!({ "setId": id })).await.map(|_| ())
}

#[tauri::command]
pub async fn backup_cancel(id: Option<String>) -> Result<(), String> {
    core()?.cancel(id.as_deref());
    Ok(())
}

#[tauri::command]
pub async fn backup_failures(id: String) -> Result<Vec<Failure>, String> {
    core()?.failures(&id)
}

/// "Try again": the failed items go back in the queue and a run starts.
#[tauri::command]
pub async fn backup_retry(app: AppHandle, id: String) -> Result<usize, String> {
    let n = core()?.retry_failed(&id)?;
    if cfg!(mobile) {
        native(&app, "runNow", json!({ "setId": id })).await?;
    }
    Ok(n)
}

/// Photo library access: `{photos: "granted"|"limited"|"denied"|"notDetermined"|"unsupported", ...}`.
#[tauri::command]
pub async fn backup_permission(app: AppHandle) -> Result<Value, String> {
    if !cfg!(mobile) {
        return Ok(json!({ "photos": "unsupported" }));
    }
    native(&app, "permission", json!({})).await
}

#[tauri::command]
pub async fn backup_request_permission(app: AppHandle) -> Result<Value, String> {
    if !cfg!(mobile) {
        return Ok(json!({ "photos": "unsupported" }));
    }
    native(&app, "requestPermission", json!({})).await
}

/// iOS limited access: choose more photos. Android partial access: ask again. Else the app's
/// system settings.
#[tauri::command]
pub async fn backup_manage_access(app: AppHandle) -> Result<Value, String> {
    native(&app, "manageAccess", json!({})).await
}

/// A folder to back up (Android's folder picker, iOS Files). None when the picker was closed.
#[tauri::command]
pub async fn backup_pick_folder(app: AppHandle) -> Result<Option<BackupSource>, String> {
    let v = native(&app, "pickFolder", json!({})).await?;
    if v.is_null() || v.get("type").is_none() {
        return Ok(None);
    }
    serde_json::from_value(v).map(Some).map_err(|e| e.to_string())
}
