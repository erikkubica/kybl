mod commands;
// WP-D: open and save documents for the in-app viewers and editor
mod doc;
// "Connect Kybl Storage": browser sign-in on computers and phones
mod kybl_connect;
mod mobile;
#[cfg(desktop)]
mod prefs;
mod state;
#[cfg(desktop)]
mod sync;
mod thumbs;
mod transfer_notice;
mod transfers;
#[cfg(desktop)]
mod tray;
// update checks and installs from GitHub Releases
mod updater;

#[cfg(desktop)]
use std::sync::atomic::Ordering;

use tauri::Manager;
use tauri::RunEvent;
#[cfg(desktop)]
use tauri::WindowEvent;

/// Passed by the login item: start in the menu bar without opening the window.
#[cfg(desktop)]
const HIDDEN_ARG: &str = "--hidden";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(mobile::plugin())
        .plugin(transfer_notice::plugin())
        .manage(state::AppState::default())
        .register_asynchronous_uri_scheme_protocol("thumb", thumbs::protocol);

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_autostart::Builder::new().args([HIDDEN_ARG]).build())
        .manage(sync::SyncManager::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if window.label() == "main" && app.state::<prefs::Prefs>().close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    tray::hide_main(app);
                }
            }
        });

    let builder = builder.plugin(kybl_connect::plugin());

    let app = builder
        .setup(|app| {
            let handle = app.handle().clone();
            if let Ok(dir) = handle.path().app_data_dir() {
                let _ = handle.state::<state::AppState>().vault_dir.set(dir);
            }
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
            }
            #[cfg(mobile)]
            {
                let _window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default()).build()?;
                #[cfg(target_os = "ios")]
                mobile::edge_to_edge(&_window);
            }
            updater::start(&handle);
            tauri::async_runtime::spawn(thumbs::prune_cache(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::test_connection,
            commands::list_buckets,
            commands::create_bucket,
            commands::list_objects,
            commands::search_objects,
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
            mobile::download_folder,
            mobile::native_theme,
            mobile::picked_files,
            thumbs::clear_thumbnail_cache,
            transfers::start_upload,
            transfers::start_download,
            transfers::cancel_transfer,
            transfers::active_transfers,
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
            _ => {}
        }
    });
}
