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
        {
            let ev = host.events.lock().unwrap();
            assert!(ev.iter().any(|(_, p)| p.state == JobState::Planning));
            assert_eq!(ev.last().unwrap().1.state, JobState::Done);
            assert_eq!(ev.last().unwrap().1.phase, Phase::Finished);
            // never more than 4 a second outside state changes
            let running: Vec<Instant> = ev.iter().filter(|(_, p)| p.state == JobState::Running && p.phase == Phase::Copying).map(|(t, _)| *t).collect();
            let quick = running.windows(2).filter(|w| w[1] - w[0] < Duration::from_millis(200)).count();
            assert!(quick <= 2, "{quick} progress events came closer than 200 ms");
        }
        // a second run finds everything already there
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

        // Resume pressed while the pause is still winding down: it carries on anyway
        let d3 = tmp();
        let (dst3, dr3) = local(&d3.0);
        let (src3, _) = wrapped(&s.0, 60, false);
        let m3 = JobManager::open(None, TestHost::with(vec![("src", src3), ("dst", dst3)])).unwrap();
        let id3 = m3.create(spec(&sr, &[("p/", true)], &dr3, "")).unwrap();
        wait_for(&m3, &id3, false, |j| j.progress.files_done >= 1).await;
        m3.pause(&id3).unwrap();
        assert_eq!(find(&m3, &id3).progress.state, JobState::Paused, "shown as paused at once");
        m3.resume(&id3).unwrap();
        let j = finished(&m3, &id3).await;
        assert_eq!((j.progress.state, j.progress.files_done + j.progress.files_skipped), (JobState::Done, 20));

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

// ---------------------------------------------------------------- S3 (rclone serve s3)

/// A throwaway S3 server: `rclone serve s3` over a temporary folder (bucket `testbucket`), or
/// the server in `KYBL_TEST_S3_ENDPOINT` (keys testkey / testsecret). None when neither is there.
mod s3 {
    use super::*;
    use crate::state::{build_client, Profile};
    use crate::storage::{s3::S3Backend, s3_stream, PartRecord, Reopen, ResumeState};

    pub struct Server {
        child: Option<std::process::Child>,
        _dir: Option<Tmp>,
        pub endpoint: String,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            if let Some(c) = self.child.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    pub fn server() -> Option<Server> {
        if let Ok(endpoint) = std::env::var("KYBL_TEST_S3_ENDPOINT") {
            return Some(Server { child: None, _dir: None, endpoint });
        }
        let dir = tmp();
        std::fs::create_dir_all(dir.0.join("testbucket")).unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0").ok()?.local_addr().ok()?.port();
        let child = std::process::Command::new("rclone")
            .args(["serve", "s3", "--auth-key", "testkey,testsecret", "--addr", &format!("127.0.0.1:{port}")])
            .arg(&dir.0)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let server = Server { child: Some(child), _dir: Some(dir), endpoint: format!("http://127.0.0.1:{port}") };
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                return Some(server);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        None
    }

    pub fn backend(endpoint: &str) -> S3Backend {
        let p = Profile {
            id: "s3".into(),
            name: "s3".into(),
            provider: "custom".into(),
            endpoint: endpoint.into(),
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            path_style: true,
            ..Default::default()
        };
        S3Backend::new(build_client(&p, "testsecret"), &p)
    }

    fn data(n: usize, seed: u8) -> Vec<u8> {
        (0..n).map(|i| ((i * 31 + i / 7919) % 251) as u8 ^ seed).collect()
    }

    fn stream_of(d: &[u8], chunk: usize) -> crate::storage::ByteStream {
        let chunks: Vec<std::io::Result<bytes::Bytes>> = d.chunks(chunk).map(|c| Ok(bytes::Bytes::copy_from_slice(c))).collect();
        Box::pin(futures_util::stream::iter(chunks))
    }

    /// Opens `d` at any offset, one part's worth, counting the reads of each offset.
    fn reopen_of(d: Arc<Vec<u8>>, part: u64, reads: Arc<Mutex<HashMap<u64, u32>>>) -> Reopen {
        Box::new(move |off| {
            let (d, reads) = (d.clone(), reads.clone());
            Box::pin(async move {
                *reads.lock().unwrap().entry(off).or_default() += 1;
                let end = (off + part).min(d.len() as u64) as usize;
                Ok(stream_of(&d[off as usize..end], 100_000))
            })
        })
    }

    async fn get(s3: &S3Backend, key: &str) -> Vec<u8> {
        let mut out = s3.client().get_object().bucket("testbucket").key(key).send().await.unwrap();
        let mut back = Vec::new();
        while let Some(c) = out.body.try_next().await.unwrap() {
            back.extend_from_slice(&c);
        }
        back
    }

    fn no_progress(_: u64, _: u64) {}

    #[test]
    fn stream_uploads_arrive_intact_and_resume_from_confirmed_parts() {
        tauri::async_runtime::block_on(async move {
            let mock = super::super::mock_s3::start().await;
            let s3 = backend(&mock.endpoint);
            let never = Arc::new(AtomicBool::new(false));
            let run = uuid::Uuid::new_v4().to_string();

            // small, known length: one PUT with Content-MD5
            let small = data(1 << 20, 1);
            let k = format!("{run}/small.bin");
            let r = s3_stream::upload_stream(&s3, "testbucket", &k, Some(small.len() as u64), stream_of(&small, 70_000), None, WriteOpts::default(), &no_progress, &never)
                .await
                .unwrap();
            assert!(matches!(r, WriteOutcome::Done(e) if e.size == small.len() as i64));
            assert!(get(&s3, &k).await == small);

            // unknown length, short: still one PUT
            let k = format!("{run}/unknown.bin");
            let r = s3_stream::upload_stream(&s3, "testbucket", &k, None, stream_of(&small, 70_000), None, WriteOpts::default(), &no_progress, &never).await.unwrap();
            assert!(matches!(r, WriteOutcome::Done(_)));
            assert!(get(&s3, &k).await == small);

            // big, read once in order: multipart, every part with Content-MD5
            let big = Arc::new(data(40 << 20, 2));
            let k = format!("{run}/sequential.bin");
            let seen = Mutex::new(Vec::new());
            let r = s3_stream::upload_stream(
                &s3,
                "testbucket",
                &k,
                Some(big.len() as u64),
                stream_of(&big, 256 << 10),
                None,
                WriteOpts::default(),
                &|d, t| {
                    assert_eq!(t, big.len() as u64);
                    seen.lock().unwrap().push(d)
                },
                &never,
            )
            .await
            .unwrap();
            assert!(matches!(r, WriteOutcome::Done(e) if e.size == big.len() as i64));
            assert!(get(&s3, &k).await == *big);
            assert_eq!(*seen.lock().unwrap().last().unwrap(), big.len() as u64);

            // parallel ranged parts, stopped after the first part lands, then resumed
            let part = s3_stream::part_size(Some(big.len() as u64));
            let k = format!("{run}/resumed.bin");
            let reads = Arc::new(Mutex::new(HashMap::new()));
            let saved: Mutex<Option<ResumeState>> = Mutex::new(None);
            let stop = Arc::new(AtomicBool::new(false));
            let on_part = |p: PartRecord| {
                let mut s = saved.lock().unwrap();
                if p.number == 0 {
                    *s = Some(ResumeState { upload_id: p.etag, part_size: p.size, parts: vec![] });
                } else {
                    s.as_mut().unwrap().parts.push(p);
                    stop.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            };
            let empty = || -> crate::storage::ByteStream { Box::pin(futures_util::stream::empty()) };
            let opts = WriteOpts { part_size: Some(part), parts_in_flight: 1, on_part: Some(&on_part), ..Default::default() };
            let r = s3_stream::upload_stream(&s3, "testbucket", &k, Some(big.len() as u64), empty(), Some(reopen_of(big.clone(), part, reads.clone())), opts, &no_progress, &stop)
                .await
                .unwrap();
            assert!(matches!(r, WriteOutcome::Cancelled));
            let rs = saved.lock().unwrap().clone().expect("the upload was announced");
            assert!(!rs.parts.is_empty(), "a part landed before the stop");
            // the tracked upload was left open for resuming: carry on
            let opts = WriteOpts { part_size: Some(part), resume: Some(rs.clone()), on_part: Some(&on_part), ..Default::default() };
            let fresh = Arc::new(AtomicBool::new(false));
            let r = s3_stream::upload_stream(&s3, "testbucket", &k, Some(big.len() as u64), empty(), Some(reopen_of(big.clone(), part, reads.clone())), opts, &no_progress, &fresh)
                .await
                .unwrap();
            assert!(matches!(r, WriteOutcome::Done(_)));
            assert!(get(&s3, &k).await == *big);
            {
                let reads = reads.lock().unwrap();
                for p in &rs.parts {
                    let off = (p.number as u64 - 1) * part;
                    assert_eq!(reads.get(&off), Some(&1), "part {} was read once, not again after resuming", p.number);
                }
            }

            // cancelled without tracking: aborted, nothing left behind
            let k = format!("{run}/cancelled.bin");
            let stopped = Arc::new(AtomicBool::new(true));
            let r = s3_stream::upload_stream(&s3, "testbucket", &k, Some(big.len() as u64), stream_of(&big, 1 << 20), None, WriteOpts::default(), &no_progress, &stopped)
                .await
                .unwrap();
            assert!(matches!(r, WriteOutcome::Cancelled));
            assert!(s3.client().head_object().bucket("testbucket").key(&k).send().await.is_err());

            let st = mock.state.lock().unwrap();
            assert_eq!(st.without_md5, 0, "every PUT and UploadPart carried a Content-MD5");
            assert_eq!(st.bad_digests, 0);
            assert!(st.uploads.is_empty(), "nothing left open: finished, or aborted when untracked");
        });
    }

    /// Single-request uploads and listing against a real S3 server implementation (rclone), when
    /// it is installed.
    #[test]
    fn rclone_takes_content_md5_uploads() {
        let Some(srv) = server() else { return eprintln!("skipped: rclone not installed and KYBL_TEST_S3_ENDPOINT not set") };
        tauri::async_runtime::block_on(async move {
            let s3 = backend(&srv.endpoint);
            let never = Arc::new(AtomicBool::new(false));
            let small = data(3 << 20, 4);
            let r = s3_stream::upload_stream(&s3, "testbucket", "r/small.bin", Some(small.len() as u64), stream_of(&small, 70_000), None, WriteOpts::default(), &no_progress, &never)
                .await
                .unwrap();
            assert!(matches!(r, WriteOutcome::Done(e) if e.size == small.len() as i64));
            assert!(get(&s3, "r/small.bin").await == small);

            let (s, back) = (tmp(), tmp());
            write(&s.0, "t/a.txt", b"hello");
            write(&s.0, "t/sub/b.bin", &data(200_000, 5));
            let (src, sr) = local(&s.0);
            let (dst_back, br) = local(&back.0);
            let s3: Arc<dyn Storage> = Arc::new(s3);
            let m = JobManager::open(None, TestHost::with(vec![("src", src), ("s3", s3.clone()), ("back", dst_back)])).unwrap();
            let mut up = spec(&sr, &[("t/", true)], "testbucket", "up/");
            up.dst.profile_id = "s3".into();
            let id = m.create(up).unwrap();
            let j = finished(&m, &id).await;
            assert_eq!((j.progress.files_done, j.progress.files_failed), (2, 0), "{:?}", m.failures(&id, 0, 5));
            let mut down = spec("testbucket", &[("up/t/", true)], &br, "");
            down.src.profile_id = "s3".into();
            down.dst.profile_id = "back".into();
            let id = m.create(down).unwrap();
            let j = finished(&m, &id).await;
            assert_eq!((j.progress.files_done, j.progress.files_failed), (2, 0), "{:?}", m.failures(&id, 0, 5));
            assert_eq!(files(&back.0)["t/sub/b.bin"], data(200_000, 5));
        });
    }

    #[test]
    fn a_job_copies_this_device_into_s3_and_back() {
        tauri::async_runtime::block_on(async move {
            let mock = super::super::mock_s3::start().await;
            let (s, back) = (tmp(), tmp());
            write(&s.0, "t/a.txt", b"hello");
            write(&s.0, "t/big/b.bin", &data(20 << 20, 3));
            std::fs::create_dir_all(s.0.join("t/empty")).unwrap();
            let (src, sr) = local(&s.0);
            let (dst_back, br) = local(&back.0);
            let s3: Arc<dyn Storage> = Arc::new(backend(&mock.endpoint));
            let m = JobManager::open(None, TestHost::with(vec![("src", src), ("s3", s3.clone()), ("back", dst_back)])).unwrap();
            let run = format!("{}/", uuid::Uuid::new_v4());
            let mut up = spec(&sr, &[("t/", true)], "testbucket", &run);
            up.dst.profile_id = "s3".into();
            let id = m.create(up).unwrap();
            let j = finished(&m, &id).await;
            assert_eq!((j.progress.state, j.progress.files_done, j.progress.files_failed), (JobState::Done, 2, 0), "{:?}", m.failures(&id, 0, 5));
            assert!(s3.stat("testbucket", &format!("{run}t/empty/")).await.unwrap().is_some(), "an empty folder gets a marker");

            // and back down, flat-listed from S3, with the move deleting the objects
            let mut down = spec("testbucket", &[(&format!("{run}t/"), true)], &br, "");
            down.src.profile_id = "s3".into();
            down.dst.profile_id = "back".into();
            down.mode = JobMode::Move;
            let id = m.create(down).unwrap();
            let j = finished(&m, &id).await;
            assert_eq!((j.progress.files_done, j.progress.files_failed), (2, 0), "{:?}", m.failures(&id, 0, 5));
            assert_eq!(files(&back.0)["t/big/b.bin"], data(20 << 20, 3));
            assert!(back.0.join("t/empty").is_dir());
            assert!(s3.stat("testbucket", &format!("{run}t/a.txt")).await.unwrap().is_none(), "moved out of S3");
        });
    }
}
