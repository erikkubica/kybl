//! Copies of remote files made to hand them to another app: "Open", "Open with" and Copy,
//! drag-out, custom actions (`actions/<run>/`) and "Open in…" on phones (`share/<id>/`).
//!
//! They live in `<cache>/open/<run>/`, a folder of this running Kybl's own (see `instance_dir`):
//! a second copy of the app never touches them, and a start removes only what ended runs left.
//! A run that sits in the tray for weeks trims what nobody touched for [`KEEP`], and Settings'
//! "Clear cache" counts them and removes what wasn't touched in the last [`IN_USE`].

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager, Runtime};

const DIR: &str = "open";
/// Folders whose children are each one copy (a custom action's run, a file shared on a phone).
const GROUPS: [&str; 2] = ["actions", "share"];
/// A copy nobody opened, changed or fetched again in this long is removed while running.
pub const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);
/// "Clear cache" leaves copies touched this recently: another app may have them open, or a
/// download into them is still under way.
pub const IN_USE: Duration = Duration::from_secs(3600);
/// Trimming runs at most this often.
const TRIM_EVERY: Duration = Duration::from_secs(3600);
static LAST_TRIM: AtomicU64 = AtomicU64::new(0);

fn base<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(DIR))
}

/// This run's folder (made private, claimed on first use: that also removes what ended runs
/// left). Blocking.
fn claim(base: &Path) -> Result<PathBuf, String> {
    crate::instance_dir::claim(base).map_err(|e| format!("Couldn't create a temporary folder: {e}"))
}

/// This run's folder for copies; now and then trims old ones in the background.
pub async fn folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = base(app)?;
    let dir = tokio::task::spawn_blocking(move || claim(&base)).await.map_err(|e| e.to_string())??;
    let now = secs(SystemTime::now());
    let last = LAST_TRIM.load(Ordering::SeqCst);
    if now.saturating_sub(last) >= TRIM_EVERY.as_secs() && LAST_TRIM.compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || trim(&dir, KEEP, SystemTime::now()));
    }
    Ok(dir)
}

/// Bytes this run's copies take: (all, the part "Clear cache" keeps as in use).
pub async fn usage<R: Runtime>(app: &AppHandle<R>) -> (u64, u64) {
    let Ok(base) = base(app) else { return (0, 0) };
    tokio::task::spawn_blocking(move || claim(&base).map(|d| split_usage(&entries(&d), SystemTime::now())).unwrap_or((0, 0))).await.unwrap_or((0, 0))
}

/// (all bytes, bytes touched within [`IN_USE`]): the same line [`trim`] draws for "Clear cache".
fn split_usage(entries: &[(PathBuf, SystemTime, u64)], now: SystemTime) -> (u64, u64) {
    entries.iter().fold((0, 0), |(all, kept), (_, touched, bytes)| {
        let in_use = now.duration_since(*touched).unwrap_or_default() < IN_USE;
        (all + bytes, kept + if in_use { *bytes } else { 0 })
    })
}

/// Removes this run's copies not touched in the last [`IN_USE`]; answers the bytes freed.
pub async fn clear<R: Runtime>(app: &AppHandle<R>) -> u64 {
    let Ok(base) = base(app) else { return 0 };
    tokio::task::spawn_blocking(move || claim(&base).map(|d| trim(&d, IN_USE, SystemTime::now())).unwrap_or(0)).await.unwrap_or(0)
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Each copy below `dir`: (path, last touched, bytes). A copy is a folder (or file) directly in
/// `dir`, or one in a [`GROUPS`] folder; last touched is the newest time of anything in it.
fn entries(dir: &Path) -> Vec<(PathBuf, SystemTime, u64)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let path = e.path();
        let is_group = GROUPS.iter().any(|g| e.file_name() == *g) && e.file_type().is_ok_and(|t| t.is_dir());
        if is_group {
            for c in std::fs::read_dir(&path).into_iter().flatten().flatten() {
                out.push(measure(c.path()));
            }
        } else {
            out.push(measure(path));
        }
    }
    out
}

fn measure(path: PathBuf) -> (PathBuf, SystemTime, u64) {
    let mut newest = SystemTime::UNIX_EPOCH;
    let mut bytes = 0;
    for e in walkdir::WalkDir::new(&path).follow_links(false).into_iter().flatten() {
        let Ok(m) = e.metadata() else { continue };
        if let Ok(t) = m.modified() {
            newest = newest.max(t);
        }
        if m.is_file() {
            bytes += m.len();
        }
    }
    (path, newest, bytes)
}

/// Removes the copies below `dir` not touched for `older` (as of `now`); answers the bytes freed.
fn trim(dir: &Path, older: Duration, now: SystemTime) -> u64 {
    let mut freed = 0;
    for (path, touched, bytes) in entries(dir) {
        if now.duration_since(touched).unwrap_or_default() < older {
            continue;
        }
        let gone = match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(&path),
            Ok(_) => std::fs::remove_file(&path),
            Err(e) => Err(e),
        };
        if gone.is_ok() {
            freed += bytes;
        }
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aged(p: &Path, age: Duration) {
        let t = SystemTime::now() - age;
        let f = std::fs::File::options().read(true).open(p).unwrap();
        f.set_modified(t).unwrap();
    }

    #[test]
    fn copies_nobody_touched_for_long_go_and_recent_ones_stay() {
        let base = std::env::temp_dir().join(format!("kybl-open-{}", uuid::Uuid::new_v4().simple()));
        let dir = claim(&base).unwrap();
        let day = Duration::from_secs(24 * 3600);
        // an Open copy from weeks ago, one opened today, a custom action run and a phone share
        for (rel, age) in [("old1/a.mp4", 30 * day), ("new1/b.pdf", Duration::ZERO), ("actions/r1/x.txt", 30 * day), ("actions/r2/y.txt", Duration::ZERO), ("share/s1/z.jpg", 30 * day)] {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"12345").unwrap();
            aged(&p, age);
            for d in [p.parent().unwrap().to_path_buf(), p.parent().unwrap().parent().unwrap().to_path_buf()] {
                if d != dir {
                    aged(&d, age);
                }
            }
        }
        // an old folder with one file still being written to counts as in use
        std::fs::create_dir_all(dir.join("mixed")).unwrap();
        std::fs::write(dir.join("mixed/old.bin"), b"1").unwrap();
        aged(&dir.join("mixed/old.bin"), 30 * day);
        std::fs::write(dir.join("mixed/new.part"), b"2").unwrap();

        assert_eq!(entries(&dir).iter().map(|e| e.2).sum::<u64>(), 27);
        let freed = trim(&dir, KEEP, SystemTime::now());
        assert_eq!(freed, 15);
        assert!(!dir.join("old1").exists() && !dir.join("actions/r1").exists() && !dir.join("share/s1").exists());
        assert!(dir.join("new1/b.pdf").exists() && dir.join("actions/r2/y.txt").exists() && dir.join("mixed/old.bin").exists());
        // Settings counts what is left as in use now, and as clearable an hour later
        assert_eq!(split_usage(&entries(&dir), SystemTime::now()), (12, 12));
        assert_eq!(split_usage(&entries(&dir), SystemTime::now() + IN_USE + Duration::from_secs(60)), (12, 0));
        // "Clear cache" an hour and a bit later: the rest goes
        assert_eq!(trim(&dir, IN_USE, SystemTime::now() + IN_USE + Duration::from_secs(60)), 12);
        assert!(entries(&dir).iter().all(|e| e.2 == 0));
        crate::instance_dir::clear(&base);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_second_run_never_removes_a_running_ones_copies() {
        let base = std::env::temp_dir().join(format!("kybl-open2-{}", uuid::Uuid::new_v4().simple()));
        // the first Kybl: its own folder, its lock held
        std::fs::create_dir_all(base.join("live/abc")).unwrap();
        std::fs::write(base.join("live/abc/report.pdf"), b"open in an editor").unwrap();
        let live = std::fs::File::create(base.join("live.lock")).unwrap();
        live.try_lock().unwrap();
        // an older version's shared layout
        std::fs::create_dir_all(base.join("deadbeef")).unwrap();
        std::fs::write(base.join("deadbeef/old.txt"), b"x").unwrap();

        let mine = claim(&base).unwrap();
        assert!(base.join("live/abc/report.pdf").exists(), "the running copy's file was deleted");
        assert!(!base.join("deadbeef").exists());
        assert_ne!(mine, base.join("live"));
        drop(live);
        crate::instance_dir::clear(&base);
        let _ = std::fs::remove_dir_all(base);
    }
}
