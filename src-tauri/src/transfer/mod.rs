//! Moving files: the transfer queue, its resume list, multipart uploads, checks after a
//! copy, where downloads land, what interrupted transfers leave behind, the background notice
//! and the transfer settings.

pub mod queue;
// paused and interrupted transfers kept across a restart
pub mod resume;
// parallel, resumable multipart uploads
pub mod multipart;
// checking a file once it was uploaded or downloaded (size, checksums)
pub mod verify;
// where downloads land: safe paths and free names
pub mod dest;
// uploads and partial downloads an earlier run left behind (killed, crashed): cleaned at start
pub mod leftovers;
pub mod notice;
// transfer settings and the bandwidth cap
pub mod tuning;
