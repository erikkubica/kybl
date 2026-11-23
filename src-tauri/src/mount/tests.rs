//! The drive's WebDAV server against this device's disk (`LocalBackend`), driven by a WebDAV
//! client (reqwest with PROPFIND, PUT, GET, MOVE, COPY, DELETE, MKCOL, LOCK), and against Kybl's
//! own WebDAV backend as a second, independent client.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use reqwest::{Method, StatusCode};

use super::{
    cache::{BlockCache, FileVersion, BLOCK},
    server,
    webdav::{KyblFs, Opener, Spec},
    writeback::WriteBack,
};
use crate::storage::{local::LocalBackend, media::test_store::MemStore, RootKind, Storage};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Drive {
    _tmp: Tmp,
    data: PathBuf,
    fs: KyblFs,
    srv: server::Server,
    http: reqwest::Client,
}

impl Drive {
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.srv.url(), path.trim_start_matches('/'))
    }
    async fn req(&self, method: &str, path: &str) -> reqwest::RequestBuilder {
        self.http.request(Method::from_bytes(method.as_bytes()).unwrap(), self.url(path))
    }
    async fn get(&self, path: &str) -> (StatusCode, Vec<u8>) {
        let r = self.req("GET", path).await.send().await.unwrap();
        (r.status(), r.bytes().await.unwrap().to_vec())
    }
    async fn propfind(&self, path: &str) -> (StatusCode, String) {
        let r = self.req("PROPFIND", path).await.header("Depth", "1").send().await.unwrap();
        (r.status(), r.text().await.unwrap())
    }
    async fn drain(&self) {
        assert!(self.fs.0.uploads.drain(Duration::from_secs(10)).await, "uploads finish");
    }
}

fn opener(s: Arc<dyn Storage>) -> Opener {
    Arc::new(move || {
        let s = s.clone();
        Box::pin(async move { Ok(s) })
    })
}

/// A drive over a temp folder holding `a.txt`, `docs/b.md` and a 9 MiB `big.bin`.
async fn drive(read_only: bool) -> Drive {
    let base = std::env::temp_dir().join(format!("kybl-mount-{}", uuid::Uuid::new_v4()));
    let data = base.join("data");
    std::fs::create_dir_all(data.join("docs")).unwrap();
    std::fs::write(data.join("a.txt"), b"hello world").unwrap();
    std::fs::write(data.join("docs/b.md"), b"# b").unwrap();
    std::fs::write(data.join("big.bin"), big()).unwrap();
    let backend = LocalBackend::with_roots(vec![("Data".into(), RootKind::Folder, data.clone())], false);
    let root = backend.roots().await.unwrap()[0].id.clone();
    let s: Arc<dyn Storage> = Arc::new(backend);
    let blocks = Arc::new(BlockCache::open(base.join("cache"), 64 * 1024 * 1024));
    let uploads = Arc::new(WriteBack::open(base.join("uploads")));
    let fs = KyblFs::new(opener(s), Spec { bucket: root, prefix: String::new(), read_only }, blocks, uploads);
    fs.start_uploads();
    let srv = server::start(fs.clone(), 0, server::random_token(), read_only).await.unwrap();
    Drive { _tmp: Tmp(base), data, fs, srv, http: crate::storage::net::http() }
}

fn big() -> Vec<u8> {
    (0..(9 * 1024 * 1024u32)).map(|i| (i % 251) as u8).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn whole_connection_drives_show_roots_as_folders() {
    let base = std::env::temp_dir().join(format!("kybl-mount-{}", uuid::Uuid::new_v4()));
    let _t = Tmp(base.clone());
    for (dir, file) in [("one", "x.txt"), ("two", "y.txt")] {
        std::fs::create_dir_all(base.join(dir)).unwrap();
        std::fs::write(base.join(dir).join(file), dir).unwrap();
    }
    let serve = |roots: Vec<(String, RootKind, PathBuf)>, sub: &str| {
        let s: Arc<dyn Storage> = Arc::new(LocalBackend::with_roots(roots, false));
        let blocks = Arc::new(BlockCache::open(base.join(sub).join("cache"), 64 * 1024 * 1024));
        let uploads = Arc::new(WriteBack::open(base.join(sub).join("uploads")));
        KyblFs::new(opener(s), Spec { bucket: String::new(), prefix: String::new(), read_only: false }, blocks, uploads)
    };
    let http = crate::storage::net::http();
    // several roots: each is a top-level folder
    let fs = serve(vec![("One".into(), RootKind::Folder, base.join("one")), ("Two".into(), RootKind::Folder, base.join("two"))], "a");
    let srv = server::start(fs, 0, server::random_token(), false).await.unwrap();
    let top = http.request(Method::from_bytes(b"PROPFIND").unwrap(), srv.url()).header("Depth", "1").send().await.unwrap().text().await.unwrap();
    assert!(top.contains("One/") && top.contains("Two/"), "{top}");
    assert_eq!(http.get(format!("{}Two/y.txt", srv.url())).send().await.unwrap().text().await.unwrap(), "two");
    // one root: its contents are the top
    let fs = serve(vec![("One".into(), RootKind::Folder, base.join("one"))], "b");
    let srv = server::start(fs, 0, server::random_token(), false).await.unwrap();
    assert_eq!(http.get(format!("{}x.txt", srv.url())).send().await.unwrap().text().await.unwrap(), "one");
}

fn on_disk(d: &Path, rel: &str) -> Option<Vec<u8>> {
    std::fs::read(d.join(rel)).ok()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browses_and_reads_with_ranges() {
    let d = drive(false).await;
    let (st, body) = d.propfind("/").await;
    assert_eq!(st.as_u16(), 207);
    assert!(body.contains("a.txt") && body.contains("docs/") && body.contains("big.bin"), "{body}");

    assert_eq!(d.get("a.txt").await, (StatusCode::OK, b"hello world".to_vec()));
    let r = d.req("GET", "a.txt").await.header("Range", "bytes=6-10").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.headers()["content-range"], "bytes 6-10/11");
    assert_eq!(&r.bytes().await.unwrap()[..], b"world");

    // a range across the first block boundary of the big file
    let (a, b) = (BLOCK - 5, BLOCK + 5);
    let r = d.req("GET", "big.bin").await.header("Range", format!("bytes={a}-{b}")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(&r.bytes().await.unwrap()[..], &big()[a as usize..=b as usize]);
    // the whole thing, through the cache
    let (st, all) = d.get("big.bin").await;
    assert_eq!(st, StatusCode::OK);
    assert!(all == big(), "whole file matches");
    assert!(d.fs.0.blocks.used() >= 2 * BLOCK, "blocks were cached");

    let r = d.req("HEAD", "docs/b.md").await.send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-length"], "3");
    assert_eq!(d.get("nope.txt").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saves_upload_on_close_and_show_before_they_do() {
    let d = drive(false).await;
    let r = d.req("PUT", "new.txt").await.body("fresh").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::CREATED);
    // shown at once, from the local copy, before the upload
    assert_eq!(d.get("new.txt").await, (StatusCode::OK, b"fresh".to_vec()));
    assert!(d.propfind("/").await.1.contains("new.txt"));
    d.drain().await;
    assert_eq!(on_disk(&d.data, "new.txt").unwrap(), b"fresh");

    // replacing a file
    let r = d.req("PUT", "a.txt").await.body("changed").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    d.drain().await;
    assert_eq!(on_disk(&d.data, "a.txt").unwrap(), b"changed");
    assert_eq!(d.get("a.txt").await.1, b"changed");

    // an empty PUT empties the file
    d.req("PUT", "a.txt").await.body("").send().await.unwrap();
    d.drain().await;
    assert_eq!(on_disk(&d.data, "a.txt").unwrap(), b"");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_changed_on_the_server_meanwhile_is_kept_as_a_conflict_copy() {
    let d = drive(false).await;
    // the client reads the file, then saves its edit
    assert_eq!(d.get("a.txt").await.1, b"hello world");
    d.req("PROPFIND", "/").await.header("Depth", "1").send().await.unwrap();
    d.req("PUT", "a.txt").await.body("my edit").send().await.unwrap();
    // ...while someone else changes it on the server
    std::fs::write(d.data.join("a.txt"), b"their edit, longer").unwrap();
    d.drain().await;
    assert_eq!(on_disk(&d.data, "a.txt").unwrap(), b"their edit, longer", "theirs keeps the name");
    let copy = std::fs::read_dir(&d.data)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n.starts_with("a (conflict "))
        .expect("conflict copy");
    assert!(copy.ends_with(").txt"));
    assert_eq!(on_disk(&d.data, &copy).unwrap(), b"my edit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn folders_moves_copies_and_deletes() {
    let d = drive(false).await;
    assert_eq!(d.req("MKCOL", "made/").await.send().await.unwrap().status(), StatusCode::CREATED);
    assert!(d.data.join("made").is_dir());
    assert_eq!(d.req("MKCOL", "made/").await.send().await.unwrap().status(), StatusCode::METHOD_NOT_ALLOWED);

    let r = d.req("MOVE", "a.txt").await.header("Destination", d.url("made/a2.txt")).send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    assert!(!d.data.join("a.txt").exists());
    assert_eq!(on_disk(&d.data, "made/a2.txt").unwrap(), b"hello world");
    assert_eq!(d.get("made/a2.txt").await.1, b"hello world");

    let r = d.req("COPY", "docs/b.md").await.header("Destination", d.url("made/b-copy.md")).send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    d.drain().await;
    assert_eq!(on_disk(&d.data, "made/b-copy.md").unwrap(), b"# b");

    // renaming a folder
    let r = d.req("MOVE", "docs/").await.header("Destination", d.url("documents/")).send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    assert_eq!(on_disk(&d.data, "documents/b.md").unwrap(), b"# b");

    assert_eq!(d.req("DELETE", "made/a2.txt").await.send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(!d.data.join("made/a2.txt").exists());
    assert_eq!(d.req("DELETE", "made/").await.send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(!d.data.join("made").exists());
    assert_eq!(d.get("made/b-copy.md").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renaming_a_save_before_it_uploads_uploads_it_under_the_new_name() {
    let d = drive(false).await;
    // the "write a temp file, rename it over the real one" save that many apps do
    d.req("PUT", "doc.tmp").await.body("v2").send().await.unwrap();
    let r = d.req("MOVE", "doc.tmp").await.header("Destination", d.url("a.txt")).send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    assert_eq!(d.get("a.txt").await.1, b"v2");
    d.drain().await;
    assert_eq!(on_disk(&d.data, "a.txt").unwrap(), b"v2");
    assert!(!d.data.join("doc.tmp").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_waiting_in_a_renamed_folder_is_not_a_conflict() {
    let d = drive(false).await;
    d.req("PROPFIND", "docs/").await.header("Depth", "1").send().await.unwrap();
    d.req("PUT", "docs/b.md").await.body("# edited").send().await.unwrap();
    // the folder is renamed before the edit went up
    let r = d.req("MOVE", "docs/").await.header("Destination", d.url("documents/")).send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    d.drain().await;
    assert_eq!(on_disk(&d.data, "documents/b.md").unwrap(), b"# edited");
    let names: Vec<String> = std::fs::read_dir(d.data.join("documents")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["b.md".to_string()], "no conflict copy");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn locks_work_for_finder() {
    let d = drive(false).await;
    let body = r#"<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>kybl-test</D:owner></D:lockinfo>"#;
    let r = d.req("LOCK", "a.txt").await.header("Timeout", "Second-60").body(body).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let token = r.headers()["lock-token"].to_str().unwrap().to_string();
    // locked: a write without the token is refused, with it allowed
    assert_eq!(d.req("PUT", "a.txt").await.body("x").send().await.unwrap().status(), StatusCode::LOCKED);
    let r = d.req("PUT", "a.txt").await.header("If", format!("({token})")).body("locked edit").send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    let r = d.req("UNLOCK", "a.txt").await.header("Lock-Token", token).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);

    // LOCK on a new name makes an empty file (Finder's first step when copying in)
    let r = d.req("LOCK", "fresh.txt").await.body(body).send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    assert_eq!(d.get("fresh.txt").await, (StatusCode::OK, vec![]));
    d.drain().await;
    assert_eq!(on_disk(&d.data, "a.txt").unwrap(), b"locked edit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finder_clutter_stays_local() {
    let d = drive(false).await;
    for name in ["._a.txt", ".DS_Store", "docs/._b.md"] {
        let r = d.req("PUT", name).await.body("apple double").send().await.unwrap();
        assert!(r.status().is_success(), "{name}: {}", r.status());
        assert_eq!(d.get(name).await.1, b"apple double", "{name} reads back this session");
    }
    d.drain().await;
    assert!(!d.data.join("._a.txt").exists() && !d.data.join(".DS_Store").exists() && !d.data.join("docs/._b.md").exists());
    assert_eq!(d.get("._never.txt").await.0, StatusCode::NOT_FOUND);
    assert_eq!(d.req("MKCOL", ".Trashes/").await.send().await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(d.req("MKCOL", ".Spotlight-V100/").await.send().await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(d.req("DELETE", "._a.txt").await.send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(d.get("._a.txt").await.0, StatusCode::NOT_FOUND);
    // clutter already on the server is hidden
    std::fs::write(d.data.join("docs/._old"), b"x").unwrap();
    assert!(!d.propfind("docs/").await.1.contains("._old"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_our_host_and_token_get_in() {
    let d = drive(false).await;
    let r = d.req("GET", "a.txt").await.header("Host", "evil.example:80").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let wrong = format!("http://127.0.0.1:{}/{}/a.txt", d.srv.port, server::random_token());
    assert_eq!(d.http.get(wrong).send().await.unwrap().status(), StatusCode::NOT_FOUND);
    let none = format!("http://127.0.0.1:{}/a.txt", d.srv.port);
    assert_eq!(d.http.get(none).send().await.unwrap().status(), StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_drives_refuse_changes() {
    let d = drive(true).await;
    assert_eq!(d.get("a.txt").await.1, b"hello world");
    for (m, p) in [("PUT", "x.txt"), ("MKCOL", "dir/"), ("DELETE", "a.txt")] {
        let st = d.req(m, p).await.body("x").send().await.unwrap().status();
        assert!(st.is_client_error(), "{m} {p}: {st}");
    }
    assert!(d.data.join("a.txt").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kybls_own_webdav_client_works_against_it() {
    use crate::storage::{webdav::WebdavBackend, WriteOpts, WriteSource};
    let d = drive(false).await;
    let cfg = crate::state::NetConfig { url: Some(d.srv.url()), ..Default::default() };
    let c = WebdavBackend::new(&cfg, None).unwrap();
    let root = c.roots().await.unwrap()[0].id.clone();
    let page = c.list(&root, "", None).await.unwrap();
    assert!(page.folders.iter().any(|f| f == "docs/"), "{:?}", page.folders);
    assert!(page.objects.iter().any(|o| o.key == "a.txt" && o.size == 11));
    let body = c.read(&root, "big.bin", Some(10..20), None).await.unwrap().collect(1 << 20).await.unwrap();
    assert_eq!(body, &big()[10..20]);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    c.write(&root, "docs/from-client.txt", WriteSource::Bytes("via kybl".into()), WriteOpts::default(), &|_, _| {}, &stop).await.unwrap();
    d.drain().await;
    assert_eq!(on_disk(&d.data, "docs/from-client.txt").unwrap(), b"via kybl");
}

#[test]
fn pending_saves_survive_a_restart() {
    let dir = std::env::temp_dir().join(format!("kybl-wb-{}", uuid::Uuid::new_v4()));
    let _t = Tmp(dir.clone());
    {
        let wb = WriteBack::open(dir.clone());
        let t = wb.new_temp().unwrap();
        std::fs::write(&t, b"keep me").unwrap();
        wb.commit("root", "k.txt", &t, None).unwrap();
        // a save that never finished
        std::fs::write(wb.new_temp().unwrap(), b"half").unwrap();
    }
    let wb = WriteBack::open(dir.clone());
    let p = wb.get("root", "k.txt").expect("still pending");
    assert_eq!(std::fs::read(wb.path_of(&p)).unwrap(), b"keep me");
    let files = std::fs::read_dir(&dir).unwrap().count();
    assert_eq!(files, 2, "pending.json and the one save; the unfinished one is gone");
}

#[test]
fn the_block_cache_evicts_least_recently_used() {
    let dir = std::env::temp_dir().join(format!("kybl-bc-{}", uuid::Uuid::new_v4()));
    let _t = Tmp(dir.clone());
    let data: Vec<u8> = (0..(5 * BLOCK as usize)).map(|i| (i % 253) as u8).collect();
    let store = MemStore::new(true).with("f.bin", data.clone());
    let v = FileVersion { root: "r".into(), key: "f.bin".into(), size: data.len() as u64, version: "e1".into() };
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        // room for three blocks
        let c = BlockCache::open(dir.clone(), 3 * BLOCK);
        for i in 0..3 {
            let b = c.block(&store, &v, i).await.unwrap();
            assert_eq!(&b[..], &data[(i * BLOCK) as usize..((i + 1) * BLOCK) as usize]);
        }
        // block 0 is used again, so block 1 is the oldest when block 3 comes in
        c.block(&store, &v, 0).await.unwrap();
        c.block(&store, &v, 3).await.unwrap();
        assert!(c.used() <= 3 * BLOCK);
        assert!(c.has(&v, 0) && !c.has(&v, 1) && c.has(&v, 2) && c.has(&v, 3));
        let reads = store.reads.lock().unwrap().len();
        assert_eq!(reads, 4, "block 0 came from the cache the second time");
        // reopened from disk, the cache knows its blocks
        drop(c);
        let c = BlockCache::open(dir.clone(), 3 * BLOCK);
        assert!(c.has(&v, 3));
        assert_eq!(c.used(), 3 * BLOCK);
        // a new version of the file doesn't use the old blocks
        let v2 = FileVersion { version: "e2".into(), ..v.clone() };
        assert!(!c.has(&v2, 3));
    });
}

#[test]
fn stores_without_ranges_fill_every_block_from_one_read() {
    let dir = std::env::temp_dir().join(format!("kybl-bc-{}", uuid::Uuid::new_v4()));
    let _t = Tmp(dir.clone());
    let data: Vec<u8> = (0..(2 * BLOCK as usize + 100)).map(|i| (i % 7) as u8).collect();
    let store = MemStore::new(false).with("f.bin", data.clone());
    let v = FileVersion { root: "r".into(), key: "f.bin".into(), size: data.len() as u64, version: "e".into() };
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let c = BlockCache::open(dir.clone(), 10 * BLOCK);
        let b = c.block(&store, &v, 2).await.unwrap();
        assert_eq!(&b[..], &data[2 * BLOCK as usize..]);
        assert!(c.has(&v, 0) && c.has(&v, 1));
        assert_eq!(&c.block(&store, &v, 1).await.unwrap()[..], &data[BLOCK as usize..2 * BLOCK as usize]);
        assert_eq!(store.reads.lock().unwrap().len(), 1);
    });
}

#[test]
fn a_short_read_is_never_cached_as_a_whole_block() {
    let dir = std::env::temp_dir().join(format!("kybl-bc-{}", uuid::Uuid::new_v4()));
    let _t = Tmp(dir.clone());
    let data: Vec<u8> = (0..(BLOCK as usize + 100)).map(|i| (i % 5) as u8).collect();
    // the listing said the file is longer than what the server now sends
    let v = FileVersion { root: "r".into(), key: "f.bin".into(), size: 2 * BLOCK, version: "e".into() };
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        for ranges in [true, false] {
            let store = MemStore::new(ranges).with("f.bin", data.clone());
            let c = BlockCache::open(dir.join(ranges.to_string()), 10 * BLOCK);
            let b = c.block(&store, &v, 1).await.unwrap();
            assert_eq!(b.len(), 100);
            assert!(!c.has(&v, 1), "short block kept (ranges: {ranges})");
        }
    });
}

// ---------------------------------------------------------------- speed with a slow server

/// A store that answers slowly and counts what it is asked: two buckets, `b` holding
/// `Videos/clip-N.mp4` files of `size` bytes, each a pattern of its own.
struct SlowStore {
    caps: crate::storage::Capabilities,
    clips: usize,
    size: u64,
    list_delay: Duration,
    roots_delay: Duration,
    quota_delay: Duration,
    /// listings of `Videos/`
    lists: std::sync::atomic::AtomicUsize,
    roots_calls: std::sync::atomic::AtomicUsize,
    reads: std::sync::Mutex<Vec<(String, Option<std::ops::Range<u64>>)>>,
}

impl SlowStore {
    fn new(clips: usize, size: u64) -> Self {
        Self {
            caps: crate::storage::Capabilities { range_read: true, ..Default::default() },
            clips,
            size,
            list_delay: Duration::ZERO,
            roots_delay: Duration::ZERO,
            quota_delay: Duration::ZERO,
            lists: Default::default(),
            roots_calls: Default::default(),
            reads: Default::default(),
        }
    }
    fn byte(key: &str, at: u64) -> u8 {
        ((at + key.len() as u64) % 251) as u8
    }
    fn lists(&self) -> usize {
        self.lists.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn reads(&self) -> Vec<(String, Option<std::ops::Range<u64>>)> {
        self.reads.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Storage for SlowStore {
    fn kind(&self) -> crate::storage::ConnKind {
        crate::storage::ConnKind::S3
    }
    fn caps(&self) -> &crate::storage::Capabilities {
        &self.caps
    }
    async fn roots(&self) -> crate::storage::SResult<Vec<crate::storage::RootInfo>> {
        self.roots_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(self.roots_delay).await;
        Ok(["a", "b"].iter().map(|n| crate::storage::RootInfo { id: n.to_string(), name: n.to_string(), kind: RootKind::Bucket, created: None, read_only: false }).collect())
    }
    async fn list(&self, root: &str, dir: &str, _: Option<String>) -> crate::storage::SResult<crate::storage::Page> {
        // counted for the big folder only: the folders above it are listed too, on the way
        if dir == "Videos/" {
            self.lists.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        tokio::time::sleep(self.list_delay).await;
        let mut page = crate::storage::Page::default();
        match (root, dir) {
            ("b", "") => page.folders.push("Videos/".into()),
            ("b", "Videos/") => {
                for i in 0..self.clips {
                    page.objects.push(crate::storage::Entry { key: format!("Videos/clip-{i}.mp4"), size: self.size as i64, etag: Some(format!("e{i}")), ..Default::default() });
                }
            }
            _ => {}
        }
        Ok(page)
    }
    async fn stat(&self, _: &str, _: &str) -> crate::storage::SResult<Option<crate::storage::Entry>> {
        panic!("the drive answers from listings, never a stat per file");
    }
    async fn read(&self, _: &str, path: &str, range: Option<std::ops::Range<u64>>, _: Option<&str>) -> crate::storage::SResult<crate::storage::ReadStream> {
        self.reads.lock().unwrap().push((path.to_string(), range.clone()));
        let r = range.unwrap_or(0..self.size);
        let (a, b) = (r.start.min(self.size), r.end.min(self.size));
        let bytes: Vec<u8> = (a..b).map(|i| Self::byte(path, i)).collect();
        let len = bytes.len() as u64;
        let chunks: Vec<std::io::Result<bytes::Bytes>> = bytes.chunks(64 * 1024).map(|c| Ok(bytes::Bytes::copy_from_slice(c))).collect();
        Ok(crate::storage::ReadStream { body: Box::pin(futures_util::stream::iter(chunks)), len: Some(len), total: Some(self.size), range: Some(a..b), etag: None, content_type: None })
    }
    async fn write(
        &self,
        _: &str,
        _: &str,
        _: crate::storage::WriteSource,
        _: crate::storage::WriteOpts<'_>,
        _: crate::storage::Progress<'_>,
        _: &Arc<std::sync::atomic::AtomicBool>,
    ) -> crate::storage::SResult<crate::storage::WriteOutcome> {
        crate::storage::unsupported()
    }
    async fn mkdir(&self, _: &str, _: &str) -> crate::storage::SResult<()> {
        crate::storage::unsupported()
    }
    async fn delete(&self, _: &str, _: &[String], _: &[String], _: &std::sync::atomic::AtomicBool, _: &(dyn Fn(u64, u64) + Send + Sync)) -> crate::storage::SResult<(u64, u64)> {
        crate::storage::unsupported()
    }
    async fn rename(&self, _: &crate::storage::Loc, _: &crate::storage::Loc, _: bool) -> crate::storage::SResult<()> {
        crate::storage::unsupported()
    }
    async fn quota(&self) -> crate::storage::SResult<Option<crate::storage::Quota>> {
        tokio::time::sleep(self.quota_delay).await;
        Ok(Some(crate::storage::Quota { used: 1, total: Some(2) }))
    }
}

struct SlowDrive {
    _tmp: Tmp,
    store: Arc<SlowStore>,
    fs: KyblFs,
    srv: server::Server,
    http: reqwest::Client,
}

impl SlowDrive {
    async fn new(store: SlowStore) -> Self {
        let base = std::env::temp_dir().join(format!("kybl-slow-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(store);
        let blocks = Arc::new(BlockCache::open(base.join("cache"), 256 * 1024 * 1024));
        let uploads = Arc::new(WriteBack::open(base.join("uploads")));
        let fs = KyblFs::new(opener(store.clone()), Spec { bucket: String::new(), prefix: String::new(), read_only: false }, blocks, uploads);
        let srv = server::start(fs.clone(), 0, server::random_token(), false).await.unwrap();
        Self { _tmp: Tmp(base), store, fs, srv, http: crate::storage::net::http() }
    }
    /// PROPFIND `path`, asking for the quota like Finder; (status, body, time taken).
    async fn propfind(&self, path: &str, depth: &str) -> (u16, String, Duration) {
        let body = r#"<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/><D:getcontentlength/><D:resourcetype/><D:quota-available-bytes/><D:quota-used-bytes/></D:prop></D:propfind>"#;
        let t = std::time::Instant::now();
        let r = self
            .http
            .request(Method::from_bytes(b"PROPFIND").unwrap(), format!("{}{path}", self.srv.url()))
            .header("Depth", depth)
            .header("Content-Type", "text/xml")
            .body(body)
            .send()
            .await
            .unwrap();
        let st = r.status().as_u16();
        (st, r.text().await.unwrap(), t.elapsed())
    }
    async fn get_range(&self, path: &str, a: u64, b: u64) -> Vec<u8> {
        let r = self.http.get(format!("{}{path}", self.srv.url())).header("Range", format!("bytes={a}-{b}")).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        r.bytes().await.unwrap().to_vec()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_top_answers_fast_while_the_quota_is_slow() {
    let mut store = SlowStore::new(3, 10);
    store.quota_delay = Duration::from_secs(5);
    let d = SlowDrive::new(store).await;
    let (st, body, took) = d.propfind("", "1").await;
    assert_eq!(st, 207);
    assert!(body.contains("a/") && body.contains("b/"), "{body}");
    assert!(took < Duration::from_millis(1500), "the top waited {took:?} for the quota");
    // asked again while the quota is still being counted: no waiting at all now
    let (_, _, took) = d.propfind("", "0").await;
    assert!(took < Duration::from_millis(300), "the second ask waited {took:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expired_listings_and_roots_answer_from_the_cache_and_refresh_behind() {
    let mut store = SlowStore::new(2183, 10);
    store.list_delay = Duration::from_millis(800);
    store.roots_delay = Duration::from_millis(800);
    let d = SlowDrive::new(store).await;
    // first time: the server is asked, and that is slow
    let (st, body, took) = d.propfind("b/Videos/", "1").await;
    assert_eq!(st, 207);
    assert!(body.contains("clip-2182.mp4"), "every clip listed");
    assert!(took >= Duration::from_millis(800));
    assert_eq!(d.store.lists(), 1);
    // well past the TTL: answered at once from the cache, refreshed behind it
    d.fs.0.age_caches(super::webdav::TTL + Duration::from_secs(1));
    let (st, body, took) = d.propfind("b/Videos/", "1").await;
    assert_eq!(st, 207);
    assert!(body.contains("clip-2182.mp4"));
    assert!(took < Duration::from_millis(400), "a stale listing waited {took:?}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(d.store.lists(), 2, "one refresh behind the stale answer");
    // fresh again: no more calls
    d.propfind("b/Videos/", "1").await;
    assert_eq!(d.store.lists(), 2);
    // a listing older than STALE is not trusted any more: that ask waits for a fresh one
    d.fs.0.age_caches(super::webdav::STALE + Duration::from_secs(1));
    // (the list of roots is still answered at once, however old: roots rarely change)
    let roots = d.store.roots_calls.load(std::sync::atomic::Ordering::SeqCst);
    let (_, body, took) = d.propfind("", "1").await;
    assert!(body.contains("b/") && took < Duration::from_millis(400), "old roots waited {took:?}");
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(d.store.roots_calls.load(std::sync::atomic::Ordering::SeqCst), roots + 1, "refreshed behind");
    d.fs.0.age_caches(super::webdav::STALE + Duration::from_secs(1));
    let (_, _, took) = d.propfind("b/Videos/", "1").await;
    assert!(took >= Duration::from_millis(800));
    assert_eq!(d.store.lists(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_same_folder_asked_for_at_once_is_listed_once() {
    let mut store = SlowStore::new(500, 10);
    store.list_delay = Duration::from_millis(500);
    let d = Arc::new(SlowDrive::new(store).await);
    // the drive's top and the bucket first, so only the folder itself is left to list
    d.propfind("b/", "1").await;
    let before = d.store.lists();
    let asks: Vec<_> = (0..8)
        .map(|_| {
            let d = d.clone();
            tokio::spawn(async move { d.propfind("b/Videos/", "1").await })
        })
        .collect();
    for a in asks {
        let (st, body, _) = a.await.unwrap();
        assert_eq!(st, 207);
        assert!(body.contains("clip-499.mp4"));
    }
    assert_eq!(d.store.lists() - before, 1, "eight PROPFINDs, one listing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lone_read_fetches_one_block_and_reading_front_to_back_reads_ahead() {
    let size = 20 * BLOCK + 12345;
    let d = SlowDrive::new(SlowStore::new(2, size)).await;
    let key = "Videos/clip-0.mp4";
    // Finder peeking at the end of a video (where an MP4's index often is) for its icon
    let (a, b) = (size - 8 * 1024, size - 1);
    let got = d.get_range("b/Videos/clip-0.mp4", a, b).await;
    assert_eq!(got, (a..=b).map(|i| SlowStore::byte(key, i)).collect::<Vec<_>>());
    tokio::time::sleep(Duration::from_millis(200)).await;
    let reads = d.store.reads();
    assert_eq!(reads.len(), 1, "one block, nothing fetched ahead: {reads:?}");
    let r = reads[0].1.clone().unwrap();
    assert_eq!(r, 20 * BLOCK..size, "only the last block");
    // and the start: one block too
    d.get_range("b/Videos/clip-1.mp4", 0, 4095).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(d.store.reads().len(), 2);
    // reading on from there, front to back: the next blocks come ahead of the reader
    d.get_range("b/Videos/clip-1.mp4", 4096, BLOCK + 10).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let ahead: Vec<_> = d.store.reads().into_iter().filter(|(k, _)| k == "Videos/clip-1.mp4").map(|(_, r)| r.unwrap().start / BLOCK).collect();
    assert!(ahead.contains(&2) && ahead.contains(&3), "blocks 2 and 3 fetched ahead: {ahead:?}");
    // the whole file still reads right, from start to end
    let all = d.http.get(format!("{}b/Videos/clip-1.mp4", d.srv.url())).send().await.unwrap().bytes().await.unwrap();
    assert!(all.iter().enumerate().all(|(i, &x)| x == SlowStore::byte("Videos/clip-1.mp4", i as u64)) && all.len() as u64 == size);
    // each block was fetched once, however it was asked for
    let mut seen: Vec<_> = d.store.reads().into_iter().filter(|(k, _)| k == "Videos/clip-1.mp4").map(|(_, r)| r.unwrap().start).collect();
    let n = seen.len();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), n, "no block downloaded twice");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_change_made_through_the_drive_is_never_hidden_by_a_listing_under_way() {
    // a refresh that started before a change must not put the old folder back in the cache
    let mut store = SlowStore::new(3, 10);
    store.list_delay = Duration::from_millis(300);
    let d = SlowDrive::new(store).await;
    d.propfind("b/Videos/", "1").await;
    d.fs.0.age_caches(super::webdav::TTL + Duration::from_secs(1));
    // stale answer; refresh starts behind it
    d.propfind("b/Videos/", "1").await;
    // Kybl changes the folder while that refresh is under way
    d.fs.0.forget_folder("b", "Videos/");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = d.store.lists();
    d.propfind("b/Videos/", "1").await;
    assert_eq!(d.store.lists(), before + 1, "the refresh from before the change wasn't kept");
}

/// A real mount: `mount_webdav` into a temp folder, then `ls`, `cat`, `cp`, `mkdir`, `mv` and a
/// save through the mounted folder, and unmount. Needs no dialog and no admin rights, but it
/// touches the system's mount table, so it only runs when asked:
/// `cargo test real_macos_mount -- --ignored`.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn real_macos_mount() {
    use std::process::Command;
    struct Unmount(PathBuf);
    impl Drop for Unmount {
        fn drop(&mut self) {
            let _ = Command::new("/sbin/umount").arg("-f").arg(&self.0).status();
        }
    }
    let d = drive(false).await;
    let base = d._tmp.0.join("Mounts");
    let url = d.srv.url();
    let m = tokio::task::spawn_blocking(move || super::os::mount(&url, &base, "Kybl test", false)).await.unwrap().expect("mounted");
    let point = PathBuf::from(&m.point);
    let _guard = Unmount(point.clone());
    let p2 = point.clone();
    let out = tokio::task::spawn_blocking(move || {
        let sh = |cmd: &str| {
            let o = Command::new("/bin/sh").arg("-c").arg(cmd).current_dir(&p2).output().unwrap();
            assert!(o.status.success(), "{cmd}: {}", String::from_utf8_lossy(&o.stderr));
            String::from_utf8_lossy(&o.stdout).into_owned()
        };
        let ls = sh("ls");
        assert!(ls.contains("a.txt") && ls.contains("docs") && ls.contains("big.bin"), "{ls}");
        assert_eq!(sh("cat a.txt"), "hello world");
        assert_eq!(sh("cat docs/b.md"), "# b");
        // a big file read through the mount, compared byte for byte
        let copy = p2.parent().unwrap().parent().unwrap().join("big-copy.bin");
        sh(&format!("cp big.bin '{}'", copy.display()));
        assert!(std::fs::read(&copy).unwrap() == big(), "cp of big.bin matches");
        // writing through the mount
        sh("printf 'written in Finder' > new.txt");
        sh("cp a.txt docs/a-copy.txt");
        sh("mkdir made && echo inner > made/inner.txt");
        sh("mv docs/b.md docs/b-renamed.md");
        sh("ls -a docs")
    })
    .await
    .unwrap();
    assert!(out.contains("b-renamed.md"), "{out}");
    d.drain().await;
    assert_eq!(on_disk(&d.data, "new.txt").unwrap(), b"written in Finder");
    assert_eq!(on_disk(&d.data, "docs/a-copy.txt").unwrap(), b"hello world");
    assert_eq!(on_disk(&d.data, "made/inner.txt").unwrap(), b"inner\n");
    assert!(d.data.join("docs/b-renamed.md").exists() && !d.data.join("docs/b.md").exists());
    // no clutter reached the "server"
    let clutter: Vec<String> = walkdir::WalkDir::new(&d.data)
        .into_iter()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("._") || n == ".DS_Store")
        .collect();
    assert!(clutter.is_empty(), "{clutter:?}");
    let m2 = m.clone();
    tokio::task::spawn_blocking(move || super::os::unmount(&m2, "", false)).await.unwrap().expect("unmounted");
    assert!(!super::os::is_mounted(&m));
}

// ---------------------------------------------------------------- web-only files (Google Docs)

/// A Drive-like store with one root `d`: Google Docs (no bytes, a `native` link) beside one real
/// file whose name is what a doc's shortcut would be called. Remembers what was done to it.
struct DocStore {
    caps: crate::storage::Capabilities,
    files: std::sync::Mutex<std::collections::BTreeMap<String, crate::storage::Entry>>,
    done: std::sync::Mutex<Vec<String>>,
}

impl DocStore {
    fn new() -> Self {
        let doc = |key: &str, kind: &str, id: &str| crate::storage::Entry {
            key: key.into(),
            size: 0,
            modified: Some(1_700_000_000_000),
            etag: Some("v3".into()),
            id: Some(id.into()),
            mime: Some(format!("application/vnd.google-apps.{kind}")),
            native: Some(crate::storage::NativeDoc { exports: vec![], web_url: Some(format!("https://docs.example.test/{id}/edit?a=1&b=2")) }),
            ..Default::default()
        };
        let mut files = std::collections::BTreeMap::new();
        for e in [
            doc("Plan", "document", "p1"),
            doc("Budget", "spreadsheet", "b1"),
            doc("Survey", "form", "s1"),
            doc("Report", "document", "r1"),
            crate::storage::Entry { key: "Report.gdoc.html".into(), size: 5, ..Default::default() },
            crate::storage::Entry { key: "sub/keep.txt".into(), size: 4, ..Default::default() },
        ] {
            files.insert(e.key.clone(), e);
        }
        Self {
            caps: crate::storage::Capabilities { server_copy: crate::storage::ServerCopy::SameRoot, ..Default::default() },
            files: std::sync::Mutex::new(files),
            done: Default::default(),
        }
    }
    fn has(&self, key: &str) -> bool {
        self.files.lock().unwrap().contains_key(key)
    }
    fn done(&self) -> Vec<String> {
        self.done.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Storage for DocStore {
    fn kind(&self) -> crate::storage::ConnKind {
        crate::storage::ConnKind::S3
    }
    fn caps(&self) -> &crate::storage::Capabilities {
        &self.caps
    }
    async fn roots(&self) -> crate::storage::SResult<Vec<crate::storage::RootInfo>> {
        Ok(vec![crate::storage::RootInfo { id: "d".into(), name: "My Drive".into(), kind: RootKind::Drive, created: None, read_only: false }])
    }
    async fn list(&self, _: &str, dir: &str, _: Option<String>) -> crate::storage::SResult<crate::storage::Page> {
        let mut page = crate::storage::Page::default();
        for (k, e) in self.files.lock().unwrap().iter() {
            let Some(rest) = k.strip_prefix(dir) else { continue };
            match rest.split_once('/') {
                Some((d, _)) => {
                    let f = format!("{dir}{d}/");
                    if !page.folders.contains(&f) {
                        page.folders.push(f);
                    }
                }
                None => page.objects.push(e.clone()),
            }
        }
        Ok(page)
    }
    async fn stat(&self, _: &str, path: &str) -> crate::storage::SResult<Option<crate::storage::Entry>> {
        Ok(self.files.lock().unwrap().get(path).cloned())
    }
    async fn read(&self, _: &str, path: &str, _: Option<std::ops::Range<u64>>, _: Option<&str>) -> crate::storage::SResult<crate::storage::ReadStream> {
        self.done.lock().unwrap().push(format!("read {path}"));
        let e = self.files.lock().unwrap().get(path).cloned();
        let Some(e) = e else { return crate::storage::unsupported() };
        let b = bytes::Bytes::from(vec![b'x'; e.size as usize]);
        let len = b.len() as u64;
        Ok(crate::storage::ReadStream { body: Box::pin(futures_util::stream::iter(vec![Ok(b)])), len: Some(len), total: Some(len), range: None, etag: None, content_type: None })
    }
    async fn write(
        &self,
        _: &str,
        path: &str,
        _: crate::storage::WriteSource,
        _: crate::storage::WriteOpts<'_>,
        _: crate::storage::Progress<'_>,
        _: &Arc<std::sync::atomic::AtomicBool>,
    ) -> crate::storage::SResult<crate::storage::WriteOutcome> {
        self.done.lock().unwrap().push(format!("write {path}"));
        crate::storage::unsupported()
    }
    async fn mkdir(&self, _: &str, _: &str) -> crate::storage::SResult<()> {
        Ok(())
    }
    async fn delete(&self, _: &str, files: &[String], _: &[String], _: &std::sync::atomic::AtomicBool, _: &(dyn Fn(u64, u64) + Send + Sync)) -> crate::storage::SResult<(u64, u64)> {
        for f in files {
            self.done.lock().unwrap().push(format!("delete {f}"));
            self.files.lock().unwrap().remove(f);
        }
        Ok((files.len() as u64, 0))
    }
    async fn copy(&self, from: &crate::storage::Loc, to: &crate::storage::Loc, _: bool) -> crate::storage::SResult<()> {
        self.done.lock().unwrap().push(format!("copy {} -> {}", from.path, to.path));
        let mut files = self.files.lock().unwrap();
        let mut e = files.get(&from.path).cloned().expect("copied file exists");
        e.key = to.path.clone();
        files.insert(to.path.clone(), e);
        Ok(())
    }
    async fn rename(&self, from: &crate::storage::Loc, to: &crate::storage::Loc, _: bool) -> crate::storage::SResult<()> {
        self.done.lock().unwrap().push(format!("rename {} -> {}", from.path, to.path));
        let mut files = self.files.lock().unwrap();
        let mut e = files.remove(&from.path).expect("renamed file exists");
        e.key = to.path.clone();
        files.insert(to.path.clone(), e);
        Ok(())
    }
}

async fn doc_drive() -> (Drive, Arc<DocStore>) {
    let base = std::env::temp_dir().join(format!("kybl-docs-{}", uuid::Uuid::new_v4()));
    let store = Arc::new(DocStore::new());
    let blocks = Arc::new(BlockCache::open(base.join("cache"), 64 * 1024 * 1024));
    let uploads = Arc::new(WriteBack::open(base.join("uploads")));
    let fs = KyblFs::new(opener(store.clone()), Spec { bucket: "d".into(), prefix: String::new(), read_only: false }, blocks, uploads);
    let srv = server::start(fs.clone(), 0, server::random_token(), false).await.unwrap();
    (Drive { _tmp: Tmp(base.clone()), data: base, fs, srv, http: crate::storage::net::http() }, store)
}

/// The `getcontentlength` a Depth 1 PROPFIND gives for `name` (already URL-encoded).
fn listed_len(xml: &str, name: &str) -> Option<u64> {
    let at = xml.find(&format!("/{name}<"))?;
    let rest = &xml[at..];
    let rest = &rest[..rest.find("response>").unwrap_or(rest.len())];
    let a = rest.find("getcontentlength>")? + "getcontentlength>".len();
    rest[a..].split('<').next()?.parse().ok()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn google_docs_show_as_shortcuts_that_open_in_the_browser() {
    let (d, store) = doc_drive().await;
    let (st, xml) = d.propfind("/").await;
    assert!(st.is_success(), "{st}");
    // every web-only kind gets a shortcut named for it; the bare names are gone
    for name in ["Plan.gdoc.html", "Budget.gsheet.html", "Survey.gform.html"] {
        assert!(xml.contains(&format!("/{name}<")), "{name} listed: {xml}");
    }
    assert!(!xml.contains("/Plan<") && !xml.contains("/Budget<"), "{xml}");
    // a real file keeps its name; the doc's shortcut gets a number instead
    assert!(xml.contains("/Report.gdoc.html<") && xml.contains("/Report%20%282%29.gdoc.html<"), "{xml}");
    assert_eq!(d.get("Report.gdoc.html").await.1, b"xxxxx");

    // the listed size is the page's, so a client reads all of it
    let (st, body) = d.get("Plan.gdoc.html").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(listed_len(&xml, "Plan.gdoc.html"), Some(body.len() as u64), "{xml}");
    let page = String::from_utf8(body).unwrap();
    assert!(page.contains("http-equiv=\"refresh\"") && page.contains("url=https://docs.example.test/p1/edit?a=1&amp;b=2\""), "{page}");
    assert!(page.contains("<title>Plan</title>"), "{page}");
    let (_, survey) = d.get("Survey.gform.html").await;
    assert!(String::from_utf8(survey).unwrap().contains("https://docs.example.test/s1/edit"));
    // the store was never asked for a doc's bytes
    assert!(!store.done().iter().any(|o| o.starts_with("read Plan") || o.starts_with("read Survey")), "{:?}", store.done());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn google_doc_shortcuts_are_read_only_and_rename_delete_and_copy_the_doc() {
    let (d, store) = doc_drive().await;
    // writing over a shortcut is refused and reaches nothing
    let r = d.req("PUT", "Plan.gdoc.html").await.body("nope").send().await.unwrap();
    assert!(r.status().is_client_error(), "{}", r.status());
    assert!(d.fs.0.uploads.pending().is_empty());
    assert!(store.has("Plan"));

    // renaming keeps the shortcut's ending off the doc's name
    let r = d.req("MOVE", "Plan.gdoc.html").await.header("Destination", d.url("Q3%20plan.gdoc.html")).send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    assert!(store.has("Q3 plan") && !store.has("Plan"), "{:?}", store.done());
    let (_, xml) = d.propfind("/").await;
    assert!(xml.contains("/Q3%20plan.gdoc.html<"), "{xml}");
    // moving into a folder moves the doc
    let r = d.req("MOVE", "Q3%20plan.gdoc.html").await.header("Destination", d.url("sub/Q3%20plan.gdoc.html")).send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    assert!(store.has("sub/Q3 plan"), "{:?}", store.done());
    // a name that isn't a shortcut's any more is refused
    let r = d.req("MOVE", "sub/Q3%20plan.gdoc.html").await.header("Destination", d.url("sub/plain")).send().await.unwrap();
    assert!(r.status().is_client_error(), "{}", r.status());
    assert!(store.has("sub/Q3 plan"));
    // and so is one that would land on a real file
    let r = d.req("MOVE", "Budget.gsheet.html").await.header("Destination", d.url("sub/keep.txt.html")).send().await.unwrap();
    assert!(!r.status().is_success(), "{}", r.status());
    assert!(store.has("sub/keep.txt") && store.has("Budget"));

    // Duplicate copies the doc itself (still live), named like its shortcut
    let r = d.req("COPY", "Budget.gsheet.html").await.header("Destination", d.url("Budget%20copy.gsheet.html")).send().await.unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    assert!(store.done().contains(&"copy Budget -> Budget copy".to_string()), "{:?}", store.done());

    // deleting the shortcut deletes the doc
    assert!(d.req("DELETE", "Budget.gsheet.html").await.send().await.unwrap().status().is_success());
    assert!(!store.has("Budget") && store.has("Budget copy"));
    assert!(!store.done().iter().any(|o| o.starts_with("write")), "{:?}", store.done());
}

#[test]
fn only_one_running_kybl_looks_after_the_drives() {
    let tmp = Tmp(std::env::temp_dir().join(format!("kybl-mount-owner-{}", uuid::Uuid::new_v4().simple())));
    std::fs::create_dir_all(&tmp.0).unwrap();
    let path = tmp.0.join("mounts.lock");
    let open = || std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path).unwrap();
    let first = match super::try_own(open()) {
        super::Owner::Mine(f) => f,
        _ => panic!("the first run takes the drives"),
    };
    assert!(matches!(super::try_own(open()), super::Owner::Other), "a second run must leave the first one's drives alone");
    drop(first);
    assert!(matches!(super::try_own(open()), super::Owner::Mine(_)), "once the first run ends, the drives can be taken over");
}

#[test]
fn saving_the_drives_at_once_never_fails_or_leaves_temp_files() {
    let tmp = Tmp(std::env::temp_dir().join(format!("kybl-mount-cfg-{}", uuid::Uuid::new_v4().simple())));
    let path = tmp.0.join("mounts.json");
    let cfg = |n: usize| super::MountConfig {
        id: format!("d{n}"),
        profile_id: "p".into(),
        bucket: "b".into(),
        prefix: String::new(),
        name: format!("Drive {n}"),
        read_only: false,
        port: 0,
        token: "t".into(),
        cache_limit_mb: None,
    };
    let threads: Vec<_> = (0..8)
        .map(|n| {
            let path = path.clone();
            let list: Vec<_> = (0..=n).map(cfg).collect();
            std::thread::spawn(move || super::write_configs(&path, &list))
        })
        .collect();
    for t in threads {
        assert_eq!(t.join().unwrap(), Ok(()), "a save at the same moment as another must not fail");
    }
    let back: Vec<super::MountConfig> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(!back.is_empty());
    let names: Vec<String> = std::fs::read_dir(&tmp.0).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["mounts.json"], "no temporary file is left behind");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600, "holds the drives' path tokens");
    }
}
