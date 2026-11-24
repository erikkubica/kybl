//! Copies of remote files made to hand them to another app: "Open", "Open with" and Copy,
//! drag-out, custom actions (`actions/<run>/`) and "Open in…" on phones (`share/<id>/`).
//!
//! They live in `<cache>/open/<run>/`, a folder of this running Kybl's own (see `instance_dir`):
//! a second copy of the app never touches them, and what ended runs left is removed at a start
//! and once an hour (`leftovers`). A run that sits in the tray for weeks trims what nobody
//! touched for [`KEEP`]. Settings' "Clear cache" removes the rest, except copies that may still
//! be in use: handed to another app in this run ([`handed_out`]), read by a custom action that
//! is still running ([`in_use`]), or touched in the last [`IN_USE`].

use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager, Runtime};

const DIR: &str = "open";
/// Folders whose children are each one copy (a custom action's run, a file shared on a phone).
const GROUPS: [&str; 2] = ["actions", "share"];
/// A copy nobody opened, changed or fetched again in this long is removed while running.
pub const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);
/// "Clear cache" leaves copies touched (read or written) this recently: another app may have
/// them open (a viewer that rereads its file, a document not saved yet), or a download into them
/// is still under way.
pub const IN_USE: Duration = Duration::from_secs(24 * 3600);
/// Trimming runs at most this often.
const TRIM_EVERY: Duration = Duration::from_secs(3600);
static LAST_TRIM: AtomicU64 = AtomicU64::new(0);
/// Told to the page when copies were removed: a path it remembers for a file (drag-out, "Open
/// in…" on phones) may be gone, so it fetches the file again rather than hand over nothing.
const REMOVED_EVENT: &str = "open-copies-removed";

/// This run's folder, once claimed.
static RUN: OnceLock<PathBuf> = OnceLock::new();
/// Copies handed to another app in this run (opened, opened with, put on the clipboard, dragged
/// out, shared), by the copy (see [`entries`]): "Clear cache" leaves them while this run lasts.
static HANDED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);
/// Copies a custom action that is still running reads, with how many runs read each: never
/// removed, by "Clear cache" nor by the trim.
static READING: LazyLock<Mutex<HashMap<PathBuf, usize>>> = LazyLock::new(Default::default);

fn base<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(DIR))
}

/// This run's folder (made private, claimed on first use: that also removes what ended runs
/// left). Blocking.
fn claim(base: &Path) -> Result<PathBuf, String> {
    let dir = crate::instance_dir::claim(base).map_err(|e| format!("Couldn't create a temporary folder: {e}"))?;
    let _ = RUN.set(dir.clone());
    Ok(dir)
}

/// The copy (as [`entries`] lists them) `path` is in or is, if it is in this run's folder `run`.
fn copy_of(run: &Path, path: &Path) -> Option<PathBuf> {
    let rel = path.strip_prefix(run).ok()?;
    let mut parts = rel.components().filter(|c| !matches!(c, Component::CurDir));
    let first = match parts.next()? {
        Component::Normal(n) => n,
        _ => return None,
    };
    let mut copy = run.join(first);
    if GROUPS.iter().any(|g| first == *g) {
        match parts.next()? {
            Component::Normal(n) => copy.push(n),
            _ => return None,
        }
    }
    Some(copy)
}

/// `path` was handed to another app: if it is one of this run's copies, "Clear cache" leaves it
/// while this run lasts (the other app may read it again, or save into its folder).
pub fn handed_out(path: &str) {
    if let Some(copy) = RUN.get().and_then(|run| copy_of(run, Path::new(path))) {
        HANDED.lock().unwrap().insert(copy);
    }
}

/// Copies a running custom action reads, kept from removal until this is dropped.
pub struct InUse(Vec<PathBuf>);

impl Drop for InUse {
    fn drop(&mut self) {
        let mut reading = READING.lock().unwrap();
        for copy in &self.0 {
            if let Some(n) = reading.get_mut(copy) {
                *n -= 1;
                if *n == 0 {
                    reading.remove(copy);
                }
            }
        }
    }
}

/// Keeps the copies `paths` are in (those that are this run's) from removal while the answer lives.
pub fn in_use<'a>(paths: impl IntoIterator<Item = &'a str>) -> InUse {
    match RUN.get() {
        Some(run) => in_use_in(run, paths),
        None => InUse(Vec::new()),
    }
}

fn in_use_in<'a>(run: &Path, paths: impl IntoIterator<Item = &'a str>) -> InUse {
    let copies: HashSet<PathBuf> = paths.into_iter().filter_map(|p| copy_of(run, Path::new(p))).collect();
    let mut reading = READING.lock().unwrap();
    for c in &copies {
        *reading.entry(c.clone()).or_default() += 1;
    }
    InUse(copies.into_iter().collect())
}

fn reading(copy: &Path) -> bool {
    READING.lock().unwrap().contains_key(copy)
}

fn handed_or_reading(copy: &Path) -> bool {
    HANDED.lock().unwrap().contains(copy) || reading(copy)
}

/// This run's folder for copies; now and then trims old ones in the background.
pub async fn folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = base(app)?;
    let dir = tokio::task::spawn_blocking(move || claim(&base)).await.map_err(|e| e.to_string())??;
    let now = secs(SystemTime::now());
    let last = LAST_TRIM.load(Ordering::SeqCst);
    if now.saturating_sub(last) >= TRIM_EVERY.as_secs() && LAST_TRIM.compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        let (dir, app) = (dir.clone(), app.clone());
        tauri::async_runtime::spawn_blocking(move || {
            if trim(&dir, KEEP, SystemTime::now(), &reading).1 > 0 {
                let _ = app.emit(REMOVED_EVENT, ());
            }
        });
    }
    Ok(dir)
}

/// Bytes this run's copies take: (all, the part "Clear cache" keeps as in use).
pub async fn usage<R: Runtime>(app: &AppHandle<R>) -> (u64, u64) {
    let Ok(base) = base(app) else { return (0, 0) };
    tokio::task::spawn_blocking(move || claim(&base).map(|d| split_usage(&entries(&d), SystemTime::now(), &handed_or_reading)).unwrap_or((0, 0))).await.unwrap_or((0, 0))
}

/// (all bytes, bytes "Clear cache" keeps): the same line [`trim`] draws for it, touched within
/// [`IN_USE`] or kept by `spare` (handed to another app, read by a running action; B5-7).
fn split_usage(entries: &[(PathBuf, SystemTime, u64)], now: SystemTime, spare: &dyn Fn(&Path) -> bool) -> (u64, u64) {
    entries.iter().fold((0, 0), |(all, kept), (path, touched, bytes)| {
        let in_use = now.duration_since(*touched).unwrap_or_default() < IN_USE || spare(path);
        (all + bytes, kept + if in_use { *bytes } else { 0 })
    })
}

/// Removes this run's copies that can't be in use any more (see the module notes), and what runs
/// that ended left; answers the bytes freed.
pub async fn clear<R: Runtime>(app: &AppHandle<R>) -> u64 {
    let Ok(base) = base(app) else { return 0 };
    let (freed, removed) = tokio::task::spawn_blocking(move || {
        crate::instance_dir::sweep_ended_runs();
        claim(&base).map(|d| trim(&d, IN_USE, SystemTime::now(), &handed_or_reading)).unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    if removed > 0 {
        let _ = app.emit(REMOVED_EVENT, ());
    }
    freed
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Each copy below `dir`: (path, last touched, bytes). A copy is a folder (or file) directly in
/// `dir`, or one in a [`GROUPS`] folder; last touched is the newest time anything in it was
/// read or written.
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
        // a file's last read counts too (a viewer reading it again); a folder's doesn't: this
        // walk itself reads the folders
        let read = if m.is_file() { m.accessed().ok() } else { None };
        for t in [m.modified().ok(), read].into_iter().flatten() {
            newest = newest.max(t);
        }
        if m.is_file() {
            bytes += m.len();
        }
    }
    (path, newest, bytes)
}

/// Removes the copies below `dir` not touched for `older` (as of `now`), apart from those `spare`
/// keeps; answers the bytes freed and how many copies went.
fn trim(dir: &Path, older: Duration, now: SystemTime, spare: &dyn Fn(&Path) -> bool) -> (u64, usize) {
    let (mut freed, mut removed) = (0, 0);
    for (path, touched, bytes) in entries(dir) {
        if now.duration_since(touched).unwrap_or_default() < older || spare(&path) {
            continue;
        }
        let gone = match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(&path),
            Ok(_) => std::fs::remove_file(&path),
            Err(e) => Err(e),
        };
        if gone.is_ok() {
            freed += bytes;
            removed += 1;
        }
    }
    (freed, removed)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn aged(p: &Path, age: Duration) {
        let t = SystemTime::now() - age;
        let f = std::fs::File::options().read(true).open(p).unwrap();
        f.set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t)).unwrap();
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
        let (freed, removed) = trim(&dir, KEEP, SystemTime::now(), &|_| false);
        assert_eq!((freed, removed), (15, 3));
        assert!(!dir.join("old1").exists() && !dir.join("actions/r1").exists() && !dir.join("share/s1").exists());
        assert!(dir.join("new1/b.pdf").exists() && dir.join("actions/r2/y.txt").exists() && dir.join("mixed/old.bin").exists());
        // Settings counts what is left as in use now, and as clearable after the idle limit
        assert_eq!(split_usage(&entries(&dir), SystemTime::now(), &|_| false), (12, 12));
        assert_eq!(split_usage(&entries(&dir), SystemTime::now() + IN_USE + Duration::from_secs(60), &|_| false), (12, 0));
        // a copy "Clear cache" spares counts as in use however old (B5-7)
        let later = SystemTime::now() + IN_USE + Duration::from_secs(60);
        let new1: u64 = entries(&dir).iter().filter(|e| e.0.ends_with("new1")).map(|e| e.2).sum();
        assert!(new1 > 0);
        assert_eq!(split_usage(&entries(&dir), later, &|p: &Path| p.ends_with("new1")), (12, new1));
        // "Clear cache" a day and a bit later: the rest goes
        assert_eq!(trim(&dir, IN_USE, SystemTime::now() + IN_USE + Duration::from_secs(60), &|_| false).0, 12);
        assert!(entries(&dir).iter().all(|e| e.2 == 0));
        crate::instance_dir::clear(&base);
        let _ = std::fs::remove_dir_all(base);
    }

    /// "Clear cache" never removes a copy another app was handed in this run, or one a running
    /// custom action still reads, however long untouched (B5-4); the weekly trim spares the latter.
    #[test]
    fn copies_in_use_survive_clear_cache() {
        let run = std::env::temp_dir().join(format!("kybl-open3-{}", uuid::Uuid::new_v4().simple()));
        let day = Duration::from_secs(24 * 3600);
        for rel in ["viewed/movie.mp4", "dragged/a.txt", "idle/b.txt", "actions/r1/1.wav", "actions/r1/2.wav", "actions/r2/x.txt"] {
            let p = run.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"1").unwrap();
            aged(&p, 30 * day);
            aged(p.parent().unwrap(), 30 * day);
        }
        assert_eq!(copy_of(&run, &run.join("viewed/movie.mp4")), Some(run.join("viewed")));
        assert_eq!(copy_of(&run, &run.join("actions/r1/2.wav")), Some(run.join("actions/r1")));
        assert_eq!(copy_of(&run, &run.join("actions")), None, "a group folder is no copy");
        assert_eq!(copy_of(&run, Path::new("/elsewhere/movie.mp4")), None);
        let handed: HashSet<PathBuf> = [run.join("viewed/movie.mp4"), run.join("dragged/a.txt")].iter().filter_map(|p| copy_of(&run, p)).collect();
        let a = run.join("actions/r1/1.wav").to_string_lossy().into_owned();
        let action = in_use_in(&run, [a.as_str()]);
        let spare = |p: &Path| handed.contains(p) || reading(p);
        trim(&run, IN_USE, SystemTime::now(), &spare);
        assert!(run.join("viewed/movie.mp4").exists() && run.join("dragged/a.txt").exists(), "handed to another app in this run");
        assert!(run.join("actions/r1/2.wav").exists(), "the running action hasn't got to it yet");
        assert!(!run.join("idle").exists() && !run.join("actions/r2").exists());
        // the weekly trim spares what a running action reads, not what was handed out long ago
        trim(&run, KEEP, SystemTime::now(), &reading);
        assert!(!run.join("viewed").exists() && run.join("actions/r1").exists());
        drop(action);
        trim(&run, KEEP, SystemTime::now(), &reading);
        assert!(!run.join("actions/r1").exists(), "the action ended");
        let _ = std::fs::remove_dir_all(run);
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
