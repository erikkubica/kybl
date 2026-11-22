//! Engine tests: this device's disk to this device's disk, no network. Two folders served as two
//! connections, so files stream through the engine as they would between providers.

use std::{
    collections::HashMap,
    ops::Range,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

use async_trait::async_trait;
use futures_util::StreamExt;

use super::*;
use crate::storage::{
    local::LocalBackend, Capabilities, ConnKind, Entry, Loc, Page, Progress, ReadStream, RootInfo, RootKind, SResult, Storage, WriteOpts, WriteOutcome, WriteSource,
};

// ---------------------------------------------------------------- fixtures

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tmp() -> Tmp {
    let p = std::env::temp_dir().join(format!("kybl-jobs-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&p).unwrap();
    Tmp(std::fs::canonicalize(&p).unwrap())
}

fn write(base: &Path, rel: &str, data: &[u8]) {
    let p = base.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, data).unwrap();
}

fn set_mtime(base: &Path, rel: &str, t: SystemTime) {
    std::fs::File::options().write(true).open(base.join(rel)).unwrap().set_modified(t).unwrap();
}

fn local(dir: &Path) -> (Arc<LocalBackend>, String) {
    let b = LocalBackend::with_roots(vec![("Test".into(), RootKind::Folder, dir.to_path_buf())], false);
    (Arc::new(b), dir.to_str().unwrap().to_string())
}

/// Named files under `dir` (a crashed write's hidden temporary files left out), with contents.
fn files(dir: &Path) -> HashMap<String, Vec<u8>> {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && !e.file_name().to_string_lossy().contains(".kybl-"))
        .map(|e| (e.path().strip_prefix(dir).unwrap().to_string_lossy().replace('\\', "/"), std::fs::read(e.path()).unwrap()))
        .collect()
}

#[derive(Default)]
struct TestHost {
    conns: Mutex<HashMap<String, Arc<dyn Storage>>>,
    events: Mutex<Vec<(Instant, JobProgress)>>,
}

impl TestHost {
    fn with(conns: Vec<(&str, Arc<dyn Storage>)>) -> Arc<Self> {
        Arc::new(Self { conns: Mutex::new(conns.into_iter().map(|(k, v)| (k.to_string(), v)).collect()), events: Default::default() })
    }
}

#[async_trait]
impl Host for TestHost {
    async fn open(&self, profile_id: &str) -> SResult<Arc<dyn Storage>> {
        self.conns.lock().unwrap().get(profile_id).cloned().ok_or_else(|| StorageError::other("no such connection"))
    }
    fn emit(&self, p: &JobProgress) {
        self.events.lock().unwrap().push((Instant::now(), p.clone()));
    }
}

/// A connection that wraps another, slowing reads down and optionally damaging writes.
struct Wrapped {
    inner: Arc<LocalBackend>,
    /// pause per chunk read
    delay: Duration,
    /// drop the last byte of every file written
    truncate: bool,
}

#[async_trait]
impl Storage for Wrapped {
    fn kind(&self) -> ConnKind {
        ConnKind::Local
    }
    fn caps(&self) -> &Capabilities {
        self.inner.caps()
    }
    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        self.inner.roots().await
    }
    async fn list(&self, root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        self.inner.list(root, dir, token).await
    }
    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>> {
        self.inner.stat(root, path).await
    }
    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        let mut r = self.inner.read(root, path, range, if_match).await?;
        let delay = self.delay;
        if !delay.is_zero() {
            r.body = Box::pin(r.body.then(move |c| async move {
                tokio::time::sleep(delay).await;
                c
            }));
        }
        Ok(r)
    }
    async fn write(&self, root: &str, path: &str, src: WriteSource, opts: WriteOpts<'_>, progress: Progress<'_>, cancel: &Arc<AtomicBool>) -> SResult<WriteOutcome> {
        let src = match src {
            WriteSource::Stream { len, body, reopen } if self.truncate => {
                let mut all = Vec::new();
                let mut body = body;
                while let Some(c) = body.next().await {
                    all.extend_from_slice(&c?);
                }
                all.pop();
                WriteSource::Stream { len: len.map(|l| l.saturating_sub(1)), body: Box::pin(futures_util::stream::iter([Ok(bytes::Bytes::from(all))])), reopen }
            }
            s => s,
        };
        self.inner.write(root, path, src, opts, progress, cancel).await
    }
    async fn mkdir(&self, root: &str, dir: &str) -> SResult<()> {
        self.inner.mkdir(root, dir).await
    }
    async fn delete(&self, root: &str, files: &[String], dirs: &[String], cancel: &AtomicBool, on_progress: &(dyn Fn(u64, u64) + Send + Sync)) -> SResult<(u64, u64)> {
        self.inner.delete(root, files, dirs, cancel, on_progress).await
    }
    async fn copy(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        self.inner.copy(from, to, is_dir).await
    }
    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        self.inner.rename(from, to, is_dir).await
    }
    fn local_path(&self, root: &str, path: &str) -> Option<PathBuf> {
        self.inner.local_path(root, path)
    }
}

fn wrapped(dir: &Path, delay_ms: u64, truncate: bool) -> (Arc<dyn Storage>, String) {
    let (b, root) = local(dir);
    (Arc::new(Wrapped { inner: b, delay: Duration::from_millis(delay_ms), truncate }), root)
}

fn spec(src_root: &str, items: &[(&str, bool)], dst_root: &str, dir: &str) -> JobSpec {
    JobSpec {
        id: String::new(),
        mode: JobMode::Copy,
        src: Source { profile_id: "src".into(), root: src_root.into(), items: items.iter().map(|(p, d)| SelItem { path: p.to_string(), is_dir: *d }).collect() },
        dst: Dest { profile_id: "dst".into(), root: dst_root.into(), dir: dir.into() },
        conflict: Conflict::SkipIdentical,
        verify: Verify::Hash,
        preserve_mtime: false,
        ignore: vec![],
        title: String::new(),
    }
}

fn find(m: &JobManager, id: &str) -> JobSummary {
    m.list().unwrap().into_iter().find(|j| j.id == id).expect("the job is listed")
}

/// Waits until the job satisfies `ok` (and its runner has stopped when `idle`).
async fn wait_for(m: &JobManager, id: &str, idle: bool, ok: impl Fn(&JobSummary) -> bool) -> JobSummary {
    let start = Instant::now();
    loop {
        let j = find(m, id);
        if ok(&j) && (!idle || !m.is_running(id)) {
            return j;
        }
        assert!(start.elapsed() < Duration::from_secs(60), "timed out; last: {:?}", j.progress);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn finished(m: &JobManager, id: &str) -> JobSummary {
    wait_for(m, id, true, |j| j.progress.state.is_finished()).await
}

// ---------------------------------------------------------------- tests

#[test]
fn copies_a_whole_tree_with_empty_folders_and_ignores() {
    tauri::async_runtime::block_on(async {
        let (s, d) = (tmp(), tmp());
        write(&s.0, "a.txt", b"hello");
        write(&s.0, "docs/b.md", b"# b");
        write(&s.0, "docs/deep/c.bin", &vec![7u8; 300_000]);
        write(&s.0, "node_modules/x/index.js", b"x");
        write(&s.0, "docs/scratch.tmp", b"tmp");
        std::fs::create_dir_all(s.0.join("empty/inner")).unwrap();
        let (src, sr) = local(&s.0);
        let (dst, dr) = local(&d.0);
        let host = TestHost::with(vec![("src", src), ("dst", dst)]);
        let m = JobManager::open(None, host.clone()).unwrap();
        let mut sp = spec(&sr, &[("", true)], &dr, "backup");
        sp.ignore = vec!["node_modules/".into(), "*.tmp".into()];
        let id = m.create(sp).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!(j.progress.state, JobState::Done);
        assert_eq!((j.progress.files_done, j.progress.files_total, j.progress.files_failed), (3, 3, 0));
        assert_eq!(j.progress.bytes_done, 300_008);
        assert_eq!(j.title, "Copy everything");
        let got = files(&d.0);
        assert_eq!(got.len(), 3, "{:?}", got.keys());
        assert_eq!(got["backup/a.txt"], b"hello");
        assert_eq!(got["backup/docs/deep/c.bin"], vec![7u8; 300_000]);
        assert!(d.0.join("backup/empty/inner").is_dir(), "empty folders come along");
        assert!(!d.0.join("backup/node_modules").exists());
        // progress went out, at most every 250 ms apart from state changes
        let ev = host.events.lock().unwrap();
        assert!(ev.iter().any(|(_, p)| p.state == JobState::Planning));
        assert_eq!(ev.last().unwrap().1.state, JobState::Done);
        assert_eq!(ev.last().unwrap().1.phase, Phase::Finished);
        // a second run finds everything already there
        drop(ev);
        let id2 = m.create(spec(&sr, &[("", true)], &dr, "backup")).unwrap();
        let j2 = finished(&m, &id2).await;
        // (without the ignore list this time, the two files it left out are copied now)
        assert_eq!((j2.progress.files_skipped, j2.progress.files_done), (3, 2));
    });
}

#[test]
fn selected_files_and_folders_land_under_their_own_names() {
    tauri::async_runtime::block_on(async {
        let (s, d) = (tmp(), tmp());
        write(&s.0, "x/photos/1.jpg", b"one");
        write(&s.0, "x/photos/2/2.jpg", b"two");
        write(&s.0, "x/note.txt", b"note");
        let (src, sr) = local(&s.0);
        let (dst, dr) = local(&d.0);
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let id = m.create(spec(&sr, &[("x/photos/", true), ("x/note.txt", false)], &dr, "")).unwrap();
        assert_eq!(finished(&m, &id).await.progress.files_done, 3);
        let got = files(&d.0);
        assert_eq!(got.keys().cloned().collect::<std::collections::BTreeSet<_>>(), ["note.txt", "photos/1.jpg", "photos/2/2.jpg"].map(String::from).into());
    });
}

#[test]
fn conflict_policies() {
    tauri::async_runtime::block_on(async {
        let old = SystemTime::now() - Duration::from_secs(3600);
        let older = SystemTime::now() - Duration::from_secs(7200);
        for (policy, expect) in [
            (Conflict::SkipIdentical, [("same.txt", "SAME"), ("diff.txt", "source"), ("newer.txt", "source")]),
            (Conflict::Skip, [("same.txt", "SAME"), ("diff.txt", "dest!!"), ("newer.txt", "dest!")]),
            (Conflict::Overwrite, [("same.txt", "SAME"), ("diff.txt", "source"), ("newer.txt", "source")]),
            (Conflict::NewerWins, [("same.txt", "SAME"), ("diff.txt", "source"), ("newer.txt", "dest!")]),
            (Conflict::KeepBoth, [("same.txt", "SAME"), ("diff.txt", "dest!!"), ("newer.txt", "dest!")]),
        ] {
            let (s, d) = (tmp(), tmp());
            write(&s.0, "same.txt", b"SAME");
            write(&s.0, "diff.txt", b"source");
            write(&s.0, "newer.txt", b"source");
            set_mtime(&s.0, "same.txt", older);
            set_mtime(&s.0, "diff.txt", old);
            set_mtime(&s.0, "newer.txt", older);
            // same size and not older: the same file
            write(&d.0, "same.txt", b"SAME");
            // different size, older than the source
            write(&d.0, "diff.txt", b"dest!!");
            set_mtime(&d.0, "diff.txt", older);
            // different, and changed after the source
            write(&d.0, "newer.txt", b"dest!");
            let (src, sr) = local(&s.0);
            let (dst, dr) = local(&d.0);
            let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
            let mut sp = spec(&sr, &[("", true)], &dr, "");
            sp.conflict = policy;
            let id = m.create(sp).unwrap();
            let j = finished(&m, &id).await;
            assert_eq!(j.progress.files_failed, 0, "{policy:?}");
            let got = files(&d.0);
            for (name, content) in expect {
                assert_eq!(String::from_utf8_lossy(&got[name]), content, "{policy:?} {name}");
            }
            if policy == Conflict::KeepBoth {
                assert_eq!(got["diff (1).txt"], b"source");
                assert_eq!(got["newer (1).txt"], b"source");
                assert!(!got.contains_key("same (1).txt"), "the same file isn't copied twice");
                assert_eq!((j.progress.files_done, j.progress.files_skipped), (2, 1));
            } else {
                assert_eq!(got.len(), 3, "{policy:?}: {:?}", got.keys());
            }
            if policy == Conflict::Overwrite {
                // same size and time but no hashes to prove it: replaced anyway
                assert_eq!(j.progress.files_done, 3);
            }
        }
    });
}

#[test]
fn a_move_deletes_originals_only_after_their_copies_check_out() {
    tauri::async_runtime::block_on(async {
        // a good destination: everything moves, emptied folders go too
        let (s, d) = (tmp(), tmp());
        write(&s.0, "m/a.txt", b"aaa");
        write(&s.0, "m/sub/b.txt", &vec![1u8; 100_000]);
        std::fs::create_dir_all(s.0.join("m/empty")).unwrap();
        write(&s.0, "keep.txt", b"not selected");
        let (src, sr) = local(&s.0);
        let (dst, dr) = local(&d.0);
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let mut sp = spec(&sr, &[("m/", true)], &dr, "in");
        sp.mode = JobMode::Move;
        let id = m.create(sp).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!((j.progress.state, j.progress.files_done, j.progress.files_failed), (JobState::Done, 2, 0));
        assert_eq!(files(&d.0)["in/m/sub/b.txt"], vec![1u8; 100_000]);
        assert!(d.0.join("in/m/empty").is_dir());
        assert!(!s.0.join("m").exists(), "the moved folder is gone: {:?}", files(&s.0));
        assert!(s.0.join("keep.txt").exists());

        // a destination that damages files: nothing verifies, so every original stays
        let (s, d) = (tmp(), tmp());
        write(&s.0, "m/a.txt", b"aaa");
        write(&s.0, "m/b.txt", b"bbbb");
        let (src, sr) = local(&s.0);
        let (dst, dr) = wrapped(&d.0, 0, true);
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let mut sp = spec(&sr, &[("m/", true)], &dr, "");
        sp.mode = JobMode::Move;
        let id = m.create(sp).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!((j.progress.state, j.progress.files_done, j.progress.files_failed), (JobState::Done, 0, 2));
        assert_eq!(files(&s.0).len(), 2, "originals kept");
        assert!(files(&d.0).is_empty(), "bad copies removed");
        let f = m.failures(&id, 0, 10).unwrap();
        assert_eq!(f.len(), 2);
        assert!(f[0].error.contains("different size"), "{}", f[0].error);
    });
}

#[test]
fn a_move_inside_one_connection_renames() {
    tauri::async_runtime::block_on(async {
        let (a, b) = (tmp(), tmp());
        write(&a.0, "f/x.txt", b"x");
        write(&a.0, "y.txt", b"y");
        let both = Arc::new(LocalBackend::with_roots(
            vec![("A".into(), RootKind::Folder, a.0.clone()), ("B".into(), RootKind::Folder, b.0.clone())],
            false,
        ));
        let m = JobManager::open(None, TestHost::with(vec![("src", both)])).unwrap();
        let mut sp = spec(a.0.to_str().unwrap(), &[("f/", true), ("y.txt", false)], b.0.to_str().unwrap(), "");
        sp.dst.profile_id = "src".into();
        sp.mode = JobMode::Move;
        let id = m.create(sp).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!(j.progress.files_done, 2);
        assert_eq!(files(&b.0).len(), 2);
        assert!(files(&a.0).is_empty());
        assert!(!a.0.join("f").exists());
        // copying a folder into itself is refused up front
        let mut bad = spec(a.0.to_str().unwrap(), &[("g/", true)], a.0.to_str().unwrap(), "g/h");
        bad.dst.profile_id = "src".into();
        assert!(m.create(bad).unwrap_err().contains("into itself"));
    });
}

#[test]
fn resumes_after_a_crash_without_duplicates() {
    tauri::async_runtime::block_on(async {
        let (s, d, state) = (tmp(), tmp(), tmp());
        let mut want = HashMap::new();
        for i in 0..30 {
            let data: Vec<u8> = (0..(40_000 + i * 997)).map(|b| (b % 251) as u8 ^ i as u8).collect();
            write(&s.0, &format!("set/f{i:02}.bin"), &data);
            want.insert(format!("set/f{i:02}.bin"), data);
        }
        let db_path = state.0.join("jobs.db");
        let (dst, dr) = local(&d.0);
        // slow reads: 256 KiB chunks, so each file is one chunk and takes ~40 ms
        let (src, sr) = wrapped(&s.0, 40, false);
        let host = TestHost::with(vec![("src", src.clone()), ("dst", dst.clone())]);
        let m = JobManager::open(Some(&db_path), host).unwrap();
        let mut sp = spec(&sr, &[("set/", true)], &dr, "");
        sp.conflict = Conflict::KeepBoth; // any duplicate would show as "name (1)"
        let id = m.create(sp).unwrap();
        wait_for(&m, &id, false, |j| j.progress.files_done >= 6).await;
        m.crash();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mid = files(&d.0).len();
        assert!(mid < 30, "the crash came mid-job ({mid} copied)");
        drop(m);

        // the app starts again: the job picks up where the database says it was
        let (src2, _) = wrapped(&s.0, 0, false);
        let m = JobManager::open(Some(&db_path), TestHost::with(vec![("src", src2), ("dst", dst)])).unwrap();
        assert_eq!(find(&m, &id).progress.state, JobState::Running, "recorded as running");
        m.resume_all().unwrap();
        let j = finished(&m, &id).await;
        assert_eq!(j.progress.state, JobState::Done);
        assert_eq!(j.progress.files_failed, 0);
        assert_eq!(j.progress.files_done + j.progress.files_skipped, 30);
        assert_eq!(files(&d.0), want, "every file once, intact, nothing doubled");
    });
}

#[test]
fn planning_carries_on_from_the_saved_page() {
    tauri::async_runtime::block_on(async {
        let (s, d) = (tmp(), tmp());
        for i in 0..1500 {
            write(&s.0, &format!("big/{i:04}.txt"), b"x");
        }
        write(&s.0, "big/sub/z.txt", b"z");
        let (src, sr) = local(&s.0);
        let (_dst, dr) = local(&d.0);
        let conn = crate::db::open_in_memory(db::MIGRATIONS).unwrap();
        let dbh: Db = Arc::new(Mutex::new(conn));
        let sp = spec(&sr, &[("big/", true)], &dr, "");
        db::insert_job(&dbh.lock().unwrap(), "j", "{}", JobState::Planning).unwrap();
        // stopped right after the first page
        let stop = AtomicBool::new(false);
        let pages = std::sync::atomic::AtomicU32::new(0);
        let r = plan::plan(&*src, &sp, &dbh, "j", &stop, &|_, _| {
            if pages.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        })
        .await
        .unwrap();
        assert!(!r, "stopped");
        let partial = db::counts(&dbh.lock().unwrap(), "j").unwrap().files_total;
        assert!(partial > 0 && partial < 1501, "{partial}");
        assert!(db::job(&dbh.lock().unwrap(), "j").unwrap().unwrap().cursor_json.is_some());
        // a fresh start (after a restart) goes on from there
        let stop = AtomicBool::new(false);
        assert!(plan::plan(&*src, &sp, &dbh, "j", &stop, &|_, _| {}).await.unwrap());
        let n = db::counts(&dbh.lock().unwrap(), "j").unwrap();
        assert_eq!(n.files_total, 1501);
        assert!(db::job(&dbh.lock().unwrap(), "j").unwrap().unwrap().planned);
    });
}

#[test]
fn pause_resume_and_cancel() {
    tauri::async_runtime::block_on(async {
        let (s, d) = (tmp(), tmp());
        for i in 0..20 {
            write(&s.0, &format!("p/{i:02}.bin"), &vec![i as u8; 20_000]);
        }
        let (src, sr) = wrapped(&s.0, 60, false);
        let (dst, dr) = local(&d.0);
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let id = m.create(spec(&sr, &[("p/", true)], &dr, "")).unwrap();
        wait_for(&m, &id, false, |j| j.progress.files_done >= 2).await;
        m.pause(&id).unwrap();
        let j = wait_for(&m, &id, true, |j| j.progress.state == JobState::Paused).await;
        let at_pause = files(&d.0).len();
        assert!(j.progress.files_done < 20);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(files(&d.0).len(), at_pause, "nothing copies while paused");
        m.resume(&id).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!((j.progress.state, j.progress.files_done + j.progress.files_skipped), (JobState::Done, 20));
        assert_eq!(files(&d.0).len(), 20);

        // cancel: stops for good; what was copied stays
        let d2 = tmp();
        let (dst2, dr2) = local(&d2.0);
        let (src, _) = wrapped(&s.0, 60, false);
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst2)])).unwrap();
        let id = m.create(spec(&sr, &[("p/", true)], &dr2, "")).unwrap();
        wait_for(&m, &id, false, |j| j.progress.files_done >= 2).await;
        m.cancel(&id).unwrap();
        let j = wait_for(&m, &id, true, |j| j.progress.state == JobState::Cancelled).await;
        assert!(j.progress.files_done < 20);
        let left = files(&d2.0).len();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(files(&d2.0).len(), left);
        assert!(m.resume(&id).is_err(), "a cancelled job doesn't resume");
        m.delete(&id).unwrap();
        assert!(m.list().unwrap().is_empty());
    });
}

#[test]
fn failed_files_can_be_retried() {
    tauri::async_runtime::block_on(async {
        let (s, d) = (tmp(), tmp());
        write(&s.0, "r/a.txt", b"a");
        write(&s.0, "r/b.txt", b"b");
        let (src, sr) = local(&s.0);
        let (bad, dr) = wrapped(&d.0, 0, true);
        let host = TestHost::with(vec![("src", src), ("dst", bad)]);
        let m = JobManager::open(None, host.clone()).unwrap();
        let id = m.create(spec(&sr, &[("r/", true)], &dr, "")).unwrap();
        assert_eq!(finished(&m, &id).await.progress.files_failed, 2);
        // the destination is fixed; Try again copies the failed files
        let (good, _) = local(&d.0);
        host.conns.lock().unwrap().insert("dst".into(), good);
        m.retry_failed(&id).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!((j.progress.files_failed, j.progress.files_done), (0, 2));
        assert!(m.failures(&id, 0, 10).unwrap().is_empty());
    });
}
