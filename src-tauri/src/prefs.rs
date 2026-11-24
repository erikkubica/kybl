//! App-level preferences the native side needs (the rest live in the web view's storage).
//! Kept in `app.json`; every save rewrites the whole file from what was there, so one setting
//! never wipes another.

#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
#[cfg(desktop)]
use tauri::State;
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;

use crate::{state::err, tuning::TransferPrefs};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default = "yes")]
    close_to_tray: bool,
    #[serde(default)]
    transfers: TransferPrefs,
}

fn yes() -> bool {
    true
}

impl Default for Stored {
    fn default() -> Self {
        Self { close_to_tray: true, transfers: TransferPrefs::default() }
    }
}

#[cfg(desktop)]
pub struct Prefs {
    pub close_to_tray: AtomicBool,
}

fn path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("app.json"))
}

fn read<R: Runtime>(app: &AppHandle<R>) -> Stored {
    path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

/// One change at a time: read, change and written back as one step, so two saves at once (the
/// settings screen and the transfer settings) never undo each other.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn update<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&mut Stored)) -> Result<(), String> {
    let p = path(app).ok_or("No config folder")?;
    let _one = WRITING.lock().unwrap();
    let mut s = read(app);
    f(&mut s);
    write_to(&p, &s)
}

fn write_to(p: &std::path::Path, s: &Stored) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    // written aside (a temporary name of its own) and swapped in, so a crash mid-write never
    // leaves a broken file
    crate::state::write_atomic(p, &serde_json::to_vec(s).map_err(err)?).map_err(err)
}

/// Reads the saved transfer settings and makes them live. Runs at startup on every platform.
pub fn load_transfers<R: Runtime>(app: &AppHandle<R>) {
    crate::tuning::apply(read(app).transfers);
}

pub fn save_transfers<R: Runtime>(app: &AppHandle<R>, t: TransferPrefs) -> Result<(), String> {
    update(app, |s| s.transfers = t)
}

#[cfg(desktop)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefs {
    close_to_tray: bool,
    launch_at_login: bool,
}

#[cfg(desktop)]
pub fn load(app: &AppHandle) -> Prefs {
    Prefs { close_to_tray: AtomicBool::new(read(app).close_to_tray) }
}

#[cfg(desktop)]
#[tauri::command]
pub fn get_app_prefs(app: AppHandle, prefs: State<'_, Prefs>) -> AppPrefs {
    AppPrefs {
        close_to_tray: prefs.close_to_tray.load(Ordering::Relaxed),
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_app_prefs(
    app: AppHandle,
    prefs: State<'_, Prefs>,
    close_to_tray: Option<bool>,
    launch_at_login: Option<bool>,
) -> Result<AppPrefs, String> {
    // saved first, live once saved: a failed save leaves the app as the file says (B5-6)
    if let Some(v) = close_to_tray {
        update(&app, |s| s.close_to_tray = v)?;
        prefs.close_to_tray.store(v, Ordering::Relaxed);
    }
    if let Some(v) = launch_at_login {
        let al = app.autolaunch();
        if v { al.enable() } else { al.disable() }.map_err(|e| format!("Could not change the login item: {e}"))?;
    }
    Ok(get_app_prefs(app.clone(), prefs))
}
