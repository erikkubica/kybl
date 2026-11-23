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

        // only the capitals changed there: here too, also where the disk ignores case (the
        // new name "exists" there, as the same file)
        fs::rename(p.r("moved.txt"), p.r("Moved.txt")).unwrap();
        let r = p.twoway().await;
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(r.summary, "1 renamed");
        assert_eq!(files(&p.local), vec!["Moved.txt", "new/name.txt"]);
        assert_eq!(p.twoway().await.summary, "");
    });
}

#[test]
fn a_push_only_replaces_the_remote_file_the_plan_saw() {
    let r = |etag: &str, modified: i64| RemoteMeta { size: 7, etag: etag.into(), modified, id: None, md5: None };
    assert_eq!(push_precondition(None), Precondition::IfNoneMatch);
    assert_eq!(push_precondition(Some(&r("e1", 5))), Precondition::IfMatch("e1".into()));
    // no ETag: never an unconditional overwrite
    assert_eq!(push_precondition(Some(&r("", 5000))), Precondition::IfUnchanged { etag: None, size: 7, modified: Some(5000) });
    assert_eq!(push_precondition(Some(&r("", 0))), Precondition::IfUnchanged { etag: None, size: 7, modified: None });
}

#[test]
fn a_rename_never_lands_on_another_file() {
    let d = tmp("same");
    write(&d.join("a.txt"), "a");
    write(&d.join("b.txt"), "b");
    assert!(!local::same_entry(&d.join("a.txt"), &d.join("b.txt")));
    assert!(local::same_entry(&d.join("a.txt"), &d.join("a.txt")));
    // a second name for one file (a hard link) is another name, not a change of capitals
    fs::hard_link(d.join("a.txt"), d.join("link.txt")).unwrap();
    assert!(!local::same_entry(&d.join("a.txt"), &d.join("link.txt")));
    if fs::metadata(d.join("A.TXT")).is_ok() {
        assert!(local::same_entry(&d.join("a.txt"), &d.join("A.TXT")), "where case doesn't count");
    }
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_rename_with_an_edit_is_an_upload_and_a_trashed_original() {
    run(async {
        let p = pair().await;
        write(&p.l("a.txt"), "first");
        p.twoway().await;
        fs::rename(p.l("a.txt"), p.l("b.txt")).unwrap();
        fs::write(p.l("b.txt"), "first, then edited").unwrap();
        let r = p.twoway().await;
        assert_eq!(r.summary, "1 uploaded · 1 deleted");
        assert_eq!(files(&p.remote_dir), vec!["b.txt"]);
        assert_eq!(read(&p.remote_dir.join(REMOTE_TRASH).join(local::ymd(now_ms())).join("a.txt")), "first");
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

        // held deletions here came from the other side's changes: that listing isn't handled
        let handled = p.db.cursor("m").unwrap().last_full_scan;
        assert!(handled.is_some());
        for n in 0..40 {
            fs::remove_file(p.r(&format!("f{:03}.txt", n + 60))).unwrap();
        }
        assert_eq!(p.twoway().await.pending, 40);
        assert_eq!(p.db.cursor("m").unwrap().last_full_scan, handled, "read again until confirmed");
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

#[cfg(unix)]
fn set_mode(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(p, fs::Permissions::from_mode(mode)).unwrap();
}

#[cfg(unix)]
#[test]
fn a_run_with_problems_doesnt_mark_the_other_side_handled() {
    run(async {
        let p = pair().await;
        write(&p.l("locked/a.txt"), "a");
        // the other side changed under the folder this computer can't read: left alone, so the
        // next quick run must not start from this listing
        write(&p.r("locked/b.txt"), "b");
        set_mode(&p.l("locked"), 0o000);
        let r = p.engine(Arc::new(AtomicBool::new(false)), &noop).twoway(true, None).await.unwrap();
        set_mode(&p.l("locked"), 0o755);
        assert!(!r.errors.is_empty());
        assert_eq!(p.db.cursor("m").unwrap().last_full_scan, None, "the next quick run doesn't start from this listing");
        let r = p.engine(Arc::new(AtomicBool::new(false)), &noop).twoway(true, None).await.unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(p.db.cursor("m").unwrap().last_full_scan.is_some());
    });
}

#[cfg(unix)]
#[test]
fn a_standing_notice_alone_doesnt_hold_the_other_side_back() {
    run(async {
        // B4-2: an unreadable folder the other side didn't touch is a notice, not a failure of
        // the run: the listing still counts as handled, so quick runs don't re-read it forever
        let p = pair().await;
        write(&p.l("locked/a.txt"), "a");
        write(&p.l("open.txt"), "o");
        p.twoway().await;
        set_mode(&p.l("locked"), 0o000);
        let r = p.engine(Arc::new(AtomicBool::new(false)), &noop).twoway(true, None).await.unwrap();
        set_mode(&p.l("locked"), 0o755);
        assert!(r.errors.iter().any(|e| e.contains("couldn't read locked")), "{:?}", r.errors);
        let first = p.db.cursor("m").unwrap().last_full_scan;
        assert!(first.is_some());
        std::thread::sleep(std::time::Duration::from_millis(5));
        set_mode(&p.l("locked"), 0o000);
        let r = p.engine(Arc::new(AtomicBool::new(false)), &noop).twoway(true, None).await.unwrap();
        set_mode(&p.l("locked"), 0o755);
        assert!(!r.errors.is_empty());
        assert_ne!(p.db.cursor("m").unwrap().last_full_scan, first, "this listing counts as handled too");
    });
}

#[cfg(unix)]
#[test]
fn a_folder_that_cant_be_read_is_left_alone_not_deleted() {
    run(async {
        let p = pair().await;
        write(&p.l("locked/a.txt"), "a");
        write(&p.l("open.txt"), "o");
        p.twoway().await;
        assert_eq!(files(&p.remote_dir), vec!["locked/a.txt", "open.txt"]);

        // this computer's copy can't be listed: the other side keeps everything in it
        set_mode(&p.l("locked"), 0o000);
        let e = p.engine(Arc::new(AtomicBool::new(false)), &noop);
        let r = e.twoway(true, None).await.unwrap();
        set_mode(&p.l("locked"), 0o755);
        assert_eq!(r.summary, "");
        assert_eq!(r.pending, 0);
        assert!(r.errors.iter().any(|e| e.contains("couldn't read locked")), "{:?}", r.errors);
        assert_eq!(files(&p.remote_dir), vec!["locked/a.txt", "open.txt"]);
        assert_eq!(p.db.load_base("m").unwrap().len(), 2, "the base rows stay for the next run");
        // and the same for an upload that mirrors deletions
        set_mode(&p.l("locked"), 0o000);
        let r = e.upload(true, None).await.unwrap();
        set_mode(&p.l("locked"), 0o755);
        assert!(!r.summary.contains("deleted"), "{}", r.summary);
        assert_eq!(files(&p.remote_dir), vec!["locked/a.txt", "open.txt"]);

        // the other side's copy can't be listed: the run stops rather than delete anything here
        set_mode(&p.r("locked"), 0o000);
        let res = e.twoway(true, None).await;
        set_mode(&p.r("locked"), 0o755);
        assert!(res.is_err(), "{res:?}");
        assert_eq!(files(&p.local), vec!["locked/a.txt", "open.txt"]);
    });
}

#[test]
fn the_remote_trash_keeps_every_version_deleted_the_same_day() {
    run(async {
        let p = pair().await;
        write(&p.l("a.txt"), "first");
        write(&p.l("b.txt"), "keep");
        write(&p.l("c.txt"), "keep");
        p.twoway().await;
        fs::remove_file(p.l("a.txt")).unwrap();
        assert_eq!(p.twoway().await.summary, "1 deleted");
        write(&p.l("a.txt"), "second");
        p.twoway().await;
        fs::remove_file(p.l("a.txt")).unwrap();
        assert_eq!(p.twoway().await.summary, "1 deleted");
        let day = local::ymd(now_ms());
        let trash = p.remote_dir.join(REMOTE_TRASH).join(&day);
        assert_eq!(read(&trash.join("a.txt")), "first");
        assert_eq!(read(&trash.join("a (2).txt")), "second");
        assert_eq!(numbered("t/d/x.tar.gz", 3), "t/d/x.tar (3).gz");
        assert_eq!(numbered("t/d/.env", 2), "t/d/.env (2)");
    });
}

#[cfg(unix)]
#[test]
fn downloads_never_write_through_a_linked_folder() {
    run(async {
        // S2-1: `work` here is a link to a folder outside the synced one; the scan doesn't
        // follow it, so `work/report.txt` on the other side looks new here
        let p = pair().await;
        let outside = tmp("outside");
        write(&outside.join("keep.txt"), "mine");
        std::os::unix::fs::symlink(&outside, p.local.join("work")).unwrap();
        write(&p.r("work/report.txt"), "theirs");
        write(&p.r("ok.txt"), "ok");
        let r = p.engine(Arc::new(AtomicBool::new(false)), &noop).twoway(true, None).await.unwrap();
        assert!(r.errors.iter().any(|e| e.contains("is a link")), "{:?}", r.errors);
        assert_eq!(read(&p.l("ok.txt")), "ok");
        assert!(!outside.join("report.txt").exists(), "nothing written outside the synced folder");
        let r = p.engine(Arc::new(AtomicBool::new(false)), &noop).download().await.unwrap();
        assert!(r.errors.iter().any(|e| e.contains("is a link")), "{:?}", r.errors);
        assert!(!outside.join("report.txt").exists());
        assert_eq!(read(&outside.join("keep.txt")), "mine");
        assert!(local::link_on_the_way(&p.local, &p.local.join("a/b.txt")).is_none(), "folders not made yet are fine");
        assert!(local::link_on_the_way(&p.local, &outside.join("x")).is_some(), "outside the folder");
        let _ = fs::remove_dir_all(&outside);
    });
}
