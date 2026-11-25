//! The macOS menu bar. App actions are listed with their shortcuts, and choosing one sends the
//! page a `menu` event with the item's id (see `NativeEvent` in api.ts).
//!
//! Shortcuts and the page's own key handling: WebKit offers a key press to the page first and
//! only gives it to the menu when the page doesn't take it. Keys the page already handles
//! (⌘R, ⌘F, ⌘A, ⌘↑, Delete, ⌘⌫) therefore get no shortcut here, so one press can never act twice;
//! their items work by click. The Edit menu keeps the standard items, which text fields need for
//! undo, cut, copy, paste and select all; so there is no separate "select-all" item for files
//! (⌘A reaches the page's own handler first, as it always has).
//!
//! Windows and Linux get no menu bar: there Tauri draws it inside the window, above the app's own
//! toolbar, which looks out of place in this design. The page's shortcuts cover those keys.

use tauri::{
    menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Runtime,
};

/// Item ids passed to the page as they are.
const PAGE_ITEMS: &[&str] = &[
    "duplicate",
    "edit",
    "new-connection",
    "new-folder",
    "new-file",
    "upload-files",
    "upload-folder",
    "download",
    "get-info",
    "rename",
    "delete",
    "refresh",
    "back",
    "forward",
    "go-up",
    "go-to",
    "search",
    "settings",
    "split-right",
    "split-down",
    "close-pane",
    "swap-panes",
    "switch-pane",
    "same-folder",
    "compare-folders",
    "pane-copy",
    "pane-move",
    "toggle-hidden",
    "toggle-sidebar",
    "filter-connections",
    "tiles-bigger",
    "tiles-smaller",
    "toggle-compact",
    "new-workspace",
    "next-workspace",
    "prev-workspace",
    "move-workspace-left",
    "move-workspace-right",
    "rename-workspace",
    "workspace-settings",
    "close-workspace",
    "command-palette",
    "toggle-terminal",
    "help",
    "keyboard-shortcuts",
    "whats-new",
    "report-problem",
];

/// Handled here, not by the page (named apart from the tray menu's ids, which share the handler).
const QUIT: &str = "app-quit";
const CHECK_UPDATES: &str = "check-updates";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let sep = || PredefinedMenuItem::separator(app);
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Kybl"), Some(about))?,
            &item(CHECK_UPDATES, "Check for Updates…", None)?,
            &sep()?,
            &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some("Hide Kybl"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            // not the standard Quit: that ends the app on the spot, with no chance to ask about
            // running transfers (see app/quit.rs)
            &item(QUIT, "Quit Kybl", Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("new-connection", "New Connection…", None)?,
            &item("new-folder", "New Folder", Some("CmdOrCtrl+Shift+N"))?,
            &item("new-file", "New File", Some("CmdOrCtrl+Alt+N"))?,
            &sep()?,
            &item("upload-files", "Upload Files…", Some("CmdOrCtrl+U"))?,
            &item("upload-folder", "Upload Folder…", Some("CmdOrCtrl+Shift+U"))?,
            &item("download", "Download", Some("CmdOrCtrl+Shift+D"))?,
            &sep()?,
            &item("get-info", "Get Info", Some("CmdOrCtrl+I"))?,
            &item("edit", "Edit", Some("CmdOrCtrl+E"))?,
            &item("rename", "Rename…", None)?,
            &item("duplicate", "Duplicate", Some("CmdOrCtrl+D"))?,
            &item("delete", "Delete…", None)?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            // the page takes ⌘K first too (and leaves it to a terminal pane that owns its keys)
            &item("command-palette", "Command Palette…", Some("CmdOrCtrl+K"))?,
            &sep()?,
            &item("refresh", "Refresh", None)?,
            &item("search", "Search…", None)?,
            &item("toggle-hidden", "Show Hidden Files", Some("CmdOrCtrl+Shift+Period"))?,
            &item("toggle-sidebar", "Show or Hide Sidebar", Some("CmdOrCtrl+Alt+S"))?,
            &item("filter-connections", "Find Connection…", Some("CmdOrCtrl+Alt+F"))?,
            &sep()?,
            // the pane in use: grid tile size and compact rows
            &item("tiles-bigger", "Bigger Icons", Some("CmdOrCtrl+Equal"))?,
            &item("tiles-smaller", "Smaller Icons", Some("CmdOrCtrl+Minus"))?,
            &item("toggle-compact", "Compact Layout", None)?,
            &sep()?,
            // panes: F5, F6 and Tab stay with the page (they'd steal keys from text fields), and
            // ⌘W with the window's Close (the page takes it first while several panes are open)
            &item("split-right", "Split Right", Some("CmdOrCtrl+Backslash"))?,
            &item("split-down", "Split Down", Some("CmdOrCtrl+Shift+Backslash"))?,
            &item("close-pane", "Close Pane", None)?,
            &item("switch-pane", "Switch Pane", None)?,
            &item("swap-panes", "Swap Panes", Some("CmdOrCtrl+Shift+S"))?,
            &item("same-folder", "Same Folder in Other Pane", None)?,
            &item("compare-folders", "Compare Folders", None)?,
            &item("pane-copy", "Copy to Other Pane", None)?,
            &item("pane-move", "Move to Other Pane", None)?,
            // a terminal pane below the active one, or back and forth to it (the page takes ⌃`
            // first while a terminal has the keyboard)
            // ⌘J on a Mac: ⌃` needs a key many layouts (Slovak, German) don't have plain; the
            // page still takes ⌃` itself
            &item("toggle-terminal", "Terminal", Some(if cfg!(target_os = "macos") { "Cmd+J" } else { "Ctrl+Backquote" }))?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &item("back", "Back", Some("CmdOrCtrl+["))?,
            &item("forward", "Forward", Some("CmdOrCtrl+]"))?,
            &item("go-up", "Enclosing Folder", None)?,
            &sep()?,
            &item("go-to", "Go to Folder…", Some("CmdOrCtrl+Shift+G"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &sep()?,
            // workspaces, the window's tabs (where Safari keeps its tab items). The page handles
            // these keys as well (⌃Tab, ⌥⌘1–9 and ⌥⇧⌘[ / ] only there): whichever gets the press
            // first runs it, so one the menu can't match still works
            &item("new-workspace", "New Workspace", Some("CmdOrCtrl+T"))?,
            &item("prev-workspace", "Show Previous Workspace", Some("CmdOrCtrl+Shift+["))?,
            &item("next-workspace", "Show Next Workspace", Some("CmdOrCtrl+Shift+]"))?,
            &item("move-workspace-left", "Move Workspace Left", None)?,
            &item("move-workspace-right", "Move Workspace Right", None)?,
            &item("rename-workspace", "Rename Workspace…", None)?,
            &item("workspace-settings", "Workspace Settings…", None)?,
            &item("close-workspace", "Close Workspace", None)?,
            &sep()?,
        ],
    )?;
    // the manual and the project's pages, opened in the browser by the page (core/manual.ts)
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item("help", "Kybl Manual", Some("CmdOrCtrl+Shift+/"))?,
            &item("keyboard-shortcuts", "Keyboard Shortcuts", None)?,
            &sep()?,
            &item("whats-new", "What’s New in Kybl", None)?,
            &item("report-problem", "Report a Problem…", None)?,
        ],
    )?;
    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window, &help])?;
    // macOS lists open windows in this menu, and puts its search field in the Help menu
    let _ = window.set_as_windows_menu_for_nsapp();
    let _ = help.set_as_help_menu_for_nsapp();
    Ok(menu)
}

pub fn on_event(app: &AppHandle, e: MenuEvent) {
    let id = e.id().as_ref();
    match id {
        QUIT => crate::app::quit::request(app),
        CHECK_UPDATES => {
            crate::app::tray::show_main_at(app, Some("general"));
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::app::updater::update_check(app).await;
            });
        }
        _ if PAGE_ITEMS.contains(&id) => {
            let _ = app.emit("menu", id);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_items_match_the_contract() {
        // the ids api.ts documents for the `menu` event, minus "select-all" (see the note above)
        let src = include_str!("../../../src/core/api.ts");
        for id in PAGE_ITEMS {
            assert!(src.contains(&format!("\"{id}\"")), "{id} is not documented in api.ts");
        }
    }
}
