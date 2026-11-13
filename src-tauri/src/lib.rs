mod commands;
mod kybl_connect;
mod prefs;
mod state;
mod sync;
mod thumbs;
mod transfers;
mod tray;

use std::sync::atomic::Ordering;

use tauri::{Manager, RunEvent, WindowEvent};

/// Passed by the login item: start in the menu bar without opening the window.
const HIDDEN_ARG: &str = "--hidden";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::Builder::new().args([HIDDEN_ARG]).build())
        .manage(state::AppState::default())
        .manage(sync::SyncManager::default())
        .register_asynchronous_uri_scheme_protocol("thumb", thumbs::protocol)
        .setup(|app| {
            let handle = app.handle().clone();
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
            tauri::async_runtime::spawn(thumbs::prune_cache(handle.clone()));
            tauri::async_runtime::spawn(sync::init(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if window.label() == "main" && app.state::<prefs::Prefs>().close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    tray::hide_main(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::test_connection,
            commands::list_buckets,
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
            thumbs::clear_thumbnail_cache,
            transfers::start_upload,
            transfers::start_download,
            transfers::cancel_transfer,
            sync::sync_list,
            sync::sync_save,
            sync::sync_delete,
            sync::sync_now,
            sync::sync_set_paused,
            sync::sync_pause_all,
            kybl_connect::kybl_default_app_url,
            kybl_connect::kybl_connect_browser,
            kybl_connect::kybl_device_start,
            kybl_connect::kybl_device_wait,
            kybl_connect::kybl_connect_cancel,
            prefs::get_app_prefs,
            prefs::set_app_prefs,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        match event {
            // clicking the Dock icon while the window is hidden brings it back
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => tray::show_main(app),
            // the hidden window was destroyed to free memory (see tray::hide_main): keep running
            RunEvent::ExitRequested { code: None, api, .. } if tray::REAPING.swap(false, Ordering::SeqCst) => {
                api.prevent_exit();
            }
            _ => {}
        }
    });
}
