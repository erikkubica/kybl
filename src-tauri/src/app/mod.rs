//! The app around the files: menu bar, tray, quitting, updates, app-level preferences, per-run
//! cache folders and what phones need.

// the macOS menu bar
#[cfg(target_os = "macos")]
pub mod menu;
#[cfg(desktop)]
pub mod tray;
// asking before quitting with transfers running
#[cfg(desktop)]
pub mod quit;
// update checks and installs from GitHub Releases
pub mod updater;
pub mod prefs;
pub mod instance_dir;
pub mod mobile;
