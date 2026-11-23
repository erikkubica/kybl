mod actions;
mod commands;
// .zip / .tar / .tar.gz: browse like a folder, extract, compress
mod archive;
// WP-C: phone backup (camera roll and folders to any connection)
mod backup;
// git status marks and searching inside files, with the user's own git / ripgrep / grep
mod devtools;
// WP-B1: SQLite open-with-migrations helper, and copy/move jobs between connections
mod db;
mod jobs;
// where downloads land: safe paths and free names
mod dest;
// recently fetched file bytes, shared by the viewers, downloads and "Open"
mod filecache;
// WP-D: open and save documents for the in-app viewers and editor
mod doc;
// "Edit" in another app: a private copy, watched, uploaded back when saved
#[cfg(desktop)]
mod edit;
// "Connect Kybl Storage": browser sign-in on computers and phones
mod kybl_connect;
// uploads and partial downloads an earlier run left behind (killed, crashed): cleaned at start
mod leftovers;
// vault v2: the secrets file and its keychain key (computers and iOS)
#[cfg(not(target_os = "android"))]
mod keyvault;
// the macOS menu bar
#[cfg(target_os = "macos")]
mod menu;
mod mobile;
// parallel, resumable multipart uploads
mod multipart;
// name checks, object headers and tags
mod objects;
// open / share / save to Photos / haptics / shared-in files / app lock (phones and desktop)
mod platform;
mod prefs;
// paused and interrupted transfers kept across a restart
mod resume;
// asking before quitting with transfers running
#[cfg(desktop)]
mod quit;
mod state;
// one trait for S3, this device's disk and (later) other providers
mod storage;
// "Import connections" from other file transfer apps (FileZilla first)
mod import;
// WP-A2: Google Drive, OneDrive and Dropbox sign-in and tokens
mod oauth;
// folder sync (desktop); its planner (`sync::plan`) is shared with phone backup
mod sync;
// WP-E4: "Mount as drive" (a local WebDAV server the system mounts)
#[cfg(desktop)]
mod mount;
mod placeholders;
// terminal panes: a shell on this computer or over SSH
#[cfg(desktop)]
mod terminal;
mod thumbs;
mod transfer_notice;
// SSH tunnels (local port forwards) of SFTP connections
mod tunnels;
mod transfers;
#[cfg(desktop)]
mod tray;
// transfer settings and the bandwidth cap
mod tuning;
// checking a file once it was uploaded or downloaded (size, checksums)
mod verify;
// update checks and installs from GitHub Releases
mod updater;

#[cfg(desktop)]
use std::sync::atomic::Ordering;

use tauri::Manager;
use tauri::RunEvent;
#[cfg(desktop)]
use tauri::{Emitter, WindowEvent};

/// Passed by the login item: start in the menu bar without opening the window.
#[cfg(desktop)]
const HIDDEN_ARG: &str = "--hidden";

/// Tracks the main window's focus. True when it comes back after at least 30 s away, the time
/// after which what the page shows may be out of date.
#[cfg(desktop)]
fn focus_back_after_a_while(focused: bool) -> bool {
    use std::{sync::Mutex, time::{Duration, Instant}};
    static LEFT: Mutex<Option<Instant>> = Mutex::new(None);
    let mut left = LEFT.lock().unwrap();
    if !focused {
        left.get_or_insert_with(Instant::now);
        return false;
    }
    left.take().is_some_and(|t| t.elapsed() >= Duration::from_secs(30))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(mobile::plugin())
        .plugin(transfer_notice::plugin())
        .plugin(platform::plugin())
        // WP-C
        .plugin(backup::plugin())
        .manage(state::AppState::default())
        .register_asynchronous_uri_scheme_protocol("thumb", thumbs::protocol)
        // WP-A4: video and audio from connections that can't presign
        .register_asynchronous_uri_scheme_protocol("media", storage::media::protocol);

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_autostart::Builder::new().args([HIDDEN_ARG]).build())
        .manage(sync::SyncManager::default())
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                let app = window.app_handle();
                if app.state::<prefs::Prefs>().close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    tray::hide_main(app);
                } else if !quit::quitting() && (quit::busy() > 0 || quit::unsaved() > 0) {
                    // closing the window quits the app: ask first (unsaved edits, then what still
                    // runs), like Quit does
                    api.prevent_close();
                    quit::request(app);
                }
            }
            // its terminals' shells end with it
            WindowEvent::Destroyed => terminal::close_for(window.label()),
            // the page refreshes what it shows when the window comes back to the front after a
            // while away (not on every click between windows)
            WindowEvent::Focused(focused) if window.label() == "main" => {
                if focus_back_after_a_while(*focused) {
                    let _ = window.emit("app-resumed", ());
                }
            }
            _ => {}
        })
        // a page loading anew (a reload) has no terminals yet: the old page's shells end
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                terminal::close_for(webview.label());
            }
        });

    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::on_event);

    let builder = builder.plugin(kybl_connect::plugin());

    let app = builder
        .setup(|app| {
            let handle = app.handle().clone();
            // the app's own folders hold copies of remote files (opened, previews, archives,
            // drive caches, pending drive saves): only this account may look inside (on a Linux
            // box whose home is 0755 they would otherwise be readable by everyone)
            for dir in [handle.path().app_cache_dir(), handle.path().app_data_dir()].into_iter().flatten() {
                let _ = filecache::private_dir(&dir);
            }
            if let Ok(dir) = handle.path().app_data_dir() {
                storage::ftp::tls_memory::init(dir.join("ftp-tls-seen.json"));
                let _ = handle.state::<state::AppState>().vault_dir.set(dir);
            }
            prefs::load_transfers(&handle);
            // before leftovers: what a kept transfer left behind is not to be cleaned up
            resume::start(&handle);
            leftovers::start(&handle);
            // WP-B1: copy/move jobs resume where they stopped
            jobs::setup(&handle);
            // WP-C: backup.db (background workers may have opened it first)
            backup::setup(&handle);
            // photo placeholders kept on this device
            placeholders::setup(&handle);
            #[cfg(desktop)]
            {
                app.manage(prefs::load(&handle));
                tray::setup(&handle)?;
                // the window is not created by the config (`create: false`): started at login it is
                // only made once the user opens it
                if std::env::args().any(|a| a == HIDDEN_ARG) {
                    #[cfg(target_os = "macos")]
                    let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                } else {
                    tray::show_main(&handle);
                }
                tauri::async_runtime::spawn(sync::init(handle.clone()));
                // WP-E4: saved drives are mounted again
                mount::setup(&handle);
                // copies left by "Edit" in an earlier run
                edit::setup(&handle);
            }
            #[cfg(mobile)]
            {
                let _window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default()).build()?;
                #[cfg(target_os = "ios")]
                mobile::edge_to_edge(&_window);
            }
            updater::start(&handle);
            tauri::async_runtime::spawn(filecache::prune(handle.clone()));
            tauri::async_runtime::spawn(thumbs::prune_cache(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::set_profile_groups,
            commands::delete_profile,
            import::import_sources,
            import::import_preview,
            import::import_apply,
            commands::test_connection,
            commands::list_buckets,
            commands::create_bucket,
            commands::list_objects,
            commands::search_objects,
            devtools::git_status,
            devtools::content_search,
            commands::head_object,
            commands::get_text_preview,
            commands::get_object_bytes,
            commands::folder_size,
            commands::presign_get,
            commands::create_folder,
            commands::delete_objects,
            commands::copy_or_move,
            commands::move_many,
            commands::expand_paths,
            commands::list_all_under,
            objects::existing_keys,
            objects::update_object_props,
            objects::get_object_tags,
            objects::put_object_tags,
            tuning::get_transfer_prefs,
            tuning::set_transfer_prefs,
            mobile::download_folder,
            mobile::native_theme,
            mobile::picked_files,
            platform::open_local,
            platform::copy_file_to_clipboard,
            platform::reveal_local,
            platform::apps::apps_for,
            platform::apps::open_with,
            platform::apps::open_with_chooser,
            platform::drag_out::start_drag_out,
            platform::drag_out::drag_out_done,
            platform::temp_folder,
            platform::write_temp_file,
            platform::share_files,
            platform::share_text,
            platform::save_to_photos,
            platform::haptic,
            platform::take_shared_files,
            platform::biometric_unlock,
            platform::set_privacy_screen,
            thumbs::clear_thumbnail_cache,
            placeholders::placeholders_lookup,
            placeholders::placeholder_head,
            placeholders::placeholders_folder,
            placeholders::placeholders_folder_save,
            placeholders::placeholder_from_thumbnail,
            filecache::cache_usage,
            filecache::clear_caches,
            // WP0: storage core
            archive::archive_open,
            archive::archive_extract,
            archive::archive_compress,
            storage::generic_cmds::list_roots,
            storage::generic_cmds::connection_capabilities,
            storage::generic_cmds::local_path,
            storage::perms::set_permissions,
            storage::perms::resolve_link,
            storage::perms::make_link,
            // WP-A4
            storage::media::media_base,
            transfers::start_upload,
            transfers::start_download,
            transfers::cancel_transfer,
            transfers::pause_transfer,
            transfers::pause_all_transfers,
            transfers::kept_transfers,
            transfers::move_transfer_to_top,
            actions::custom_action_run,
            actions::custom_action_stop,
            actions::custom_action_preview,
            transfers::active_transfers,
            // terminal panes
            #[cfg(desktop)]
            terminal::terminal_open,
            #[cfg(desktop)]
            terminal::terminal_write,
            #[cfg(desktop)]
            terminal::terminal_resize,
            #[cfg(desktop)]
            terminal::terminal_ack,
            #[cfg(desktop)]
            terminal::terminal_close,
            // SSH tunnels
            #[cfg(desktop)]
            tunnels::run::tunnel_list,
            #[cfg(desktop)]
            tunnels::run::tunnel_start,
            #[cfg(desktop)]
            tunnels::run::tunnel_stop,
            #[cfg(desktop)]
            tunnels::run::tunnel_port_check,
            #[cfg(desktop)]
            terminal::terminal_busy,
            #[cfg(desktop)]
            sync::sync_list,
            #[cfg(desktop)]
            sync::sync_save,
            #[cfg(desktop)]
            sync::sync_delete,
            #[cfg(desktop)]
            sync::sync_now,
            #[cfg(desktop)]
            sync::sync_set_paused,
            #[cfg(desktop)]
            sync::sync_pause_all,
            // WP-E1: two-way sync
            #[cfg(desktop)]
            sync::sync_conflicts,
            #[cfg(desktop)]
            sync::sync_resolve_conflict,
            #[cfg(desktop)]
            sync::sync_pending,
            #[cfg(desktop)]
            sync::sync_confirm_deletes,
            #[cfg(desktop)]
            sync::sync_restore_deletes,
            #[cfg(desktop)]
            sync::sync_keep_offline,
            kybl_connect::kybl_default_app_url,
            kybl_connect::kybl_connect_browser,
            kybl_connect::kybl_device_start,
            kybl_connect::kybl_device_wait,
            kybl_connect::kybl_connect_cancel,
            updater::update_status,
            updater::update_check,
            updater::update_settings,
            updater::update_install,
            updater::update_restart,
            #[cfg(desktop)]
            prefs::get_app_prefs,
            #[cfg(desktop)]
            prefs::set_app_prefs,
            // WP-D
            doc::doc_open,
            doc::doc_save,
            // editing in another app
            #[cfg(desktop)]
            edit::edit_start,
            #[cfg(desktop)]
            edit::edit_list,
            #[cfg(desktop)]
            edit::edit_stop,
            #[cfg(desktop)]
            edit::edit_retry,
            #[cfg(desktop)]
            edit::edit_resolve,
            #[cfg(desktop)]
            edit::edit_local_text,
            // WP-B1: copying and moving between connections
            jobs::job_create,
            jobs::job_list,
            jobs::job_pause,
            jobs::job_resume,
            jobs::job_cancel,
            jobs::job_delete,
            jobs::job_failures,
            jobs::job_retry_failed,
            jobs::mirror::mirror_md5,
            // WP-A2: cloud drive sign-in
            oauth::oauth_start,
            oauth::oauth_cancel,
            oauth::oauth_builtin_clients,
            // WP-E4: drives
            #[cfg(desktop)]
            mount::mount_list,
            #[cfg(desktop)]
            mount::mount_add,
            #[cfg(desktop)]
            mount::mount_remove,
            #[cfg(desktop)]
            mount::mount_reveal,
            #[cfg(desktop)]
            mount::mount_retry,
            #[cfg(desktop)]
            mount::mount_eject,
            #[cfg(desktop)]
            mount::mount_dismiss,
            // unsaved edits in the editor: asked about before quitting
            #[cfg(desktop)]
            quit::set_unsaved_documents,
            // WP-C: phone backup
            backup::backup_overview,
            backup::backup_save,
            backup::backup_delete,
            backup::backup_set_paused,
            backup::backup_run_now,
            backup::backup_cancel,
            backup::backup_failures,
            backup::backup_retry,
            backup::backup_permission,
            backup::backup_request_permission,
            backup::backup_manage_access,
            backup::backup_pick_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        // Android: closing the app's screen must not end transfers still running
        #[cfg(mobile)]
        match &_event {
            RunEvent::ExitRequested { code: None, api, .. } => {
                if transfer_notice::keep_alive_without_window(_app) {
                    api.prevent_exit();
                }
            }
            // ...and opened again while they still run: the new screen needs a window
            RunEvent::MainEventsCleared => {
                if transfer_notice::screen_back_without_window(_app) {
                    // fails while the new screen is still starting: tried again on the next pass
                    if tauri::WebviewWindowBuilder::new(_app, "main", tauri::WebviewUrl::default()).build().is_err() {
                        transfer_notice::window_not_back(_app);
                    }
                }
            }
            _ => {}
        }
        #[cfg(desktop)]
        match _event {
            // clicking the Dock icon while the window is hidden brings it back
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => tray::show_main(_app),
            // the hidden window was destroyed to free memory (see tray::hide_main): keep running
            RunEvent::ExitRequested { code: None, api, .. } if tray::REAPING.swap(false, Ordering::SeqCst) => {
                api.prevent_exit();
            }
            // cleaning up on the way out: that ends the app itself in a moment
            RunEvent::ExitRequested { api, .. } if quit::quitting() && !quit::leaving() => {
                api.prevent_exit();
            }
            // any other way out goes through quit.rs: it asks first while something runs, and
            // either way aborts uploads kept for Retry and removes partial downloads
            RunEvent::ExitRequested { api, .. } if !quit::quitting() => {
                api.prevent_exit();
                quit::request(_app);
            }
            _ => {}
        }
    });
}
