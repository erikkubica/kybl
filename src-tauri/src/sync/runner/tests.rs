//! The runner between two local folders: the second one, opened through `LocalBackend`, plays
//! the other side, so every path (scan, plan, transfers, renames, deletes, the base) runs for real.

use super::*;
use crate::storage::{local::LocalBackend, RootKind};
use std::fs;

struct Pair {
    local: PathBuf,
    remote_dir: PathBuf,
    remote: Arc<dyn Storage>,
    root: String,
    db: SyncDb,
}

impl Drop for Pair {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.local);
        let _ = fs::remove_dir_all(&self.remote_dir);
    }
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("kybl-sync-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&d).unwrap();
    fs::canonicalize(d).unwrap()
}

async fn pair() -> Pair {
    let (local, remote_dir) = (tmp("local"), tmp("remote"));
    // no system Trash in tests: deletions on the "remote" folder remove files
    let backend = LocalBackend::with_roots(vec![("remote".into(), RootKind::Folder, remote_dir.clone())], false);
    let root = backend.roots().await.unwrap()[0].id.clone();
    Pair { local, remote_dir, remote: Arc::new(backend), root, db: SyncDb::in_memory() }
}

fn noop(_: Tick) {}

impl Pair {
    fn engine<'a>(&'a self, cancel: Arc<AtomicBool>, report: &'a (dyn Fn(Tick) + Send + Sync)) -> Engine<'a> {
        Engine {
            id: "m".into(),
            local_root: self.local.clone(),
            remote: self.remote.clone(),
            root: self.root.clone(),
            prefix: String::new(),
            ignore: vec!["*.tmp".into(), ".DS_Store".into()],
            mirror_deletes: true,
            remote_trash: true,
            delete_guard: true,
            local_trash: false,
            db: &self.db,
            cancel,
            report,
        }
    }

    async fn twoway(&self) -> RunResult {
        let r = self.engine(Arc::new(AtomicBool::new(false)), &noop).twoway(true, None).await.unwrap();
        assert!(r.errors.is_empty() || r.pending > 0, "{:?}", r.errors);
        r
    }

    fn l(&self, rel: &str) -> PathBuf {
        local_path_of(&self.local, rel)
    }
    fn r(&self, rel: &str) -> PathBuf {
        local_path_of(&self.remote_dir, rel)
    }
}

fn write(p: &Path, body: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
}

fn read(p: &Path) -> String {
    fs::read_to_string(p).unwrap_or_else(|_| panic!("{} is missing", p.display()))
}

/// Every file below `dir` (not the remote trash), sorted.
fn files(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = walkdir::WalkDir::new(dir)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().strip_prefix(dir).unwrap().to_string_lossy().replace('\\', "/"))
        .filter(|p| !p.starts_with(".kybl-trash/"))
        .collect();
    v.sort();
    v
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap().block_on(f)
}

#[test]
fn a_first_two_way_run_merges_both_folders() {
    run(async {
        let p = pair().await;
        write(&p.l("mine.txt"), "mine");
        write(&p.l("deep/a/b.txt"), "deep");
        write(&p.l("skip.tmp"), "ignored");
        write(&p.r("theirs.txt"), "theirs");
        write(&p.l("both.txt"), "same");
        write(&p.r("both.txt"), "same");
        let r = p.twoway().await;
        assert_eq!(r.summary, "2 uploaded · 1 downloaded");
        assert_eq!(files(&p.local), vec!["both.txt", "deep/a/b.txt", "mine.txt", "skip.tmp", "theirs.txt"]);
        assert_eq!(files(&p.remote_dir), vec!["both.txt", "deep/a/b.txt", "mine.txt", "theirs.txt"]);
        assert_eq!(r.files, 4);
        // the downloaded file carries the remote file's time
        let (lm, rm) = (fs::metadata(p.l("theirs.txt")).unwrap(), fs::metadata(p.r("theirs.txt")).unwrap());
        assert_eq!(local::mtime_ms(&lm), local::mtime_ms(&rm));
        // and the uploaded one this file's time
        let (lm, rm) = (fs::metadata(p.l("mine.txt")).unwrap(), fs::metadata(p.r("mine.txt")).unwrap());
        assert_eq!(local::mtime_ms(&lm), local::mtime_ms(&rm));
        // nothing changed: nothing to do
        assert_eq!(p.twoway().await.summary, "");
    });
}

#[test]
fn edits_and_deletions_go_both_ways() {
    run(async {
        let p = pair().await;
        for n in 0..5 {
            write(&p.l(&format!("f{n}.txt")), "v1");
        }
        p.twoway().await;
        write(&p.l("f0.txt"), "edited here");
        write(&p.r("f1.txt"), "edited there");
        fs::remove_file(p.l("f2.txt")).unwrap();
        fs::remove_file(p.r("f3.txt")).unwrap();
        let r = p.twoway().await;
        assert_eq!(r.summary, "1 uploaded · 1 downloaded · 2 deleted");
        assert_eq!(read(&p.r("f0.txt")), "edited here");
        assert_eq!(read(&p.l("f1.txt")), "edited there");
        assert_eq!(files(&p.local), vec!["f0.txt", "f1.txt", "f4.txt"]);
        assert_eq!(files(&p.remote_dir), vec!["f0.txt", "f1.txt", "f4.txt"]);
        // the remote deletion went to the remote trash folder, by date
        let trashed = p.remote_dir.join(REMOTE_TRASH).join(local::ymd(now_ms())).join("f2.txt");
        assert_eq!(read(&trashed), "v1");
        assert_eq!(r.files, 3);
        assert_eq!(p.twoway().await.summary, "");
        // tombstones remember both deletions
        assert_eq!(p.db.tombstones("m").unwrap().len(), 2);
    });
}

#[test]
fn edits_on_both_sides_keep_both_versions() {
    run(async {
        let p = pair().await;
        write(&p.l("doc/report.txt"), "v1");
        p.twoway().await;
        write(&p.l("doc/report.txt"), "my version");
        write(&p.r("doc/report.txt"), "their longer version");
        let r = p.twoway().await;
        assert_eq!(r.summary, "1 conflict kept as copies");
        assert_eq!(r.conflicts, 1);
        let c = p.db.conflicts("m").unwrap();
        let copy = c[0].copy.clone();
        assert!(copy.starts_with("doc/report (conflict ") && copy.ends_with(").txt"), "{copy}");
        // the other side's version kept the name; this computer's is the copy, on both sides
        assert_eq!(read(&p.l("doc/report.txt")), "their longer version");
        assert_eq!(read(&p.l(&copy)), "my version");
        assert_eq!(read(&p.r(&copy)), "my version");
        assert_eq!(read(&p.r("doc/report.txt")), "their longer version");
        assert_eq!(p.twoway().await.summary, "");

        // keeping the original removes the copy here, and the next run removes it there
        resolve_conflict(&p.db, "m", &p.local, &copy, "original", false).unwrap();
        assert!(p.db.conflicts("m").unwrap().is_empty());
        assert_eq!(p.twoway().await.summary, "1 deleted");
        assert_eq!(files(&p.remote_dir), vec!["doc/report.txt"]);
    });
}

#[test]
fn keeping_this_computers_version_sends_it_over() {
    run(async {
        let p = pair().await;
        write(&p.l("a.txt"), "v1");
        p.twoway().await;
        write(&p.l("a.txt"), "mine");
        write(&p.r("a.txt"), "theirs!");
        p.twoway().await;
        let copy = p.db.conflicts("m").unwrap()[0].copy.clone();
        resolve_conflict(&p.db, "m", &p.local, &copy, "copy", false).unwrap();
        let r = p.twoway().await;
        assert_eq!(r.summary, "1 uploaded · 1 deleted");
        assert_eq!(read(&p.r("a.txt")), "mine");
        assert_eq!(files(&p.remote_dir), vec!["a.txt"]);
    });
}

#[test]
fn renames_stay_renames_on_both_sides() {
    run(async {
        let p = pair().await;
        write(&p.l("old/name.txt"), "content");
        write(&p.l("other.txt"), "other");
        p.twoway().await;
        let inode_before = local::file_id(&fs::metadata(p.r("old/name.txt")).unwrap());

        // renamed here: renamed there (the same file, not a new upload)
        fs::create_dir_all(p.l("new")).unwrap();
        fs::rename(p.l("old/name.txt"), p.l("new/name.txt")).unwrap();
        let r = p.twoway().await;
        assert_eq!(r.summary, "1 renamed");
        assert_eq!(files(&p.remote_dir), vec!["new/name.txt", "other.txt"]);
        assert_eq!(local::file_id(&fs::metadata(p.r("new/name.txt")).unwrap()), inode_before);

        // renamed there: renamed here
        fs::rename(p.r("other.txt"), p.r("moved.txt")).unwrap();
        let r = p.twoway().await;
        assert_eq!(r.summary, "1 renamed");
        assert_eq!(files(&p.local), vec!["moved.txt", "new/name.txt"]);
        assert_eq!(p.twoway().await.summary, "");
    });
}

#[test]
fn a_rename_with_an_edit_is_a_rename_and_an_upload() {
    run(async {
        let p = pair().await;
        write(&p.l("a.txt"), "first");
        p.twoway().await;
        fs::rename(p.l("a.txt"), p.l("b.txt")).unwrap();
        fs::write(p.l("b.txt"), "first, then edited").unwrap();
        let r = p.twoway().await;
        if cfg!(unix) {
            assert_eq!(r.summary, "1 uploaded · 1 renamed");
        }
        assert_eq!(files(&p.remote_dir), vec!["b.txt"]);
        assert_eq!(read(&p.r("b.txt")), "first, then edited");
    });
}

#[test]
fn mass_deletions_wait_for_a_confirmation() {
    run(async {
        let p = pair().await;
        for n in 0..100 {
            write(&p.l(&format!("f{n:03}.txt")), "x");
        }
        p.twoway().await;
        for n in 0..60 {
            fs::remove_file(p.l(&format!("f{n:03}.txt"))).unwrap();
        }
        let r = p.twoway().await;
        assert_eq!(r.pending, 60);
        assert_eq!(r.errors.len(), 1, "{:?}", r.errors);
        assert!(r.errors[0].contains("confirm"), "{}", r.errors[0]);
        assert_eq!(files(&p.remote_dir).len(), 100, "nothing deleted while held");
        assert_eq!(p.db.pending("m").unwrap().len(), 60);

        // "Keep the files": they come back here
        p.db.restore_pending("m").unwrap();
        let r = p.twoway().await;
        assert_eq!(r.summary, "60 downloaded");
        assert_eq!(files(&p.local).len(), 100);

        // deleted again and confirmed: they go
        for n in 0..60 {
            fs::remove_file(p.l(&format!("f{n:03}.txt"))).unwrap();
        }
        assert_eq!(p.twoway().await.pending, 60);
        p.db.set_confirm("m", true).unwrap();
        let r = p.twoway().await;
        assert_eq!(r.summary, "60 deleted");
        assert_eq!(r.pending, 0);
        assert_eq!(files(&p.remote_dir).len(), 40);
        assert!(!p.db.cursor("m").unwrap().confirm_deletes, "a confirmation is used once");
    });
}

#[test]
fn an_emptied_folder_never_empties_the_other_side() {
    run(async {
        let p = pair().await;
        write(&p.l("a.txt"), "a");
        write(&p.l("b.txt"), "b");
        p.twoway().await;
        fs::remove_file(p.l("a.txt")).unwrap();
        fs::remove_file(p.l("b.txt")).unwrap();
        let r = p.twoway().await;
        assert_eq!(r.pending, 2);
        assert!(r.errors[0].starts_with("The folder on this computer is empty"), "{}", r.errors[0]);
        assert_eq!(files(&p.remote_dir), vec!["a.txt", "b.txt"]);
        // a missing folder is an error, not "everything was deleted"
        let gone = Engine { local_root: p.local.join("nope"), ..p.engine(Arc::new(AtomicBool::new(false)), &noop) };
        assert!(gone.twoway(true, None).await.is_err());
    });
}

#[test]
fn an_interrupted_run_carries_on_where_it_stopped() {
    run(async {
        let p = pair().await;
        for n in 0..12 {
            write(&p.l(&format!("f{n:02}.bin")), &"x".repeat(64 * 1024 + n));
        }
        // stop as soon as the first files are through
        let cancel = Arc::new(AtomicBool::new(false));
        let c = cancel.clone();
        let stop = move |t: Tick| {
            if t.done >= 2 {
                c.store(true, Ordering::Relaxed);
            }
        };
        let r = p.engine(cancel.clone(), &stop).twoway(true, None).await.unwrap();
        let first = r.files;
        assert!((2..12).contains(&first), "stopped part-way, after {first}");
        assert_eq!(p.db.cursor("m").unwrap().last_sync, None, "an interrupted run isn't a sync");
        // no partial file on either side, and what was done is remembered
        assert!(files(&p.remote_dir).iter().all(|f| !f.contains(".kybl-")));

        let r = p.twoway().await;
        assert_eq!(r.summary, format!("{} uploaded", 12 - first));
        assert_eq!(files(&p.remote_dir).len(), 12);
        assert!(p.db.conflicts("m").unwrap().is_empty(), "no conflicts from the restart");
        assert_eq!(p.twoway().await.summary, "");
    });
}

#[test]
fn a_quick_run_looks_only_at_what_changed_here() {
    run(async {
        let p = pair().await;
        write(&p.l("a.txt"), "a");
        p.twoway().await;
        // changed there and here; a quick run (after the watcher) only sends the local change
        write(&p.r("theirs.txt"), "new there");
        write(&p.l("b.txt"), "new here");
        let dirty = HashSet::from([p.l("b.txt")]);
        let r = p.engine(Arc::new(AtomicBool::new(false)), &noop).twoway(false, Some(dirty)).await.unwrap();
        assert_eq!(r.summary, "1 uploaded");
        assert!(!p.l("theirs.txt").exists());
        // the full run on the interval picks up the remote change
        assert_eq!(p.twoway().await.summary, "1 downloaded");
    });
}

#[test]
fn decomposed_names_meet_their_composed_twin() {
    run(async {
        let p = pair().await;
        // macOS hands out "é" as e + combining accent; the other side has it composed
        write(&p.l("cafe\u{301}.txt"), "same");
        write(&p.r("caf\u{e9}.txt"), "same");
        let r = p.twoway().await;
        assert_eq!(r.summary, "", "one file, not two");
        assert_eq!(r.files, 1);
        assert_eq!(files(&p.remote_dir).len(), 1);
    });
}

#[test]
fn one_way_modes_run_over_any_connection() {
    run(async {
        let p = pair().await;
        write(&p.l("a.txt"), "a");
        write(&p.l("sub/b.txt"), "b");
        let e = Engine { remote_trash: false, ..p.engine(Arc::new(AtomicBool::new(false)), &noop) };
        let r = e.upload(true, None).await.unwrap();
        assert_eq!(r.summary, "2 uploaded");
        fs::remove_file(p.l("sub/b.txt")).unwrap();
        assert_eq!(e.upload(false, None).await.unwrap().summary, "1 deleted on the other folder");
        assert_eq!(files(&p.remote_dir), vec!["a.txt"]);
        assert!(!p.remote_dir.join(REMOTE_TRASH).exists(), "one-way deletes for good unless asked");

        // a download mirror into a second folder keeps local edits as copies
        let mirror = tmp("mirror");
        let db = SyncDb::in_memory();
        let d = Engine { id: "d".into(), local_root: mirror.clone(), db: &db, ..p.engine(Arc::new(AtomicBool::new(false)), &noop) };
        assert_eq!(d.download().await.unwrap().summary, "1 downloaded");
        write(&mirror.join("a.txt"), "edited in the mirror");
        write(&p.r("a.txt"), "changed at the source");
        let r = d.download().await.unwrap();
        assert_eq!(r.summary, "1 downloaded · 1 edited file kept as local copies");
        assert_eq!(read(&mirror.join("a (local copy).txt")), "edited in the mirror");
        let _ = fs::remove_dir_all(&mirror);
    });
}
