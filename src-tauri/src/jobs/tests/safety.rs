//! Moves must never delete the only copy of a file: a destination that is the source itself,
//! a file at the destination that only looks the same, two files landing on one name where case
//! doesn't count, a copy or original that changed before the original is deleted, folders
//! reached through links, servers that ignore ranges, and resumed uploads of a changed file.

use super::*;

/// Wraps this device's disk to look like another store: names folded to lowercase (like
/// OneDrive, on any test machine) and/or ranges ignored (the whole file comes back).
struct Twisted {
    inner: Arc<LocalBackend>,
    kind: ConnKind,
    fold: bool,
    no_ranges: bool,
}

impl Twisted {
    fn p(&self, path: &str) -> String {
        if self.fold { path.to_lowercase() } else { path.to_string() }
    }
}

#[async_trait]
impl Storage for Twisted {
    fn kind(&self) -> ConnKind {
        self.kind
    }
    fn caps(&self) -> &Capabilities {
        self.inner.caps()
    }
    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        self.inner.roots().await
    }
    async fn list(&self, root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        self.inner.list(root, &self.p(dir), token).await
    }
    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>> {
        self.inner.stat(root, &self.p(path)).await
    }
    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        if self.no_ranges {
            // like a server answering 200 with everything
            return self.inner.read(root, &self.p(path), None, if_match).await;
        }
        self.inner.read(root, &self.p(path), range, if_match).await
    }
    async fn write(&self, root: &str, path: &str, src: WriteSource, opts: WriteOpts<'_>, progress: Progress<'_>, cancel: &Arc<AtomicBool>) -> SResult<WriteOutcome> {
        self.inner.write(root, &self.p(path), src, opts, progress, cancel).await
    }
    async fn mkdir(&self, root: &str, dir: &str) -> SResult<()> {
        self.inner.mkdir(root, &self.p(dir)).await
    }
    async fn delete(&self, root: &str, files: &[String], dirs: &[String], cancel: &AtomicBool, on_progress: &(dyn Fn(u64, u64) + Send + Sync)) -> SResult<(u64, u64)> {
        let files: Vec<String> = files.iter().map(|f| self.p(f)).collect();
        let dirs: Vec<String> = dirs.iter().map(|f| self.p(f)).collect();
        self.inner.delete(root, &files, &dirs, cancel, on_progress).await
    }
    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        self.inner.rename(&Loc::new(&from.root, self.p(&from.path)), &Loc::new(&to.root, self.p(&to.path)), is_dir).await
    }
    fn local_path(&self, root: &str, path: &str) -> Option<PathBuf> {
        self.inner.local_path(root, &self.p(path))
    }
}

fn twisted(dir: &Path, kind: ConnKind, fold: bool, no_ranges: bool) -> (Arc<dyn Storage>, String) {
    let (b, root) = local(dir);
    (Arc::new(Twisted { inner: b, kind, fold, no_ranges }), root)
}

fn moving(mut sp: JobSpec) -> JobSpec {
    sp.mode = JobMode::Move;
    sp
}

fn read(base: &Path, rel: &str) -> Vec<u8> {
    std::fs::read(base.join(rel)).unwrap_or_default()
}

// ---------------------------------------------------------------- 1. the destination is the source

#[test]
fn a_move_onto_itself_keeps_the_file() {
    tauri::async_runtime::block_on(async {
        // two connections saved for the same folder
        let s = tmp();
        write(&s.0, "a.txt", b"only copy");
        let (one, r1) = local(&s.0);
        let (two, r2) = local(&s.0);
        let m = JobManager::open(None, TestHost::with(vec![("src", one), ("dst", two)])).unwrap();
        let id = m.create(moving(spec(&r1, &[("a.txt", false)], &r2, ""))).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!(read(&s.0, "a.txt"), b"only copy", "the file is still there");
        assert_eq!((j.progress.files_skipped, j.progress.files_failed), (1, 0));

        // one connection whose roots overlap (Home and Desktop): "sub/x.txt" of the outer root
        // is "x.txt" of the inner one
        let outer = tmp();
        write(&outer.0, "sub/x.txt", b"inner file");
        let both = Arc::new(LocalBackend::with_roots(
            vec![("Outer".into(), RootKind::Folder, outer.0.clone()), ("Inner".into(), RootKind::Folder, outer.0.join("sub"))],
            false,
        ));
        let m = JobManager::open(None, TestHost::with(vec![("src", both)])).unwrap();
        let mut sp = moving(spec(outer.0.to_str().unwrap(), &[("sub/x.txt", false)], outer.0.join("sub").to_str().unwrap(), ""));
        sp.dst.profile_id = "src".into();
        let id = m.create(sp).unwrap();
        finished(&m, &id).await;
        assert_eq!(read(&outer.0, "sub/x.txt"), b"inner file");

        // one root: an item that would land on itself is left out, the others move
        let s = tmp();
        write(&s.0, "a.txt", b"stays");
        write(&s.0, "d/b.txt", b"moves");
        let (one, r) = local(&s.0);
        let m = JobManager::open(None, TestHost::with(vec![("src", one)])).unwrap();
        let mut sp = moving(spec(&r, &[("a.txt", false), ("d/b.txt", false)], &r, ""));
        sp.dst.profile_id = "src".into();
        let id = m.create(sp).unwrap();
        finished(&m, &id).await;
        assert_eq!(read(&s.0, "a.txt"), b"stays");
        assert_eq!(read(&s.0, "b.txt"), b"moves");
        assert!(!s.0.join("d/b.txt").exists());
    });
}

#[test]
fn a_move_between_two_connections_to_one_bucket_keeps_the_object() {
    tauri::async_runtime::block_on(async {
        let mock = super::super::mock_s3::start().await;
        let a: Arc<dyn Storage> = Arc::new(super::s3::backend(&mock.endpoint));
        let b: Arc<dyn Storage> = Arc::new(super::s3::backend(&mock.endpoint));
        let run = uuid::Uuid::new_v4().to_string();
        let key = format!("{run}/k.txt");
        let src_dir = tmp();
        write(&src_dir.0, "k.txt", b"object");
        let (disk, dr) = local(&src_dir.0);
        let m = JobManager::open(None, TestHost::with(vec![("disk", disk), ("a", a.clone()), ("b", b)])).unwrap();
        let mut up = spec(&dr, &[("k.txt", false)], "testbucket", &format!("{run}/"));
        (up.src.profile_id, up.dst.profile_id) = ("disk".into(), "a".into());
        let id = m.create(up).unwrap();
        assert_eq!(finished(&m, &id).await.progress.files_failed, 0);

        let mut mv = moving(spec("testbucket", &[(&key, false)], "testbucket", &format!("{run}/")));
        (mv.src.profile_id, mv.dst.profile_id) = ("a".into(), "b".into());
        let id = m.create(mv).unwrap();
        finished(&m, &id).await;
        assert!(a.stat("testbucket", &key).await.unwrap().is_some(), "the only copy is still there");
    });
}

// ---------------------------------------------------------------- 2. only proven copies

#[test]
fn a_move_keeps_originals_it_cannot_prove_are_already_there() {
    tauri::async_runtime::block_on(async {
        let old = SystemTime::now() - Duration::from_secs(3600);
        for policy in [Conflict::SkipIdentical, Conflict::Skip, Conflict::KeepBoth, Conflict::NewerWins] {
            let (s, d) = (tmp(), tmp());
            // same size, and the destination's is newer: looks the same, but isn't
            write(&s.0, "a.txt", b"AAAA");
            set_mtime(&s.0, "a.txt", old);
            write(&d.0, "a.txt", b"BBBB");
            // really the same: may go
            write(&s.0, "b.txt", b"same");
            set_mtime(&s.0, "b.txt", old);
            write(&d.0, "b.txt", b"same");
            let (src, sr) = local(&s.0);
            let (dst, dr) = local(&d.0);
            let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
            let mut sp = moving(spec(&sr, &[("a.txt", false), ("b.txt", false)], &dr, ""));
            sp.conflict = policy;
            let id = m.create(sp).unwrap();
            let j = finished(&m, &id).await;
            assert_eq!(read(&s.0, "a.txt"), b"AAAA", "{policy:?}: the original stays");
            assert_eq!(read(&d.0, "a.txt"), b"BBBB", "{policy:?}");
            assert!(!s.0.join("b.txt").exists(), "{policy:?}: a proven copy lets the original go");
            assert_eq!((j.progress.files_skipped, j.progress.files_failed), (2, 0), "{policy:?}");
        }
    });
}

// ---------------------------------------------------------------- 3. one name where case doesn't count

#[test]
fn files_landing_on_one_name_where_case_does_not_count_are_both_kept() {
    tauri::async_runtime::block_on(async {
        let (s, d) = (tmp(), tmp());
        write(&s.0, "x/Photo.jpg", b"first");
        write(&s.0, "y/photo.jpg", b"second!");
        let (src, sr) = local(&s.0);
        let (dst, dr) = twisted(&d.0, ConnKind::Onedrive, true, false);
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let id = m.create(moving(spec(&sr, &[("x/Photo.jpg", false), ("y/photo.jpg", false)], &dr, ""))).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!(j.progress.files_failed, 0, "{:?}", m.failures(&id, 0, 5));
        let got = files(&d.0);
        let mut contents: Vec<&[u8]> = got.values().map(|v| v.as_slice()).collect();
        contents.sort();
        assert_eq!(contents, [b"first".as_slice(), b"second!".as_slice()], "both arrived: {:?}", got.keys());
        assert!(files(&s.0).is_empty(), "both originals moved");
    });
}

#[test]
fn folded_destinations_get_numbered_names() {
    let mut c = crate::db::open_in_memory(db::MIGRATIONS).unwrap();
    db::insert_job(&c, "j", "{}", JobState::Planning).unwrap();
    let it = |s: &str, d: &str| db::NewItem { src_path: s.into(), dst_path: d.into(), size: 1, ..Default::default() };
    let mut first = [it("x/A.txt", "A.txt")];
    plan::unique_destinations(&c, "j", ConnKind::Onedrive, &mut first).unwrap();
    db::save_page(&mut c, "j", &first, None).unwrap();
    let mut page = [it("y/a.txt", "a.txt"), it("z/A.TXT", "A.TXT"), it("w/b.txt", "b.txt")];
    plan::unique_destinations(&c, "j", ConnKind::Onedrive, &mut page).unwrap();
    assert_eq!(page.iter().map(|i| i.dst_path.as_str()).collect::<Vec<_>>(), ["a (1).txt", "A (2).TXT", "b.txt"]);
    // where case counts, nothing changes
    db::insert_job(&c, "k", "{}", JobState::Planning).unwrap();
    db::save_page(&mut c, "k", &[it("x/A.txt", "A.txt")], None).unwrap();
    let mut page = [it("y/a.txt", "a.txt")];
    plan::unique_destinations(&c, "k", ConnKind::Sftp, &mut page).unwrap();
    assert_eq!(page[0].dst_path, "a.txt");
    // the same page saved again after a crash keeps its names
    let mut again = [it("x/A.txt", "A.txt")];
    plan::unique_destinations(&c, "j", ConnKind::Onedrive, &mut again).unwrap();
    assert_eq!(again[0].dst_path, "A.txt");
}

/// Records a move whose file `rel` was copied (as `dst_seen` says), ready to delete originals.
fn copied_job(m: &JobManager, sp: &JobSpec, src_entry: &Entry, dst_seen: (Option<&str>, i64)) -> String {
    let json = serde_json::to_string(sp).unwrap();
    let mut c = m.inner.db.lock().unwrap();
    db::insert_job(&c, &sp.id, &json, JobState::Paused).unwrap();
    let rel = src_entry.key.clone();
    let item = db::NewItem { src_path: rel.clone(), dst_path: rel.clone(), size: src_entry.size, etag: src_entry.etag.clone(), mtime: src_entry.modified, ..Default::default() };
    db::save_page(&mut c, &sp.id, &[item], None).unwrap();
    db::set_planned(&c, &sp.id).unwrap();
    db::finish(&c, &sp.id, &rel, db::End::Copied, None).unwrap();
    db::record_dst(&c, &sp.id, &rel, dst_seen.0, dst_seen.1, None).unwrap();
    sp.id.clone()
}

// ---------------------------------------------------------------- 3b. checked again before deleting

#[test]
fn the_original_stays_when_its_copy_or_itself_changed_before_deletion() {
    tauri::async_runtime::block_on(async {
        // the copy was replaced since it was written (same size, other contents)
        let (s, d) = (tmp(), tmp());
        write(&s.0, "a.txt", b"hello");
        write(&d.0, "a.txt", b"HELLO");
        let (src, sr) = local(&s.0);
        let (dst, dr) = local(&d.0);
        let e = src.stat(&sr, "a.txt").await.unwrap().unwrap();
        let m = JobManager::open(None, TestHost::with(vec![("src", src.clone()), ("dst", dst.clone())])).unwrap();
        let mut sp = moving(spec(&sr, &[("a.txt", false)], &dr, ""));
        sp.id = "j1".into();
        let id = copied_job(&m, &sp, &e, (Some("what-was-written"), 5));
        m.resume(&id).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!(read(&s.0, "a.txt"), b"hello", "kept");
        assert_eq!(j.progress.files_failed, 1);
        assert!(m.failures(&id, 0, 5).unwrap()[0].error.contains("copy changed"));

        // the original changed after it was copied
        let (s, d) = (tmp(), tmp());
        write(&s.0, "a.txt", b"hello");
        write(&d.0, "a.txt", b"hello");
        let (src, sr) = local(&s.0);
        let (dst, dr) = local(&d.0);
        let e = src.stat(&sr, "a.txt").await.unwrap().unwrap();
        let de = dst.stat(&dr, "a.txt").await.unwrap().unwrap();
        write(&s.0, "a.txt", b"hello, more");
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let mut sp = moving(spec(&sr, &[("a.txt", false)], &dr, ""));
        sp.id = "j2".into();
        let id = copied_job(&m, &sp, &e, (de.etag.as_deref(), de.size));
        m.resume(&id).unwrap();
        finished(&m, &id).await;
        assert_eq!(read(&s.0, "a.txt"), b"hello, more", "kept");
        assert!(m.failures(&id, 0, 5).unwrap()[0].error.contains("original changed"));

        // both as recorded: deleted
        let (s, d) = (tmp(), tmp());
        write(&s.0, "a.txt", b"hello");
        write(&d.0, "a.txt", b"hello");
        let (src, sr) = local(&s.0);
        let (dst, dr) = local(&d.0);
        let e = src.stat(&sr, "a.txt").await.unwrap().unwrap();
        let de = dst.stat(&dr, "a.txt").await.unwrap().unwrap();
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let mut sp = moving(spec(&sr, &[("a.txt", false)], &dr, ""));
        sp.id = "j3".into();
        let id = copied_job(&m, &sp, &e, (de.etag.as_deref(), de.size));
        m.resume(&id).unwrap();
        let j = finished(&m, &id).await;
        assert!(!s.0.join("a.txt").exists());
        assert_eq!(j.progress.files_failed, 0);
    });
}

// ---------------------------------------------------------------- 9. links out of the selection

#[cfg(unix)]
#[test]
fn a_move_never_deletes_files_reached_through_a_link() {
    tauri::async_runtime::block_on(async {
        // the link points elsewhere inside the same root (the root allows it), outside "m/"
        let (s, d) = (tmp(), tmp());
        write(&s.0, "ext/f.txt", b"not selected");
        let outside = Tmp(s.0.join("ext"));
        std::fs::create_dir_all(s.0.join("m")).unwrap();
        std::os::unix::fs::symlink(&outside.0, s.0.join("m/link")).unwrap();
        write(&d.0, "m/link/f.txt", b"not selected");
        let (src, sr) = local(&s.0);
        let (dst, dr) = local(&d.0);
        let de = dst.stat(&dr, "m/link/f.txt").await.unwrap().unwrap();
        // as a planner that went into the link would have recorded it
        let e = Entry { key: "m/link/f.txt".into(), size: b"not selected".len() as i64, ..Default::default() };
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let mut sp = moving(spec(&sr, &[("m/", true)], &dr, ""));
        sp.id = "j".into();
        let id = copied_job(&m, &sp, &e, (de.etag.as_deref(), de.size));
        m.resume(&id).unwrap();
        finished(&m, &id).await;
        assert_eq!(read(&outside.0, "f.txt"), b"not selected", "the link's target is untouched");
        let f = m.failures(&id, 0, 5).unwrap();
        assert!(f[0].error.contains("link"), "{f:?}");
    });
}

// ---------------------------------------------------------------- 7. ranges ignored

#[test]
fn parts_read_from_a_store_that_ignores_ranges_arrive_intact() {
    tauri::async_runtime::block_on(async {
        let mock = super::super::mock_s3::start().await;
        let s = tmp();
        let data: Vec<u8> = (0..(20usize << 20)).map(|i| ((i * 31 + i / 7919) % 251) as u8).collect();
        write(&s.0, "big.bin", &data);
        let (src, sr) = twisted(&s.0, ConnKind::Webdav, false, true);
        let s3 = Arc::new(super::s3::backend(&mock.endpoint));
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("s3", s3.clone())])).unwrap();
        let run = format!("{}/", uuid::Uuid::new_v4());
        let mut up = spec(&sr, &[("big.bin", false)], "testbucket", &run);
        up.dst.profile_id = "s3".into();
        let id = m.create(up).unwrap();
        let j = finished(&m, &id).await;
        assert_eq!(j.progress.files_failed, 0, "{:?}", m.failures(&id, 0, 5));
        let r = s3.read("testbucket", &format!("{run}big.bin"), None, None).await.unwrap();
        assert!(r.collect(u64::MAX).await.unwrap() == data, "every part holds its own bytes");
    });
}

// ---------------------------------------------------------------- 8. resumed uploads of a changed file

#[test]
fn a_resumed_upload_of_a_changed_file_starts_over() {
    tauri::async_runtime::block_on(async {
        let mock = super::super::mock_s3::start().await;
        let s = tmp();
        let size = 20usize << 20;
        let old: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let new: Vec<u8> = (0..size).map(|i| (i % 241) as u8 ^ 0x5a).collect();
        write(&s.0, "big.bin", &old);
        set_mtime(&s.0, "big.bin", SystemTime::now() - Duration::from_secs(3600));
        let (src, sr) = local(&s.0);
        let planned = src.stat(&sr, "big.bin").await.unwrap().unwrap();
        let s3 = Arc::new(super::s3::backend(&mock.endpoint));
        let run = format!("{}/", uuid::Uuid::new_v4());
        let key = format!("{run}big.bin");

        // the first run sent part 1 of the old contents, then the app ended
        let part = crate::storage::s3_stream::part_size(Some(size as u64));
        let up = s3.client().create_multipart_upload().bucket("testbucket").key(&key).send().await.unwrap();
        let upload_id = up.upload_id().unwrap().to_string();
        let p1 = s3
            .client()
            .upload_part()
            .bucket("testbucket")
            .key(&key)
            .upload_id(&upload_id)
            .part_number(1)
            .body(old[..part as usize].to_vec().into())
            .send()
            .await
            .unwrap();
        let rs = crate::storage::ResumeState {
            upload_id: upload_id.clone(),
            part_size: part,
            parts: vec![crate::storage::PartRecord { number: 1, size: part, etag: p1.e_tag().unwrap().trim_matches('"').to_string() }],
        };

        // meanwhile the file changed (same size)
        write(&s.0, "big.bin", &new);

        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("s3", s3.clone())])).unwrap();
        let mut sp = spec(&sr, &[("big.bin", false)], "testbucket", &run);
        sp.dst.profile_id = "s3".into();
        sp.id = "j".into();
        {
            let mut c = m.inner.db.lock().unwrap();
            db::insert_job(&c, "j", &serde_json::to_string(&sp).unwrap(), JobState::Paused).unwrap();
            let item = db::NewItem { src_path: "big.bin".into(), dst_path: key.clone(), size: planned.size, etag: planned.etag.clone(), mtime: planned.modified, ..Default::default() };
            db::save_page(&mut c, "j", &[item], None).unwrap();
            db::set_planned(&c, "j").unwrap();
            db::set_upload(&c, "j", "big.bin", Some(&upload_id), Some(&serde_json::to_string(&rs).unwrap())).unwrap();
        }
        m.resume("j").unwrap();
        let j = finished(&m, "j").await;
        assert_eq!(j.progress.files_failed, 0, "{:?}", m.failures("j", 0, 5));
        let r = s3.read("testbucket", &key, None, None).await.unwrap();
        assert!(r.collect(u64::MAX).await.unwrap() == new, "the copy is the new file, not a mix of both");
    });
}

// ---------------------------------------------------------------- 18. a page token that stops working

/// A store whose page tokens stop working once (expired, or the folder changed under them).
struct ForgetfulPages {
    inner: Arc<LocalBackend>,
    failed: AtomicBool,
}

#[async_trait]
impl Storage for ForgetfulPages {
    fn kind(&self) -> ConnKind {
        ConnKind::Webdav
    }
    fn caps(&self) -> &Capabilities {
        self.inner.caps()
    }
    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        self.inner.roots().await
    }
    async fn list(&self, root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        if token.is_some() && !self.failed.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Err(StorageError::other("This page token has expired."));
        }
        self.inner.list(root, dir, token).await
    }
    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>> {
        self.inner.stat(root, path).await
    }
    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        self.inner.read(root, path, range, if_match).await
    }
    async fn write(&self, root: &str, path: &str, src: WriteSource, opts: WriteOpts<'_>, progress: Progress<'_>, cancel: &Arc<AtomicBool>) -> SResult<WriteOutcome> {
        self.inner.write(root, path, src, opts, progress, cancel).await
    }
    async fn mkdir(&self, root: &str, dir: &str) -> SResult<()> {
        self.inner.mkdir(root, dir).await
    }
    async fn delete(&self, root: &str, files: &[String], dirs: &[String], cancel: &AtomicBool, on_progress: &(dyn Fn(u64, u64) + Send + Sync)) -> SResult<(u64, u64)> {
        self.inner.delete(root, files, dirs, cancel, on_progress).await
    }
    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        self.inner.rename(from, to, is_dir).await
    }
}

#[test]
fn planning_lists_a_folder_again_when_its_page_token_stops_working() {
    tauri::async_runtime::block_on(async {
        let s = tmp();
        for i in 0..1200 {
            write(&s.0, &format!("big/{i:04}.txt"), b"x");
        }
        let (b, sr) = local(&s.0);
        let src = ForgetfulPages { inner: b, failed: AtomicBool::new(false) };
        let dbh: Db = Arc::new(Mutex::new(crate::db::open_in_memory(db::MIGRATIONS).unwrap()));
        db::insert_job(&dbh.lock().unwrap(), "j", "{}", JobState::Planning).unwrap();
        let sp = spec(&sr, &[("big/", true)], "/nowhere", "");
        let stop = AtomicBool::new(false);
        assert!(plan::plan(&src, ConnKind::Local, &sp, &dbh, "j", &stop, &|_, _| {}).await.unwrap(), "planned");
        assert!(src.failed.load(std::sync::atomic::Ordering::SeqCst), "the token did fail once");
        assert_eq!(db::counts(&dbh.lock().unwrap(), "j").unwrap().files_total, 1200, "nothing missed, nothing doubled");
    });
}
