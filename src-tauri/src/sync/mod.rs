//! Folder sync between a local folder and a folder on any connection.
//!
//! * **Upload** mappings back a local folder up. The folder is watched, so changes go up a couple
//!   of seconds after they happen, and a full comparison with the other side runs on an interval.
//! * **Download** mappings keep a local mirror, checked on an interval (S3 can't push changes).
//! * **Two-way** mappings keep both sides the same: changes on either side go to the other,
//!   renames stay renames, edits on both sides keep both versions, deletions go to the Trash
//!   (locally, and in the provider's trash or `.kybl-trash/` remotely), and a run that would
//!   delete a lot stops and asks first. "Keep on this device" folders are two-way mappings.
//!
//! What each mapping knows between runs lives in sync.db (state.rs): both sides of every path
//! as they were at the last sync. That is what tells "deleted" from "never synced" and "changed
//! here" from "changed there".
//!
//! * `plan.rs`: the decisions, pure and platform-neutral (phone backup uses `plan_upload`)
//! * `runner.rs`: carries a plan out over any `Storage`
//! * `local.rs` / `remote.rs`: the two snapshots
//! * `state.rs`: sync.db
//! * `config.rs` / `manager.rs`: the mappings, their workers and the commands (desktop)

pub mod plan;

#[cfg(desktop)]
mod config;
#[cfg(desktop)]
pub mod local;
#[cfg(desktop)]
mod manager;
#[cfg(desktop)]
pub mod remote;
#[cfg(desktop)]
pub mod runner;
#[cfg(desktop)]
pub mod state;

#[cfg(desktop)]
pub use manager::*;

/// End-to-end tests against a real S3 endpoint (skipped without one).
#[cfg(all(test, desktop))]
mod tests;
