//! App-level preferences the native side needs (the rest live in the web view's storage).
//! Kept in `app.json`; every save rewrites the whole file from what was there, so one setting
//! never wipes another.

#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(desktop)]
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
#[cfg(desktop)]
use tauri::State;
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;

use crate::{state::err, transfer::tuning::TransferPrefs};
#[cfg(test)]
use crate::transfer::tuning::VerifyMode;

#[derive(Clone, PartialEq)]
struct Stored {
    close_to_tray: bool,
    transfers: TransferPrefs,
}

type Map = serde_json::Map<String, serde_json::Value>;

const CLOSE_TO_TRAY: &str = "closeToTray";
const TRANSFERS: &str = "transfers";

impl Stored {
    /// Each setting is read on its own, so a value this build can't read (a newer build's)
    /// falls back to its default without taking the others with it. An old file's shared speed
    /// cap moves into both directions here, so the first rewrite, whatever it changes, keeps it.
    fn from_map(m: &Map) -> Self {
        Self {
            close_to_tray: m.get(CLOSE_TO_TRAY).and_then(|v| v.as_bool()).unwrap_or(true),
            transfers: read_transfers(m.get(TRANSFERS)),
        }
    }

    /// `m` with the settings that differ from `before` replaced; every other key, including
    /// ones a newer build wrote and settings this build couldn't read, stays as it was.
    fn merged_into(&self, before: &Self, mut m: Map) -> Map {
        if self.close_to_tray != before.close_to_tray {
            m.insert(CLOSE_TO_TRAY.into(), self.close_to_tray.into());
        }
        if let Some(Ok(new)) = (self.transfers != before.transfers || m.get(TRANSFERS).is_some_and(|v| v.get("bandwidthLimitKbps").is_some()))
            .then(|| serde_json::to_value(self.transfers))
        {
            let old = serde_json::to_value(before.transfers).unwrap_or_default();
            if !m.get(TRANSFERS).is_some_and(|v| v.is_object()) {
                m.insert(TRANSFERS.into(), Map::new().into());
            }
            let t = m.get_mut(TRANSFERS).and_then(|v| v.as_object_mut()).expect("an object, set above");
            // an old file's shared cap moves into both directions, so the rewrite carries it over
            let migrate = t.remove("bandwidthLimitKbps").is_some();
            // only the fields that changed are written: a value this build couldn't read, or a
            // key a newer build added, stays as it was
            for (k, v) in new.as_object().into_iter().flatten() {
                let limit = k == "downloadLimitKbps" || k == "uploadLimitKbps";
                if old.get(k) != Some(v) || (migrate && limit) {
                    t.insert(k.clone(), v.clone());
                }
            }
        }
        m
    }
}

/// Each transfer setting is read on its own, so one value this build can't read (a newer
/// build's verify mode) falls back to its default without resetting the others.
fn read_transfers(v: Option<&serde_json::Value>) -> TransferPrefs {
    fn field<T: serde::de::DeserializeOwned>(o: &Map, k: &str) -> Option<T> {
        o.get(k).and_then(|v| serde_json::from_value(v.clone()).ok())
    }
    let Some(o) = v.and_then(|v| v.as_object()) else { return TransferPrefs::default().clamped() };
    let d = TransferPrefs::default();
    TransferPrefs {
        concurrency: field(o, "concurrency").unwrap_or(d.concurrency),
        part_concurrency: field(o, "partConcurrency").unwrap_or(d.part_concurrency),
        download_limit_kbps: field(o, "downloadLimitKbps").unwrap_or(d.download_limit_kbps),
        upload_limit_kbps: field(o, "uploadLimitKbps").unwrap_or(d.upload_limit_kbps),
        bandwidth_limit_kbps: field(o, "bandwidthLimitKbps").unwrap_or(d.bandwidth_limit_kbps),
        wifi_only: field(o, "wifiOnly").unwrap_or(d.wifi_only),
        verify: field(o, "verify").unwrap_or(d.verify),
    }
    .clamped()
}

#[cfg(desktop)]
pub struct Prefs {
    pub close_to_tray: AtomicBool,
}

fn path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("app.json"))
}

fn read<R: Runtime>(app: &AppHandle<R>) -> Stored {
    let map = path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|raw| serde_json::from_slice::<Map>(&raw).ok())
        .unwrap_or_default();
    Stored::from_map(&map)
}

/// One change at a time: read, change and written back as one step, so two saves at once (the
/// settings screen and the transfer settings) never undo each other.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn update<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&mut Stored)) -> Result<(), String> {
    let p = path(app).ok_or("No config folder")?;
    let _one = WRITING.lock().unwrap();
    // a file that isn't JSON is set aside before it is replaced
    let map = match crate::state::json_before_save(&p)? {
        Some(serde_json::Value::Object(m)) => m,
        _ => Map::new(),
    };
    let before = Stored::from_map(&map);
    let mut s = before.clone();
    f(&mut s);
    write_to(&p, &s.merged_into(&before, map))
}

fn write_to(p: &std::path::Path, s: &Map) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    // written aside (a temporary name of its own) and swapped in, so a crash mid-write never
    // leaves a broken file
    crate::state::write_atomic(p, &serde_json::to_vec(s).map_err(err)?).map_err(err)
}

/// Reads the saved transfer settings and makes them live. Runs at startup on every platform.
pub fn load_transfers<R: Runtime>(app: &AppHandle<R>) {
    crate::transfer::tuning::apply(read(app).transfers);
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: serde_json::Value) -> Map {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn an_old_shared_cap_survives_an_unrelated_save() {
        let m = map(json!({ "closeToTray": true, "transfers": { "bandwidthLimitKbps": 500 } }));
        let before = Stored::from_map(&m);
        assert_eq!((before.transfers.download_limit_kbps, before.transfers.upload_limit_kbps), (500, 500));
        let mut s = before.clone();
        s.close_to_tray = false;
        let out = s.merged_into(&before, m);
        let again = Stored::from_map(&out);
        assert!(!again.close_to_tray);
        assert_eq!((again.transfers.download_limit_kbps, again.transfers.upload_limit_kbps), (500, 500));
        assert!(out[TRANSFERS].get("bandwidthLimitKbps").is_none());
    }

    #[test]
    fn what_this_build_cannot_read_is_kept() {
        let m = map(json!({ "closeToTray": false, "transfers": { "verify": "someNewMode", "concurrency": 8 }, "newer": { "a": 1 } }));
        let before = Stored::from_map(&m);
        // the unreadable value falls back alone, the readable ones still read
        assert!(!before.close_to_tray);
        assert_eq!(before.transfers.concurrency, 8);
        assert_eq!(before.transfers.verify, VerifyMode::Off);
        let mut s = before.clone();
        s.close_to_tray = true;
        let out = s.merged_into(&before, m);
        assert_eq!(out["closeToTray"], json!(true));
        assert_eq!(out["newer"], json!({ "a": 1 }));
        assert_eq!(out[TRANSFERS]["verify"], json!("someNewMode"));
    }

    #[test]
    fn changing_one_transfer_setting_keeps_the_others_and_unknown_keys() {
        let m = map(json!({ "transfers": { "verify": "someNewMode", "concurrency": 8, "extra": true } }));
        let before = Stored::from_map(&m);
        let mut s = before.clone();
        s.transfers.upload_limit_kbps = 100;
        let out = s.merged_into(&before, m);
        assert_eq!(out[TRANSFERS]["verify"], json!("someNewMode"));
        assert_eq!(out[TRANSFERS]["concurrency"], json!(8));
        assert_eq!(out[TRANSFERS]["extra"], json!(true));
        assert_eq!(out[TRANSFERS]["uploadLimitKbps"], json!(100));
        assert!(out[TRANSFERS].get("partConcurrency").is_none());
    }

    #[test]
    fn a_changed_setting_is_written() {
        let m = Map::new();
        let before = Stored::from_map(&m);
        let mut s = before.clone();
        s.transfers.concurrency = 7;
        let out = s.merged_into(&before, m);
        assert_eq!(Stored::from_map(&out).transfers.concurrency, 7);
    }
}
