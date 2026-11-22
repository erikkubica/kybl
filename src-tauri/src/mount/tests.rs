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
    tokio::task::spawn_blocking(move || super::os::unmount(&m2, "")).await.unwrap().expect("unmounted");
    assert!(!super::os::is_mounted(&m));
}
