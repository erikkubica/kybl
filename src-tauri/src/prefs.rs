//! App-level preferences the native side needs (the rest live in the web view's storage).

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::state::err;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default = "yes")]
    close_to_tray: bool,
}

fn yes() -> bool {
    true
}

impl Default for Stored {
    fn default() -> Self {
        Self { close_to_tray: true }
    }
}

pub struct Prefs {
    pub close_to_tray: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefs {
    close_to_tray: bool,
    launch_at_login: bool,
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("app.json"))
}

pub fn load(app: &AppHandle) -> Prefs {
    let s: Stored = path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    Prefs { close_to_tray: AtomicBool::new(s.close_to_tray) }
}

#[tauri::command]
pub fn get_app_prefs(app: AppHandle, prefs: State<'_, Prefs>) -> AppPrefs {
    AppPrefs {
        close_to_tray: prefs.close_to_tray.load(Ordering::Relaxed),
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
pub fn set_app_prefs(
    app: AppHandle,
    prefs: State<'_, Prefs>,
    close_to_tray: Option<bool>,
    launch_at_login: Option<bool>,
) -> Result<AppPrefs, String> {
    if let Some(v) = close_to_tray {
        prefs.close_to_tray.store(v, Ordering::Relaxed);
        let p = path(&app).ok_or("No config folder")?;
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        std::fs::write(p, serde_json::to_vec(&Stored { close_to_tray: v }).map_err(err)?).map_err(err)?;
    }
    if let Some(v) = launch_at_login {
        let al = app.autolaunch();
        if v { al.enable() } else { al.disable() }.map_err(|e| format!("Could not change the login item: {e}"))?;
    }
    Ok(get_app_prefs(app.clone(), prefs))
}
