//! Menu-bar (tray) icon, and hiding to it instead of quitting when the window is closed.
//!
//! The window (and with it the whole web view process) only exists while it is needed: it is
//! created when opened, and destroyed once it has been hidden for a while with nothing running.
//! Sitting in the menu bar then costs only the Rust side.

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime, WebviewWindowBuilder, Wry,
};

use crate::{
    state::AppState,
    sync::{self, SyncManager, SyncStatus},
};

/// How long a hidden window is kept around (cheap to show again) before it is destroyed.
const KEEP_HIDDEN: Duration = Duration::from_secs(60);

/// Set while the window is being destroyed by [`hide_main`], so that losing the last window does
/// not quit the app.
pub static REAPING: AtomicBool = AtomicBool::new(false);
static REAPER_RUNNING: AtomicBool = AtomicBool::new(false);
/// Bumped on every hide, so the reaper restarts its wait after a quick show-and-hide.
static HIDES: AtomicU64 = AtomicU64::new(0);

pub struct TrayItems {
    menu: Menu<Wry>,
    status: MenuItem<Wry>,
    /// "Review 2 conflicts…" and "Confirm deletions…": only in the menu while something waits
    conflicts: MenuItem<Wry>,
    deletions: MenuItem<Wry>,
    /// which of the two are in the menu now
    shown: Mutex<(bool, bool)>,
    pause: MenuItem<Wry>,
    sync_now: MenuItem<Wry>,
    /// "Check for updates…", or "Update to Kybl x.y.z…" once one is found
    update: MenuItem<Wry>,
    /// WP-E4: "Drives", one item per mounted drive (opens it in Finder)
    drives: Submenu<Wry>,
    /// last text shown, so unchanged updates skip the native menu calls
    last: Mutex<String>,
    last_drives: Mutex<Vec<(String, String, bool)>>,
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "No folders synced yet", false, None::<&str>)?;
    let conflicts = MenuItem::with_id(app, "sync_conflicts", "Review conflicts…", true, None::<&str>)?;
    let deletions = MenuItem::with_id(app, "sync_deletions", "Confirm deletions…", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Kybl", true, None::<&str>)?;
    let sync_now = MenuItem::with_id(app, "sync_now", "Sync now", false, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause syncing", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "sync_settings", "Sync settings…", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Check for updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Kybl", true, None::<&str>)?;
    // WP-E4: filled by refresh_mounts
    let drives = Submenu::with_id(app, "drives", "Drives", true)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &sync_now,
            &pause,
            &settings,
            &drives,
            &PredefinedMenuItem::separator(app)?,
            &update,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Kybl")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "sync_settings" | "sync_conflicts" | "sync_deletions" => show_main_at(app, Some("sync")),
            "sync_now" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    sync::sync_all_now(&app.state::<SyncManager>()).await;
                });
            }
            "pause" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let mgr = app.state::<SyncManager>();
                    let paused = mgr.paused_flag.load(Ordering::Relaxed);
                    let _ = sync::set_paused_all(&app, &mgr, !paused).await;
                });
            }
            // the window shows what was found (the update prompt, or the result in General settings)
            "update" => {
                show_main_at(app, Some("general"));
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::updater::update_check(app).await;
                });
            }
            "quit" => crate::quit::request(app),
            // WP-E4
            "drive_settings" => show_main_at(app, Some("drives")),
            id if id.starts_with("drive:") => {
                let (app, id) = (app.clone(), id["drive:".len()..].to_string());
                tauri::async_runtime::spawn(async move {
                    let _ = crate::mount::mount_reveal(app, id).await;
                });
            }
            _ => {}
        })
        .build(app)?;
    app.manage(TrayItems { menu, status, conflicts, deletions, shown: Mutex::new((false, false)), pause, sync_now, update, drives, last: Mutex::new(String::new()), last_drives: Mutex::new(vec![(String::new(), String::new(), false)]) });
    refresh(app);
    refresh_mounts(app);
    Ok(())
}

/// WP-E4: rebuilds the "Drives" submenu from the mounted drives (when they changed).
pub fn refresh_mounts(app: &AppHandle) {
    let Some(items) = app.try_state::<TrayItems>() else { return };
    let drives = crate::mount::tray_items(app);
    {
        let mut last = items.last_drives.lock().unwrap();
        if *last == drives {
            return;
        }
        *last = drives.clone();
    }
    let menu = &items.drives;
    while let Ok(Some(_)) = menu.remove_at(0) {}
    for (id, name, mounted) in &drives {
        if let Ok(item) = MenuItem::with_id(app, format!("drive:{id}"), name, *mounted, None::<&str>) {
            let _ = menu.append(&item);
        }
    }
    if drives.is_empty()
        && let Ok(item) = MenuItem::with_id(app, "drives_none", "No drives yet", false, None::<&str>)
    {
        let _ = menu.append(&item);
    }
    if let Ok(sep) = PredefinedMenuItem::separator(app) {
        let _ = menu.append(&sep);
    }
    if let Ok(item) = MenuItem::with_id(app, "drive_settings", "Drive settings…", true, None::<&str>) {
        let _ = menu.append(&item);
    }
}

fn summarize(st: &[SyncStatus], paused: bool) -> String {
    if st.is_empty() {
        return "No folders synced yet".into();
    }
    if paused {
        return "Syncing paused".into();
    }
    let (done, total) = st
        .iter()
        .filter(|s| s.state == "syncing")
        .fold((0, 0), |(d, t), s| (d + s.done, t + s.total));
    if total > 0 {
        return format!("Syncing… {done} of {total} files");
    }
    if st.iter().any(|s| s.state == "scanning") {
        return "Checking for changes…".into();
    }
    let errors = st.iter().filter(|s| s.state == "error").count();
    if errors > 0 {
        return format!("{errors} {} need{} attention", if errors == 1 { "folder" } else { "folders" }, if errors == 1 { "s" } else { "" });
    }
    let running = st.iter().filter(|s| s.state != "paused").count();
    if running == 0 {
        return "All folders paused".into();
    }
    format!("Up to date · {running} {}", if running == 1 { "folder" } else { "folders" })
}

/// Updates the tray menu and tooltip from the current sync state.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(items) = app.try_state::<TrayItems>() else { return };
    let mgr = app.state::<SyncManager>();
    let paused = mgr.paused_flag.load(Ordering::Relaxed);
    let st = mgr.statuses();
    let text = summarize(&st, paused);
    let conflicts: u32 = st.iter().map(|s| s.conflicts).sum();
    let held = st.iter().filter(|s| s.pending_deletes > 0).count();
    {
        let mut last = items.last.lock().unwrap();
        let key = format!("{paused}|{}|{text}|{conflicts}|{held}", st.iter().any(|s| s.state != "paused"));
        if *last == key {
            return;
        }
        *last = key;
    }
    let _ = items.status.set_text(&text);
    attention(&items, conflicts, held);
    let _ = items.pause.set_text(if paused { "Resume syncing" } else { "Pause syncing" });
    let _ = items.sync_now.set_enabled(!paused && st.iter().any(|s| s.state != "paused"));
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Kybl · {text}")));
    }
}

/// Shows the deletion and conflict items right below the status while something waits.
fn attention(items: &TrayItems, conflicts: u32, held: usize) {
    let mut shown = items.shown.lock().unwrap();
    let _ = items.conflicts.set_text(if conflicts == 1 { "Review 1 conflict…".to_string() } else { format!("Review {conflicts} conflicts…") });
    let _ = items.deletions.set_text(if held == 1 { "Confirm deletions in 1 folder…".to_string() } else { format!("Confirm deletions in {held} folders…") });
    let want = (conflicts > 0, held > 0);
    if *shown == want {
        return;
    }
    // take both out and put back what is needed, so their order never changes
    if shown.0 {
        let _ = items.menu.remove(&items.conflicts);
    }
    if shown.1 {
        let _ = items.menu.remove(&items.deletions);
    }
    let mut at = 1;
    if want.1 {
        let _ = items.menu.insert(&items.deletions, at);
        at += 1;
    }
    if want.0 {
        let _ = items.menu.insert(&items.conflicts, at);
    }
    *shown = want;
}

/// Names a found update in the menu.
pub fn set_update(app: &AppHandle, version: Option<&str>) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.update.set_text(match version {
            Some(v) => format!("Update to Kybl {v}…"),
            None => "Check for updates…".into(),
        });
    }
}

pub fn show_main(app: &AppHandle) {
    show_main_at(app, None);
}

/// Shows the window, creating it if it does not exist, optionally on a settings page.
pub fn show_main_at(app: &AppHandle, settings_page: Option<&str>) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let window = match app.get_webview_window("main") {
        Some(w) => {
            if let Some(page) = settings_page {
                let _ = app.emit("open-settings", page);
            }
            w
        }
        None => {
            let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main") else { return };
            let mut b = match WebviewWindowBuilder::from_config(app, cfg) {
                Ok(b) => b,
                Err(_) => return,
            };
            if let Some(page) = settings_page {
                // the page is not listening for events yet: leave the request where it looks on start
                b = b.initialization_script(format!("window.__KYBL_OPEN_SETTINGS__ = {page:?};"));
            }
            match b.build() {
                Ok(w) => w,
                Err(_) => return,
            }
        }
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Hides the window and, on macOS, the Dock icon; the app keeps running in the menu bar.
/// After [`KEEP_HIDDEN`] with no transfer or bucket operation running, the window is destroyed.
pub fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    HIDES.fetch_add(1, Ordering::SeqCst);
    if REAPER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut seen = HIDES.load(Ordering::SeqCst);
        loop {
            tokio::time::sleep(KEEP_HIDDEN).await;
            let now = HIDES.load(Ordering::SeqCst);
            if now != seen {
                seen = now;
                continue;
            }
            let Some(w) = app.get_webview_window("main") else { break };
            if w.is_visible().unwrap_or(true) {
                break;
            }
            // transfers and bucket operations report progress to the page: let them finish first
            if !app.state::<AppState>().cancels.lock().await.is_empty() {
                continue;
            }
            REAPING.store(true, Ordering::SeqCst);
            let _ = w.destroy();
            break;
        }
        REAPER_RUNNING.store(false, Ordering::SeqCst);
    });
}
