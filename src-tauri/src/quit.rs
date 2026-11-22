//! Quitting while transfers or bucket operations run: ask first, and clean up on the way out.
//!
//! Every way out goes through [`request`]: the tray's Quit, the menu bar's Quit (⌘Q), and
//! closing the window when it doesn't hide to the tray. With nothing running it quits straight
//! away. Otherwise a native prompt asks; on Quit the transfers are stopped, open multipart
//! uploads are aborted (so their parts stop costing storage) and partial downloads removed.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::state::AppState;

/// Set once the person confirmed (or nothing was running): the exit that follows goes through.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// A prompt is already on screen; a second ⌘Q doesn't stack another.
static ASKING: AtomicBool = AtomicBool::new(false);

/// How long aborting open uploads may hold up quitting.
const CLEANUP_LIMIT: Duration = Duration::from_secs(3);

pub fn quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// Transfers and bucket operations still running.
pub fn busy() -> usize {
    crate::transfers::active_count() + crate::commands::running_jobs() + crate::jobs::running_count()
}

/// The prompt's question for `n` things running.
fn question(transfers: usize, jobs: usize) -> String {
    let plural = |n: usize, one: &str, many: &str| if n == 1 { format!("1 {one} is") } else { format!("{n} {many} are") };
    match (transfers, jobs) {
        (t, 0) => format!("{} still running. Quit anyway?", plural(t, "transfer", "transfers")),
        (0, j) => format!("{} still running. Quit anyway?", plural(j, "move, copy or delete", "moves, copies or deletes")),
        (t, j) => format!(
            "{} and {} are still running. Quit anyway?",
            if t == 1 { "1 transfer".to_string() } else { format!("{t} transfers") },
            if j == 1 { "1 move, copy or delete".to_string() } else { format!("{j} moves, copies or deletes") },
        ),
    }
}

/// Quits, asking first when something is running.
pub fn request(app: &AppHandle) {
    if quitting() {
        app.exit(0);
        return;
    }
    // WP-B1: copy/move jobs between connections count as copies (they resume on the next start)
    let (transfers, jobs) = (crate::transfers::active_count(), crate::commands::running_jobs() + crate::jobs::running_count());
    if transfers + jobs == 0 {
        // failed uploads kept for Retry still hold parts on the server: abort those on the way out
        exit_cleanly(app.clone());
        return;
    }
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut dialog = app
        .dialog()
        .message(question(transfers, jobs))
        .title("Quit Kybl?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Keep running".into()));
    if let Some(w) = app.get_webview_window("main").filter(|w| w.is_visible().unwrap_or(false)) {
        dialog = dialog.parent(&w);
    }
    let app = app.clone();
    dialog.show(move |quit| {
        ASKING.store(false, Ordering::SeqCst);
        if quit {
            exit_cleanly(app);
        }
    });
}

/// Stops everything, cleans up (waiting at most [`CLEANUP_LIMIT`]) and exits.
fn exit_cleanly(app: AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        crate::transfers::shutdown(&app.state::<AppState>(), CLEANUP_LIMIT).await;
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_question_reads_naturally() {
        assert_eq!(question(1, 0), "1 transfer is still running. Quit anyway?");
        assert_eq!(question(3, 0), "3 transfers are still running. Quit anyway?");
        assert_eq!(question(0, 1), "1 move, copy or delete is still running. Quit anyway?");
        assert_eq!(question(2, 1), "2 transfers and 1 move, copy or delete are still running. Quit anyway?");
    }
}
