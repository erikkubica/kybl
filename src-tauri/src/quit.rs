//! Quitting while transfers or bucket operations run: ask first, and clean up on the way out.
//!
//! Every way out goes through [`request`]: the tray's Quit, the menu bar's Quit (⌘Q), and
//! closing the window when it doesn't hide to the tray. With nothing running it quits straight
//! away. Otherwise a native prompt asks; on Quit the transfers are stopped, open multipart
//! uploads are aborted (so their parts stop costing storage) and partial downloads removed.

use std::{
    sync::atomic::{AtomicBool, AtomicU8, Ordering},
    time::Duration,
};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::state::AppState;

/// Where quitting is at: [`RUNNING`], [`CLEANING`] (confirmed, or nothing was running: stopping
/// transfers and aborting uploads) or [`LEAVING`] (cleaned up: the exit that follows goes through).
static STAGE: AtomicU8 = AtomicU8::new(RUNNING);
const RUNNING: u8 = 0;
const CLEANING: u8 = 1;
const LEAVING: u8 = 2;
/// A prompt is already on screen; a second ⌘Q doesn't stack another.
static ASKING: AtomicBool = AtomicBool::new(false);

/// How long aborting open uploads may hold up quitting.
const CLEANUP_LIMIT: Duration = Duration::from_secs(3);

/// Quitting is under way (cleaning up, or done with that).
pub fn quitting() -> bool {
    STAGE.load(Ordering::SeqCst) != RUNNING
}

/// Cleaned up: an exit request now ends the app. Before that, while cleaning up, exit requests
/// are held back; the cleanup exits on its own when done (within [`CLEANUP_LIMIT`] or so).
pub fn leaving() -> bool {
    STAGE.load(Ordering::SeqCst) == LEAVING
}

/// Transfers and bucket operations still running.
pub fn busy() -> usize {
    crate::transfers::active_count() + crate::commands::running_jobs() + crate::jobs::running_count()
}

/// WP-E4: busy() plus saves on drives still to upload (they need the app, not the window).
fn busy_quitting(app: &AppHandle) -> (usize, usize, usize) {
    (
        crate::transfers::active_count(),
        crate::commands::running_jobs() + crate::jobs::running_count(),
        crate::mount::pending_uploads(app),
    )
}

/// WP-E4: the question with drive uploads waiting too.
fn question_with_drives(transfers: usize, jobs: usize, drives: usize) -> String {
    if drives == 0 {
        return question(transfers, jobs);
    }
    let files = if drives == 1 { "1 file on a drive is".to_string() } else { format!("{drives} files on drives are") };
    if transfers + jobs == 0 {
        return format!("{files} still waiting to upload. They'll upload next time you open Kybl. Quit anyway?");
    }
    let q = question(transfers, jobs);
    let q = q.trim_end_matches(" Quit anyway?");
    format!("{q} Also, {files} still waiting to upload (they'll upload next time you open Kybl). Quit anyway?")
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
    // already on the way out: a second ⌘Q changes nothing, the cleanup ends the app shortly
    if quitting() {
        return;
    }
    // WP-B1: copy/move jobs between connections count as copies (they resume on the next start)
    let (transfers, jobs, drives) = busy_quitting(app);
    if transfers + jobs + drives == 0 {
        // failed uploads kept for Retry still hold parts on the server: abort those on the way out
        exit_cleanly(app.clone());
        return;
    }
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut dialog = app
        .dialog()
        .message(question_with_drives(transfers, jobs, drives))
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
    STAGE.store(CLEANING, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        clean_up(&app).await;
        app.exit(0);
    });
}

/// Stops every transfer and bucket operation, aborts open and kept multipart uploads and removes
/// partial downloads (waiting at most [`CLEANUP_LIMIT`]); exit requests go through afterwards.
/// Also run before an update restarts the app, so that neither asks again nor leaves parts behind.
pub async fn clean_up(app: &AppHandle) {
    STAGE.store(CLEANING, Ordering::SeqCst);
    crate::transfers::shutdown(&app.state::<AppState>(), CLEANUP_LIMIT).await;
    // WP-E4: drives unmount; their waiting uploads carry on next start
    crate::mount::shutdown(app, CLEANUP_LIMIT).await;
    // what couldn't be aborted in time stays written down for the next start
    crate::leftovers::save();
    STAGE.store(LEAVING, Ordering::SeqCst);
}

/// The exit after [`clean_up`] didn't happen (an update's installer wouldn't start): the app
/// carries on, and quitting works as usual again.
pub fn stay() {
    STAGE.store(RUNNING, Ordering::SeqCst);
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
        assert_eq!(question_with_drives(0, 0, 2), "2 files on drives are still waiting to upload. They'll upload next time you open Kybl. Quit anyway?");
        assert_eq!(
            question_with_drives(1, 0, 1),
            "1 transfer is still running. Also, 1 file on a drive is still waiting to upload (they'll upload next time you open Kybl). Quit anyway?"
        );
    }
}
