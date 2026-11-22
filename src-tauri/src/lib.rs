mod commands;
// where downloads land: safe paths and free names
mod dest;
// "Connect Kybl Storage": browser sign-in on computers and phones
mod kybl_connect;
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
// asking before quitting with transfers running
#[cfg(desktop)]
mod quit;
mod state;
#[cfg(desktop)]
mod sync;
mod thumbs;
mod transfer_notice;
mod transfers;
#[cfg(desktop)]
mod tray;
// transfer settings and the bandwidth cap
mod tuning;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(mobile::plugin())
        .plugin(transfer_notice::plugin())
        .plugin(platform::plugin())
        .manage(state::AppState::default())
        .register_asynchronous_uri_scheme_protocol("thumb", thumbs::protocol);

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
                } else if !quit::quitting() && quit::busy() > 0 {
                    // closing the window quits the app: ask first, like Quit does
                    api.prevent_close();
                    quit::request(app);
                }
            }
            // the page refreshes what it shows when the window comes back to the front
            WindowEvent::Focused(true) if window.label() == "main" => {
                let _ = window.emit("app-resumed", ());
            }
            _ => {}
        });

    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::on_event);

    let builder = builder.plugin(kybl_connect::plugin());

    let app = builder
        .setup(|app| {
            let handle = app.handle().clone();
            if let Ok(dir) = handle.path().app_data_dir() {
                let _ = handle.state::<state::AppState>().vault_dir.set(dir);
            }
            prefs::load_transfers(&handle);
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
            platform::reveal_local,
            platform::temp_folder,
            platform::share_files,
            platform::share_text,
            platform::save_to_photos,
            platform::haptic,
            platform::take_shared_files,
            platform::biometric_unlock,
            platform::set_privacy_screen,
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
            // any other way out while transfers run asks first (see quit.rs)
            RunEvent::ExitRequested { api, .. } if !quit::quitting() && quit::busy() > 0 => {
                api.prevent_exit();
                quit::request(_app);
            }
            _ => {}
        }
    });
}
