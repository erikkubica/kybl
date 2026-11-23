//! Cache folders that belong to one running Kybl.
//!
//! Nothing stops a second copy of the app from running (`open -n`, Windows, Linux), so a start-up
//! sweep of a shared cache folder could delete files the first copy is still using (an edit copy
//! with unsaved changes, an archive being read). Each run therefore works in a folder of its own,
//! `<base>/<pid>-<random>/`, next to a lock file `<base>/<pid>-<random>.lock` it keeps locked
//! while it runs. A start removes the folders whose lock nobody holds any more (a run that ended
//! or crashed) and the folders left by older versions (no lock file at all).

use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime},
};

const LOCK: &str = "lock";
/// A lock file this new may be one another run just made and is about to lock: left alone.
const YOUNG: Duration = Duration::from_secs(10);

/// base → (this run's folder, its held lock file)
static HELD: LazyLock<Mutex<HashMap<PathBuf, (PathBuf, File)>>> = LazyLock::new(Default::default);

#[cfg(unix)]
fn private(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn private(_dir: &Path) {}

/// This run's own folder below `base` (made private to this user), claimed on first use. The
/// first claim also removes what ended runs left below `base`.
pub fn claim(base: &Path) -> io::Result<PathBuf> {
    claim_adopting(base, |_, _| true)
}

/// [`claim`], handing each folder an ended run left to `adopt(this run's folder, that folder)`
/// before it is removed, so what has to outlive a run (the list of what it left on servers) can
/// be taken over into this run's folder first. `adopt` returning false keeps that folder for a
/// later start. This run's folder and lock exist before the sweep, so what `adopt` writes into
/// it is never lost to a crash in between.
pub fn claim_adopting(base: &Path, mut adopt: impl FnMut(&Path, &Path) -> bool) -> io::Result<PathBuf> {
    let mut held = HELD.lock().unwrap();
    if let Some((dir, _)) = held.get(base) {
        std::fs::create_dir_all(dir)?;
        return Ok(dir.clone());
    }
    std::fs::create_dir_all(base)?;
    private(base);
    let name = format!("{}-{}", std::process::id(), &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(base.join(format!("{name}.{LOCK}")))?;
    lock.try_lock().map_err(|e| io::Error::other(e.to_string()))?;
    let dir = base.join(&name);
    std::fs::create_dir_all(&dir)?;
    private(&dir);
    sweep_adopting(base, Some(&name), &mut |gone| adopt(&dir, gone));
    held.insert(base.to_path_buf(), (dir.clone(), lock));
    Ok(dir)
}

/// Empties this run's folder below `base` (quitting). It is made again on the next use.
pub fn clear(base: &Path) {
    if let Some((dir, _)) = HELD.lock().unwrap().get(base) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Removes the folders below `base` that no running Kybl holds (`own`: a name to keep regardless).
#[cfg(test)]
fn sweep(base: &Path, own: Option<&str>) {
    sweep_adopting(base, own, &mut |_| true);
}

/// [`sweep`], asking `adopt` about each folder first (false: it stays for a later start).
fn sweep_adopting(base: &Path, own: Option<&str>, adopt: &mut dyn FnMut(&Path) -> bool) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    let mut locks = vec![];
    let mut dirs = vec![];
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if own == Some(name.as_str()) {
            continue;
        }
        match name.strip_suffix(&format!(".{LOCK}")) {
            Some(stem) => locks.push((stem.to_string(), e.path())),
            None => dirs.push((name, e.path())),
        }
    }
    let now = SystemTime::now();
    for (stem, path) in &locks {
        if own == Some(stem.as_str()) {
            continue;
        }
        let Ok(f) = OpenOptions::new().read(true).write(true).open(path) else { continue };
        let young = f.metadata().and_then(|m| m.modified()).is_ok_and(|t| now.duration_since(t).unwrap_or_default() < YOUNG);
        if f.try_lock().is_err() || young {
            continue;
        }
        // still locked here while it is taken over, so no other start takes it over as well
        let gone = base.join(stem);
        if gone.is_dir() && !adopt(&gone) {
            continue;
        }
        let _ = std::fs::remove_dir_all(&gone);
        drop(f);
        let _ = std::fs::remove_file(path);
    }
    // a folder (or file) without a lock file: an older version's layout, or a run that is gone
    for (name, path) in dirs {
        if locks.iter().any(|(stem, _)| *stem == name) {
            continue;
        }
        if path.is_dir() {
            if !adopt(&path) {
                continue;
            }
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_keeps_running_instances_folders_and_removes_ended_ones() {
        let base = std::env::temp_dir().join(format!("kybl-instance-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&base).unwrap();
        // a live run: holds its lock
        std::fs::create_dir_all(base.join("live/s")).unwrap();
        std::fs::write(base.join("live/s/copy.txt"), "unsaved").unwrap();
        let live = File::create(base.join("live.lock")).unwrap();
        live.try_lock().unwrap();
        // an ended run: lock file nobody holds (old enough not to be one being made)
        std::fs::create_dir_all(base.join("dead/s")).unwrap();
        let dead = File::create(base.join("dead.lock")).unwrap();
        dead.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        drop(dead);
        // an older version's layout: no lock file at all
        std::fs::create_dir_all(base.join("connection-id/session")).unwrap();

        // what a second instance's start does (the live lock is held by another handle)
        sweep(&base, None);
        assert!(base.join("live/s/copy.txt").exists(), "a running instance's copy was deleted");
        assert!(!base.join("dead").exists() && !base.join("dead.lock").exists());
        assert!(!base.join("connection-id").exists());

        // once the first instance ends, the next start cleans up after it
        drop(live);
        std::fs::File::options().write(true).open(base.join("live.lock")).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        sweep(&base, None);
        assert!(!base.join("live").exists());

        let mine = claim(&base).unwrap();
        assert!(mine.is_dir() && mine.parent() == Some(base.as_path()));
        assert_eq!(claim(&base).unwrap(), mine);
        clear(&base);
        assert!(!mine.exists());
        std::fs::remove_dir_all(&base).ok();
    }
}
