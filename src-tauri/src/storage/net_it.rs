//! The server backends against real servers: `rclone serve webdav|ftp|sftp` on a temporary
//! folder. Skipped (with a note) when rclone isn't installed.

use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::{Duration, Instant},
};

use bytes::Bytes;
use tauri::test::{mock_builder, mock_context, noop_assets};

use super::*;
use crate::{
    state::{NetAuth, NetConfig, TlsMode},
    storage::{ftp::FtpBackend, generic_cmds, sftp::SftpBackend, webdav::WebdavBackend},
    transfer::queue::Outcome,
};

const USER: &str = "kybl";
const PASS: &str = "s3cret pass";

struct Server {
    child: Child,
    dir: PathBuf,
    root: PathBuf,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn rclone() -> Option<PathBuf> {
    let out = Command::new("which").arg("rclone").output().ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!p.is_empty()).then(|| PathBuf::from(p))
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// Starts `rclone serve <proto>` on a fresh folder; None (test skipped) without rclone.
fn serve(proto: &str, extra: &[&str]) -> Option<Server> {
    serve_with(proto, extra, |_| vec![])
}

/// [`serve`], with arguments that depend on the port it listens on.
fn serve_with(proto: &str, extra: &[&str], more: impl Fn(u16) -> Vec<String>) -> Option<Server> {
    let Some(bin) = rclone() else {
        eprintln!("skipped: rclone isn't installed");
        return None;
    };
    let dir = std::env::temp_dir().join(format!("kybl-{proto}-{}", uuid::Uuid::new_v4().simple()));
    let root = dir.join("root");
    std::fs::create_dir_all(&root).unwrap();
    let port = free_port();
    let addr = format!("127.0.0.1:{port}");
    let mut cmd = Command::new(bin);
    cmd.args(["serve", proto, root.to_str().unwrap(), "--addr", &addr, "--user", USER, "--pass", PASS, "-q"])
        .args(["--config", dir.join("rclone.conf").to_str().unwrap(), "--cache-dir", dir.join("cache").to_str().unwrap()])
        .args(extra)
        .args(more(port))
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().unwrap();
    let server = Server { child, dir, root, port };
    let until = Instant::now() + Duration::from_secs(15);
    while std::net::TcpStream::connect(&addr).is_err() {
        assert!(Instant::now() < until, "rclone serve {proto} didn't start");
        std::thread::sleep(Duration::from_millis(100));
    }
    Some(server)
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
}

fn none(_: u64, _: u64) {}

async fn put(s: &dyn Storage, key: &str, data: &'static [u8]) -> Entry {
    let never = Arc::new(AtomicBool::new(false));
    match s.write("", key, WriteSource::Bytes(Bytes::from_static(data)), WriteOpts::default(), &none, &never).await.unwrap() {
        WriteOutcome::Done(e) => e,
        _ => panic!("write of {key} didn't finish"),
    }
}

async fn read_all(s: &dyn Storage, key: &str, range: Option<std::ops::Range<u64>>) -> Vec<u8> {
    s.read("", key, range, None).await.unwrap().collect(64 << 20).await.unwrap()
}

/// Leftovers of interrupted uploads (".name.kybl-…") anywhere below `dir`.
fn temp_files(dir: &Path) -> Vec<String> {
    walkdir::WalkDir::new(dir).into_iter().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".kybl-")).collect()
}

/// Everything a connection does, through the trait and through the generic commands, checked
/// against the folder the server serves.
/// `counts_inside`: a delete counts what a folder holds as it empties it (FTP, SFTP: item by item),
/// not only the folder (WebDAV: one request for all of it)
async fn exercise(s: &dyn Storage, disk: &Path, counts_inside: bool) {
    let roots = s.roots().await.unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].id, "");
    assert_eq!(roots[0].kind, RootKind::Folder);
    let never = Arc::new(AtomicBool::new(false));

    // folders and small files
    s.mkdir("", "a/b/").await.unwrap();
    assert!(disk.join("a/b").is_dir());
    let e = put(s, "a/b/hello.txt", b"hello world").await;
    assert_eq!((e.key.as_str(), e.size), ("a/b/hello.txt", 11));
    assert_eq!(std::fs::read(disk.join("a/b/hello.txt")).unwrap(), b"hello world");
    // a write makes the folders it goes in
    put(s, "deep/er/x y #1.txt", b"spaces & signs").await;
    assert_eq!(std::fs::read(disk.join("deep/er/x y #1.txt")).unwrap(), b"spaces & signs");

    // listing
    let p = s.list("", "", None).await.unwrap();
    assert_eq!(p.folders, vec!["a/", "deep/"]);
    let p = s.list("", "a/", None).await.unwrap();
    assert_eq!(p.folders, vec!["a/b/"]);
    assert!(p.objects.is_empty());
    let p = s.list("", "a/b/", None).await.unwrap();
    assert_eq!(p.objects.len(), 1);
    assert_eq!((p.objects[0].key.as_str(), p.objects[0].size), ("a/b/hello.txt", 11));
    assert!(p.objects[0].modified.is_some());
    assert_eq!(s.list("", "deep/er/", None).await.unwrap().objects[0].key, "deep/er/x y #1.txt");

    // stat
    let st = s.stat("", "a/b/hello.txt").await.unwrap().unwrap();
    assert_eq!(st.size, 11);
    assert!(st.etag.is_some());
    assert!(s.stat("", "a/b/nope.txt").await.unwrap().is_none());
    assert!(s.stat("", "a/b/").await.unwrap().is_some_and(|e| e.is_dir()));
    assert!(s.stat("", "a/b/hello.txt/").await.unwrap().is_none());
    assert!(s.stat("", "").await.unwrap().is_some());
    assert!(s.stat("", "../etc/passwd").await.is_err());

    // reads, whole and in part
    assert_eq!(read_all(s, "a/b/hello.txt", None).await, b"hello world");
    let r = s.read("", "a/b/hello.txt", Some(6..11), None).await.unwrap();
    assert_eq!(r.total, Some(11));
    assert_eq!(r.range, Some(6..11));
    assert_eq!(r.collect(100).await.unwrap(), b"world");
    assert_eq!(read_all(s, "a/b/hello.txt", Some(2..4)).await, b"ll");
    assert_eq!(s.read("", "a/b/hello.txt", Some(0..5), st.etag.as_deref()).await.unwrap().collect(100).await.unwrap(), b"hello");
    assert_eq!(s.read("", "a/b/hello.txt", None, Some("\"bogus\"")).await.err().map(|e| e.kind), Some(ErrKind::Conflict));
    let missing = s.read("", "a/b/missing.txt", None, None).await.err().unwrap();
    assert_eq!(missing.kind, ErrKind::NotFound, "{missing}");

    // conditional writes
    let bytes = |b: &'static [u8]| WriteSource::Bytes(Bytes::from_static(b));
    let pre = |p: Precondition| WriteOpts { precondition: p, ..Default::default() };
    let r = s.write("", "a/b/hello.txt", bytes(b"x"), pre(Precondition::IfMatch("\"bogus\"".into())), &none, &never).await.unwrap();
    assert!(matches!(r, WriteOutcome::Conflict(Some(_))));
    let r = s.write("", "a/b/hello.txt", bytes(b"x"), pre(Precondition::IfNoneMatch), &none, &never).await.unwrap();
    assert!(matches!(r, WriteOutcome::Conflict(_)));
    let r = s.write("", "a/b/hello.txt", bytes(b"hello again"), pre(Precondition::IfMatch(st.etag.clone().unwrap())), &none, &never).await.unwrap();
    assert!(matches!(r, WriteOutcome::Done(_)));
    assert_eq!(std::fs::read(disk.join("a/b/hello.txt")).unwrap(), b"hello again");
    let r = s.write("", "a/b/new.txt", bytes(b"n"), pre(Precondition::IfNoneMatch), &none, &never).await.unwrap();
    assert!(matches!(r, WriteOutcome::Done(_)));

    // a bigger file from disk: progress, and reads from the middle
    let local = disk.parent().unwrap().join("big.bin");
    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&local, &big).unwrap();
    let seen = Mutex::new((0u64, 0u64));
    let report = |d: u64, t: u64| *seen.lock().unwrap() = (d, t);
    let r = s.write("", "big/big.bin", WriteSource::Path(local.clone()), WriteOpts::default(), &report, &never).await.unwrap();
    assert!(matches!(r, WriteOutcome::Done(ref e) if e.size == 3_000_000));
    assert_eq!(*seen.lock().unwrap(), (3_000_000, 3_000_000));
    assert_eq!(std::fs::read(disk.join("big/big.bin")).unwrap(), big);
    assert_eq!(read_all(s, "big/big.bin", Some(1_000_000..1_000_100)).await, &big[1_000_000..1_000_100]);
    assert_eq!(read_all(s, "big/big.bin", None).await.len(), 3_000_000);
    // a read dropped half way leaves the connection usable
    {
        use futures_util::StreamExt;
        let mut r = s.read("", "big/big.bin", None, None).await.unwrap();
        let _ = r.body.next().await;
    }
    assert_eq!(read_all(s, "a/b/hello.txt", None).await, b"hello again");

    // a cancelled write leaves nothing behind
    let stop = Arc::new(AtomicBool::new(true));
    let r = s.write("", "big/stopped.bin", WriteSource::Path(local.clone()), WriteOpts::default(), &none, &stop).await.unwrap();
    assert!(matches!(r, WriteOutcome::Cancelled));
    assert!(!disk.join("big/stopped.bin").exists());
    assert_eq!(temp_files(disk), Vec::<String>::new());

    // renames
    s.rename(&Loc::new("", "a/b/hello.txt"), &Loc::new("", "a/c/hello2.txt"), false).await.unwrap();
    assert!(!disk.join("a/b/hello.txt").exists());
    assert_eq!(std::fs::read(disk.join("a/c/hello2.txt")).unwrap(), b"hello again");
    s.rename(&Loc::new("", "a/c/"), &Loc::new("", "moved/"), true).await.unwrap();
    assert!(disk.join("moved/hello2.txt").exists() && !disk.join("a/c").exists());
    // renaming a file over another replaces it
    put(s, "moved/other.txt", b"other").await;
    s.rename(&Loc::new("", "moved/other.txt"), &Loc::new("", "moved/hello2.txt"), false).await.unwrap();
    assert_eq!(std::fs::read(disk.join("moved/hello2.txt")).unwrap(), b"other");
    assert!(s.rename(&Loc::new("", ""), &Loc::new("", "x/"), true).await.is_err());

    // copies: on the server where it can, else through Kybl
    if s.caps().server_copy != ServerCopy::None {
        s.copy(&Loc::new("", "moved/"), &Loc::new("", "copied/"), true).await.unwrap();
    } else {
        generic_cmds::copy_through(s, &Loc::new("", "moved/"), &Loc::new("", "copied/"), true, &never).await.unwrap();
    }
    assert_eq!(std::fs::read(disk.join("copied/hello2.txt")).unwrap(), b"other");

    // the generic commands the UI calls
    let l = generic_cmds::list_objects(s, "", "", None).await.unwrap();
    assert!(l.folders.contains(&"copied/".to_string()));
    let h = generic_cmds::head_object(s, "", "copied/hello2.txt").await.unwrap();
    assert_eq!(h.size, 5);
    assert!(h.content_type.as_deref().is_some_and(|t| t.starts_with("text/plain")), "{:?}", h.content_type);
    let t = generic_cmds::get_text_preview(s, "", "big/big.bin", 10).await.unwrap();
    assert!(t.truncated);
    let ex = generic_cmds::existing_keys(s, "", vec!["copied/hello2.txt".into(), "nope".into()], vec!["moved/".into(), "gone/".into()]).await.unwrap();
    assert_eq!((ex.keys, ex.prefixes), (vec!["copied/hello2.txt".to_string()], vec!["moved/".to_string()]));
    let mut all: Vec<String> = generic_cmds::list_all_under(s, "", "").await.unwrap().into_iter().map(|f| f.key).collect();
    all.sort();
    assert_eq!(all, vec!["a/b/new.txt", "big/big.bin", "copied/hello2.txt", "deep/er/x y #1.txt", "moved/hello2.txt"]);
    let down = disk.parent().unwrap().join("down/big.bin");
    let r = generic_cmds::download(s, "", "big/big.bin", &down, &never, &report, None, None).await.unwrap();
    assert!(matches!(r, Outcome::Done));
    assert_eq!(std::fs::read(&down).unwrap(), big);
    let r = generic_cmds::upload(s, "", "up/again.bin", down.to_str().unwrap(), &never, &report).await.unwrap();
    assert!(matches!(r, Outcome::Done));
    assert_eq!(std::fs::read(disk.join("up/again.bin")).unwrap().len(), 3_000_000);

    // deletes: files, and folders with everything inside
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    let r = generic_cmds::delete_with(app.handle(), s, "", &["a/b/new.txt".into()], &["moved/".into(), "copied/".into(), "deep/".into(), "up/".into()], None, &AtomicBool::new(false)).await;
    // the five, and where folders empty item by item the five things in them (moved/ copied/ up/
    // one file each, deep/ a folder and its file)
    let n = if counts_inside { 10 } else { 5 };
    assert_eq!((r.done, r.total, r.error), (n, n, None));
    assert!(!disk.join("moved").exists() && !disk.join("deep").exists() && !disk.join("a/b/new.txt").exists());
    let stop = AtomicBool::new(true);
    assert!(s.delete("", &[], &["big/".into()], &stop, &|_, _| {}).await.err().is_some_and(|e| e.is_cancelled()));
    s.delete("", &[], &["big/".into(), "a/".into()], &AtomicBool::new(false), &|_, _| {}).await.unwrap();
    let p = s.list("", "", None).await.unwrap();
    assert!(p.folders.is_empty() && p.objects.is_empty(), "{p:?}");
}

fn net(port: u16) -> NetConfig {
    NetConfig { host: "127.0.0.1".into(), port, user: USER.into(), tls: TlsMode::None, ..Default::default() }
}

/// Two connections saved for one server and folder are known as one place (so a move between
/// them onto the same path keeps the file); another folder or server is another place.
#[test]
fn two_connections_to_one_place_are_known_as_one() {
    let other = |c: NetConfig| NetConfig { user: "someone-else".into(), host: "127.0.0.1".to_uppercase(), ..c };
    type Id = fn(&NetConfig) -> Option<String>;
    let ftp: Id = |c| FtpBackend::new(c, Some(PASS.into())).unwrap().place_id();
    let sftp: Id = |c| SftpBackend::new(c, Secrets { password: Some(PASS.into()), ssh: None }).unwrap().place_id();
    let dav: Id = |c| WebdavBackend::new(c, Some(PASS.into())).unwrap().place_id();
    for id in [ftp, sftp, dav] {
        let here = id(&net(2000));
        assert!(here.is_some());
        assert_eq!(here, id(&other(net(2000))));
        assert_ne!(here, id(&net(2001)), "another port");
        assert_ne!(here, id(&NetConfig { base_path: "sub".into(), ..net(2000) }), "another folder");
    }
    assert_ne!(ftp(&net(2000)), sftp(&net(2000)));
}

#[test]
fn webdav_against_rclone() {
    let Some(srv) = serve("webdav", &[]) else { return };
    rt().block_on(async {
        let b = WebdavBackend::new(&net(srv.port), Some(PASS.into())).unwrap();
        exercise(&b, &srv.root, false).await;
        let main = b;

        // a file never replaces a folder of the same name (MOVE/COPY with Overwrite: T would
        // delete the whole folder)
        main.mkdir("", "build/").await.unwrap();
        put(&main, "build/keep.txt", b"keep").await;
        put(&main, "loose.txt", b"loose").await;
        let never = Arc::new(AtomicBool::new(false));
        let e = main.write("", "build", WriteSource::Bytes(Bytes::from_static(b"file")), WriteOpts::default(), &none, &never).await.err().unwrap();
        assert_eq!(e.kind, ErrKind::Exists);
        assert_eq!(main.rename(&Loc::new("", "loose.txt"), &Loc::new("", "build"), false).await.unwrap_err().kind, ErrKind::Exists);
        assert_eq!(main.copy(&Loc::new("", "loose.txt"), &Loc::new("", "build"), false).await.unwrap_err().kind, ErrKind::Exists);
        assert_eq!(std::fs::read_to_string(srv.root.join("build/keep.txt")).unwrap(), "keep");
        assert!(temp_files(&srv.root).is_empty());

        // a wrong password says so
        let bad = WebdavBackend::new(&net(srv.port), Some("nope".into())).unwrap();
        assert_eq!(bad.roots().await.err().map(|e| e.kind), Some(ErrKind::NeedsAuth));
        // a base folder that isn't there
        // (made through the server: rclone caches its view of the folder)
        main.mkdir("", "sub/").await.unwrap();
        let cfg = NetConfig { base_path: "sub".into(), ..net(srv.port) };
        let b = WebdavBackend::new(&cfg, Some(PASS.into())).unwrap();
        b.roots().await.unwrap();
        put(&b, "in-sub.txt", b"x").await;
        assert!(srv.root.join("sub/in-sub.txt").exists());
        let cfg = NetConfig { url: Some(format!("http://127.0.0.1:{}/nothing-here", srv.port)), ..net(srv.port) };
        let b = WebdavBackend::new(&cfg, Some(PASS.into())).unwrap();
        assert_eq!(b.roots().await.err().map(|e| e.kind), Some(ErrKind::NotFound));
    });
}

#[test]
fn ftp_against_rclone() {
    // passive ports well away from the control port
    let passive = |port: u16| {
        let lo = if port < 30000 { 40000 } else { 20000 } + (port % 1000) * 10;
        vec!["--passive-port".to_string(), format!("{lo}-{}", lo + 9)]
    };
    let Some(srv) = serve_with("ftp", &[], passive) else { return };
    rt().block_on(async {
        let b = FtpBackend::new(&net(srv.port), Some(PASS.into())).unwrap();
        exercise(&b, &srv.root, true).await;
        let bad = FtpBackend::new(&net(srv.port), Some("nope".into())).unwrap();
        assert_eq!(bad.roots().await.err().map(|e| e.kind), Some(ErrKind::NeedsAuth));
        let cfg = NetConfig { base_path: "/not/there".into(), ..net(srv.port) };
        let b = FtpBackend::new(&cfg, Some(PASS.into())).unwrap();
        assert_eq!(b.roots().await.err().map(|e| e.kind), Some(ErrKind::NotFound));
    });
}

#[test]
fn sftp_against_rclone() {
    let keys = std::env::temp_dir().join(format!("kybl-keys-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&keys).unwrap();
    let key = keys.join("id");
    let made = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "pass phrase", "-C", "kybl-test", "-f", key.to_str().unwrap()]).status().is_ok_and(|s| s.success());
    let auth_keys = keys.join("authorized_keys");
    if made {
        std::fs::copy(keys.join("id.pub"), &auth_keys).unwrap();
    }
    let mut extra = vec![];
    if made {
        extra = vec!["--authorized-keys", auth_keys.to_str().unwrap()];
    }
    let Some(srv) = serve("sftp", &extra) else { return };
    rt().block_on(async {
        let pw = || Secrets { password: Some(PASS.into()), ssh: None };
        // first contact: the server's fingerprint comes back to be trusted
        let b = SftpBackend::new(&net(srv.port), pw()).unwrap();
        let e = b.roots().await.err().unwrap();
        assert_eq!(e.kind, ErrKind::UnknownHost, "{e}");
        let fp = sftp::hostkey::fingerprint_in(&e.to_string()).unwrap().to_string();
        assert!(fp.starts_with("SHA256:"), "{fp}");

        // a different saved key: refused outright
        let cfg = NetConfig { host_key: Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()), ..net(srv.port) };
        let e = SftpBackend::new(&cfg, pw()).unwrap().roots().await.err().unwrap();
        assert_eq!(e.kind, ErrKind::HostKeyChanged);

        let trusted = NetConfig { host_key: Some(fp.clone()), ..net(srv.port) };
        let b = SftpBackend::new(&trusted, pw()).unwrap();
        exercise(&b, &srv.root, true).await;
        assert!(b.quota().await.is_ok());

        let bad = SftpBackend::new(&trusted, Secrets { password: Some("nope".into()), ssh: None }).unwrap();
        assert_eq!(bad.roots().await.err().map(|e| e.kind), Some(ErrKind::NeedsAuth));

        if made {
            let pem = std::fs::read_to_string(&key).unwrap();
            let with_key = |pass: Option<&str>| Secrets { password: None, ssh: Some(SshKey { private_key: pem.clone(), passphrase: pass.map(str::to_string) }) };
            let kcfg = NetConfig { auth: NetAuth::Key, ..trusted.clone() };
            let b = SftpBackend::new(&kcfg, with_key(Some("pass phrase"))).unwrap();
            b.roots().await.unwrap();
            put(&b, "by-key.txt", b"k").await;
            assert!(srv.root.join("by-key.txt").exists());
            let e = SftpBackend::new(&kcfg, with_key(None)).unwrap().roots().await.err().unwrap();
            assert_eq!(e.kind, ErrKind::NeedsAuth);
            assert!(e.message.contains("passphrase"), "{}", e.message);
            let e = SftpBackend::new(&kcfg, with_key(Some("wrong"))).unwrap().roots().await.err().unwrap();
            assert_eq!(e.kind, ErrKind::NeedsAuth);
        } else {
            eprintln!("key sign-in skipped: ssh-keygen isn't available");
        }

        // a dropped connection is opened again
        let b = SftpBackend::new(&trusted, pw()).unwrap();
        b.roots().await.unwrap();
        b.conn.lock().await.as_ref().unwrap().handle.disconnect(russh::Disconnect::ByApplication, "", "").await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(b.list("", "", None).await.is_ok());
    });
    let _ = std::fs::remove_dir_all(&keys);
}

/// An upload stopped part-way (paused: `on_part` set, so its temporary file is kept) and started
/// again with what `on_part` handed out carries on from the bytes on the server, reading the
/// local file from there, and the file arrives whole with nothing left behind.
async fn uploads_carry_on_where_they_stopped(s: &dyn Storage, disk: &Path) {
    use std::sync::atomic::{AtomicU64, Ordering};
    let data: Vec<u8> = (0..3u32 << 20).map(|i| (i % 249) as u8).collect();
    let local = disk.parent().unwrap().join("resume-src.bin");
    std::fs::write(&local, &data).unwrap();
    let kept: Mutex<Option<ResumeState>> = Mutex::new(None);
    let on_part = |p: PartRecord| *kept.lock().unwrap() = Some(ResumeState { upload_id: p.etag, part_size: p.size, parts: vec![] });
    // the first attempt: a slow source that pulls the plug after 1 MiB
    let stop = Arc::new(AtomicBool::new(false));
    let (src, flag) = (data.clone(), stop.clone());
    let body: ByteStream = Box::pin(futures_util::stream::unfold(0usize, move |at| {
        let (src, flag) = (src.clone(), flag.clone());
        async move {
            if at >= src.len() {
                return None;
            }
            if at >= 1 << 20 {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let end = (at + (64 << 10)).min(src.len());
            Some((Ok(Bytes::copy_from_slice(&src[at..end])), end))
        }
    }));
    let opts = WriteOpts { on_part: Some(&on_part), ..Default::default() };
    let src = WriteSource::Stream { len: Some(data.len() as u64), body, reopen: None };
    let r = s.write("", "resume/big.bin", src, opts, &none, &stop).await;
    assert!(matches!(r, Ok(WriteOutcome::Cancelled)), "{:?}", r.err());
    let rs = kept.lock().unwrap().clone().expect("the temporary file was announced");
    let tmp = s.stat("", &rs.upload_id).await.unwrap().expect("the temporary file is kept to carry on");
    assert!(tmp.size >= 1 << 20, "{} bytes there", tmp.size);
    assert!(s.stat("", "resume/big.bin").await.unwrap().is_none());
    // carried on from the local file
    let first = AtomicU64::new(0);
    let report = |d: u64, _: u64| {
        if d > 0 {
            let _ = first.compare_exchange(0, d, Ordering::Relaxed, Ordering::Relaxed);
        }
    };
    let rs_id = rs.upload_id.clone();
    let opts = WriteOpts { resume: Some(rs), on_part: Some(&on_part), ..Default::default() };
    let never = Arc::new(AtomicBool::new(false));
    let r = s.write("", "resume/big.bin", WriteSource::Path(local.clone()), opts, &report, &never).await.unwrap();
    assert!(matches!(r, WriteOutcome::Done(_)));
    assert!(read_all(s, "resume/big.bin", None).await == data, "whole and in order");
    assert!(first.load(Ordering::Relaxed) >= 1 << 20, "carried on from {} bytes", first.load(Ordering::Relaxed));
    assert!(s.stat("", &rs_id).await.unwrap().is_none(), "the temporary file went in place");
    let _ = disk;
    // a resume state for another file is never taken up: a fresh upload
    let stray = ResumeState { upload_id: "elsewhere/.x.kybl-000000000000".into(), part_size: 0, parts: vec![] };
    let opts = WriteOpts { resume: Some(stray), ..Default::default() };
    s.write("", "resume/big.bin", WriteSource::Path(local.clone()), opts, &none, &never).await.unwrap();
    assert!(read_all(s, "resume/big.bin", None).await == data);
    let _ = std::fs::remove_file(local);
}

#[test]
fn ftp_uploads_carry_on_against_rclone() {
    let passive = |port: u16| {
        let lo = if port < 30000 { 41000 } else { 21000 } + (port % 1000) * 10;
        vec!["--passive-port".to_string(), format!("{lo}-{}", lo + 9)]
    };
    let Some(srv) = serve_with("ftp", &["--vfs-cache-mode", "writes"], passive) else { return };
    rt().block_on(async {
        let b = FtpBackend::new(&net(srv.port), Some(PASS.into())).unwrap();
        uploads_carry_on_where_they_stopped(&b, &srv.root).await;
    });
}

#[test]
fn sftp_uploads_carry_on_against_rclone() {
    let Some(srv) = serve("sftp", &["--vfs-cache-mode", "writes"]) else { return };
    rt().block_on(async {
        let pw = || Secrets { password: Some(PASS.into()), ssh: None };
        let e = SftpBackend::new(&net(srv.port), pw()).unwrap().roots().await.err().unwrap();
        let fp = sftp::hostkey::fingerprint_in(&e.to_string()).unwrap().to_string();
        let b = SftpBackend::new(&NetConfig { host_key: Some(fp), ..net(srv.port) }, pw()).unwrap();
        uploads_carry_on_where_they_stopped(&b, &srv.root).await;
    });
}

/// The shared HTTP client's TLS (rustls on ring, system roots) against public sites. Needs the
/// internet: `KYBL_TEST_NET=1`.
#[test]
fn https_works_with_the_shared_client() {
    if std::env::var("KYBL_TEST_NET").is_err() {
        return eprintln!("skipped: KYBL_TEST_NET not set");
    }
    rt().block_on(async {
        let r = http().get("https://www.example.com/").send().await.unwrap();
        assert!(r.status().is_success());
        // an HTTPS server that isn't WebDAV says so plainly
        let cfg = NetConfig { url: Some("https://www.example.com/".into()), user: "x".into(), ..Default::default() };
        let e = WebdavBackend::new(&cfg, Some("y".into())).unwrap().roots().await.err().unwrap();
        assert!(!matches!(e.kind, ErrKind::Network), "{e}");
        // a bad certificate is refused, in plain words
        let e = http().get("https://expired.badssl.com/").send().await.err().unwrap();
        let e = crate::storage::webdav::http_error(e);
        assert!(e.message.contains("certificate"), "{e}");
    });
}

/// Replacing a file (an upload over it, or a file moved onto it) on a real server: the new
/// content is there and no temporary or backup file is left.
async fn replaces_cleanly(s: &dyn Storage, disk: &Path) {
    put(s, "r/a.txt", b"old").await;
    put(s, "r/a.txt", b"new").await;
    assert_eq!(std::fs::read(disk.join("r/a.txt")).unwrap(), b"new");
    put(s, "r/b.txt", b"moved").await;
    s.rename(&Loc::new("", "r/b.txt"), &Loc::new("", "r/a.txt"), false).await.unwrap();
    assert_eq!(std::fs::read(disk.join("r/a.txt")).unwrap(), b"moved");
    assert!(!disk.join("r/b.txt").exists());
    assert_eq!(temp_files(disk), Vec::<String>::new());
}

#[test]
fn ftp_and_sftp_replace_files_without_leftovers() {
    let passive = |port: u16| {
        let lo = if port < 30000 { 41000 } else { 21000 } + (port % 1000) * 10;
        vec!["--passive-port".to_string(), format!("{lo}-{}", lo + 9)]
    };
    let Some(ftp) = serve_with("ftp", &[], passive) else { return };
    let Some(sftp) = serve("sftp", &[]) else { return };
    rt().block_on(async {
        replaces_cleanly(&FtpBackend::new(&net(ftp.port), Some(PASS.into())).unwrap(), &ftp.root).await;
        let pw = || Secrets { password: Some(PASS.into()), ssh: None };
        let e = SftpBackend::new(&net(sftp.port), pw()).unwrap().roots().await.err().unwrap();
        let fp = sftp::hostkey::fingerprint_in(&e.to_string()).unwrap().to_string();
        let b = SftpBackend::new(&NetConfig { host_key: Some(fp), ..net(sftp.port) }, pw()).unwrap();
        replaces_cleanly(&b, &sftp.root).await;
    });
}

/// A throwaway self-signed certificate and its key, for servers with their own certificate
/// (CN=ftp.example.test, so 127.0.0.1 is the wrong name too).
const OWN_CERT: &str = "-----BEGIN CERTIFICATE-----
MIIByTCCAW+gAwIBAgIUWigG6zlhc3l6jtMxnGkGBzYvpJswCgYIKoZIzj0EAwIw
MjEZMBcGA1UEAwwQZnRwLmV4YW1wbGUudGVzdDEVMBMGA1UECgwMRXhhbXBsZSBU
ZXN0MB4XDTI2MTEyMzA4MjY0OVoXDTM2MTEyMDA4MjY0OVowMjEZMBcGA1UEAwwQ
ZnRwLmV4YW1wbGUudGVzdDEVMBMGA1UECgwMRXhhbXBsZSBUZXN0MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEx/xE4wXOzCExrU0wczbEq01mxnlCcR3DIV49BLsr
CHevxfcHUJXvxwNH8du2gNsFOsvVT1jHjmYpuvxGfecnNKNjMGEwHQYDVR0OBBYE
FPjMu3wkmGyfOA+k68z7tFeQc/hwMA8GA1UdEwEB/wQFMAMBAf8wLwYDVR0RBCgw
JoIQZnRwLmV4YW1wbGUudGVzdIISZmlsZXMuZXhhbXBsZS50ZXN0MAoGCCqGSM49
BAMCA0gAMEUCIQDuxuQfHqFUkaWJFpf/j6w6nYewZyThL3kVsNpgNxNy8QIgZzII
BSz/1ArRW0tf2oYSPg+k++jDF7xJFFvP0adKvxc=
-----END CERTIFICATE-----
";
const OWN_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgicLYm4kiVEXFAcvh
2nymV3yHcB2HIk2hTMv7MP4D/IyhRANCAATH/ETjBc7MITGtTTBzNsSrTWbGeUJx
HcMhXj0EuysId6/F9wdQle/HA0fx27aA2wU6y9VPWMeOZim6/EZ95yc0
-----END PRIVATE KEY-----
";
const OWN_FP: &str = "94:55:1B:95:48:5F:AF:F2:72:2A:C5:BA:1C:1C:6E:2E:CA:AD:A1:C4:BC:20:2E:10:23:52:03:58:07:3B:46:FD";

/// FTPS and WebDAV over https with the server's own certificate: refused with its fingerprint,
/// accepted once trusted, refused loudly when another one was trusted.
#[test]
fn servers_with_their_own_certificate_connect_once_trusted() {
    let keys = std::env::temp_dir().join(format!("kybl-cert-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&keys).unwrap();
    let (cert, key) = (keys.join("cert.pem"), keys.join("key.pem"));
    std::fs::write(&cert, OWN_CERT).unwrap();
    std::fs::write(&key, OWN_KEY).unwrap();
    let tls = ["--cert", cert.to_str().unwrap(), "--key", key.to_str().unwrap()];
    let passive = |port: u16| {
        let lo = if port < 30000 { 42000 } else { 22000 } + (port % 1000) * 10;
        vec!["--passive-port".to_string(), format!("{lo}-{}", lo + 9)]
    };
    let Some(ftp) = serve_with("ftp", &tls, passive) else { return };
    let Some(dav) = serve("webdav", &tls) else { return };
    rt().block_on(async {
        // rclone's FTP server speaks TLS from the first byte when given a certificate
        let ftp_cfg = |pin: Option<&str>| NetConfig { tls: TlsMode::Implicit, cert_fingerprint: pin.map(str::to_string), ..net(ftp.port) };
        let dav_cfg = |pin: Option<&str>| NetConfig { url: Some(format!("https://127.0.0.1:{}/", dav.port)), tls: TlsMode::Implicit, cert_fingerprint: pin.map(str::to_string), ..net(dav.port) };
        let ftp_b = |pin| FtpBackend::new(&ftp_cfg(pin), Some(PASS.into())).unwrap();
        let dav_b = |pin| WebdavBackend::new(&dav_cfg(pin), Some(PASS.into())).unwrap();
        let other = "00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF";

        for (what, unknown, changed) in [
            ("ftp", ftp_b(None).roots().await.err(), ftp_b(Some(other)).roots().await.err()),
            ("webdav", dav_b(None).roots().await.err(), dav_b(Some(other)).roots().await.err()),
        ] {
            let e = unknown.unwrap_or_else(|| panic!("{what}: an unknown certificate connected"));
            assert_eq!(e.kind, ErrKind::UntrustedCert, "{what}: {e}");
            let d = e.detail.clone().unwrap();
            assert!(d.starts_with(&format!("cert-untrusted {OWN_FP}\nreason: self-signed")), "{what}: {d}");
            assert!(d.contains("\nname: ftp.example.test\n"), "{what}: {d}");
            let e = changed.unwrap_or_else(|| panic!("{what}: another certificate than the trusted one connected"));
            assert_eq!(e.kind, ErrKind::CertChanged, "{what}: {e}");
            assert!(e.detail.unwrap().starts_with(&format!("cert-changed {OWN_FP} expected {other}")));
        }

        // trusted: everything works, data connections included
        let b = ftp_b(Some(OWN_FP));
        put(&b, "t/a.txt", b"over tls").await;
        assert_eq!(read_all(&b, "t/a.txt", None).await, b"over tls");
        assert_eq!(std::fs::read(ftp.root.join("t/a.txt")).unwrap(), b"over tls");
        let b = dav_b(Some(&OWN_FP.to_lowercase()));
        put(&b, "t/b.txt", b"over https").await;
        assert_eq!(read_all(&b, "t/b.txt", None).await, b"over https");
    });
    let _ = std::fs::remove_dir_all(&keys);
}

/// Permissions and symbolic links against the system's own OpenSSH server, run as this user on a
/// free port (rclone's server keeps neither). Needs `sshd` and `ssh-keygen`:
/// `cargo test --lib sftp_permissions_and_links_against_openssh -- --ignored`
#[cfg(unix)]
#[test]
#[ignore]
fn sftp_permissions_and_links_against_openssh() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let Some(sshd) = ["/usr/sbin/sshd", "/usr/bin/sshd"].into_iter().map(PathBuf::from).find(|p| p.exists()) else {
        eprintln!("skipped: no sshd");
        return;
    };
    let dir = std::env::temp_dir().join(format!("kybl-sshd-{}", uuid::Uuid::new_v4().simple()));
    let root = dir.join("root");
    std::fs::create_dir_all(root.join("dir")).unwrap();
    let keygen = |name: &str| Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f", dir.join(name).to_str().unwrap()]).status().unwrap().success();
    assert!(keygen("host") && keygen("user"));
    std::fs::copy(dir.join("user.pub"), dir.join("authorized_keys")).unwrap();
    let port = free_port();
    let conf = format!(
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host\nAuthorizedKeysFile {d}/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nPidFile {d}/pid\nSubsystem sftp internal-sftp\n",
        d = dir.display()
    );
    std::fs::write(dir.join("sshd_config"), conf).unwrap();
    let mut child = Command::new(&sshd).args(["-D", "-e", "-f", dir.join("sshd_config").to_str().unwrap()]).stderr(Stdio::null()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }

    std::fs::write(root.join("a.txt"), "a").unwrap();
    std::fs::set_permissions(root.join("a.txt"), std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::write(root.join("dir/inside.txt"), "keep me").unwrap();
    symlink("dir", root.join("dirlink")).unwrap();
    symlink("nowhere", root.join("broken")).unwrap();
    symlink("/", root.join("outside")).unwrap();

    let user = std::env::var("USER").unwrap();
    let key = std::fs::read_to_string(dir.join("user")).unwrap();
    let secrets = || Secrets { password: None, ssh: Some(SshKey { private_key: key.clone(), passphrase: None }) };
    let base = std::fs::canonicalize(&root).unwrap().to_string_lossy().into_owned();
    let cfg = NetConfig { host: "127.0.0.1".into(), port, user, auth: NetAuth::Key, base_path: base, ..Default::default() };
    rt().block_on(async {
        let e = SftpBackend::new(&cfg, secrets()).unwrap().roots().await.err().unwrap();
        let fp = sftp::hostkey::fingerprint_in(&e.to_string()).unwrap_or_else(|| panic!("{e}")).to_string();
        let b = SftpBackend::new(&NetConfig { host_key: Some(fp), ..cfg.clone() }, secrets()).unwrap();

        let page = b.list("", "", None).await.unwrap();
        let a = page.objects.iter().find(|e| e.key == "a.txt").unwrap();
        assert_eq!((a.mode, a.link.as_deref()), (Some(0o644), None));
        assert!(a.owner.is_some());
        assert!(page.folders.contains(&"dirlink/".to_string()));
        let dl = page.folder_info.iter().find(|e| e.key == "dirlink/").unwrap();
        assert_eq!(dl.link.as_deref(), Some("dir"));
        let broken = page.objects.iter().find(|e| e.key == "broken").unwrap();
        assert_eq!((broken.link.as_deref(), broken.size), (Some("nowhere"), 0));

        b.set_mode("", "a.txt", 0o600).await.unwrap();
        assert_eq!(std::fs::metadata(root.join("a.txt")).unwrap().permissions().mode() & 0o7777, 0o600);
        assert_eq!(b.list("", "", None).await.unwrap().objects.iter().find(|e| e.key == "a.txt").unwrap().mode, Some(0o600));

        b.make_link("", "made", "a.txt").await.unwrap();
        assert_eq!(std::fs::read_link(root.join("made")).unwrap(), Path::new("a.txt"));
        assert_eq!(b.make_link("", "made", "a.txt").await.unwrap_err().kind, ErrKind::Exists);

        assert_eq!(b.resolve_link("", "dirlink/").await.unwrap().key, "dir/");
        assert_eq!(b.resolve_link("", "made").await.unwrap().key, "a.txt");
        assert_eq!(b.resolve_link("", "broken").await.unwrap_err().kind, ErrKind::NotFound);
        assert!(b.resolve_link("", "outside/").await.unwrap_err().message.contains("outside"));

        // a link back up (tree/deep/up → tree/): everything that goes through folders stops at
        // it instead of going round forever
        std::fs::create_dir_all(root.join("tree/deep")).unwrap();
        std::fs::write(root.join("tree/f.txt"), "f").unwrap();
        std::fs::write(root.join("tree/deep/g.txt"), "gg").unwrap();
        symlink("..", root.join("tree/deep/up")).unwrap();
        // (a walk that went round the link would never end)
        macro_rules! soon {
            ($f:expr) => {
                tokio::time::timeout(Duration::from_secs(30), $f)
            };
        }
        let never = Arc::new(AtomicBool::new(false));
        let mut all: Vec<String> = soon!(generic_cmds::list_all_under(&b, "", "tree/")).await.expect("the walk ends").unwrap().into_iter().map(|f| f.key).collect();
        all.sort();
        assert_eq!(all, ["tree/deep/g.txt", "tree/f.txt"]);
        let size = soon!(generic_cmds::size_scan(&b, "", "tree/", &never, |_, _| {})).await.expect("the size count ends").unwrap();
        assert_eq!((size.bytes, size.objects), (3, 2));
        let found = soon!(generic_cmds::search_scan(&b, "", "tree/", "g.txt", 10_000, 100, &never, |_, _| {})).await.expect("the search ends").unwrap();
        assert_eq!(found.objects.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), ["tree/deep/g.txt"]);
        // a copy inside the connection keeps the link a link
        soon!(generic_cmds::copy_through(&b, &Loc::new("", "tree/"), &Loc::new("", "copy/"), true, &never)).await.expect("the copy ends").unwrap();
        assert_eq!(std::fs::read_link(root.join("copy/deep/up")).unwrap(), Path::new(".."));
        assert_eq!(std::fs::read_to_string(root.join("copy/deep/g.txt")).unwrap(), "gg");
        assert!(root.join("copy/f.txt").exists());
        // and deleting the copy removes its link, not what it points at
        b.delete("", &[], &["copy/".into()], &AtomicBool::new(false), &none).await.unwrap();
        assert!(!root.join("copy").exists());
        assert!(root.join("tree/deep/g.txt").exists());

        // deleting a link to a folder removes the link, never the folder's files
        b.delete("", &[], &["dirlink/".into()], &AtomicBool::new(false), &none).await.unwrap();
        assert!(std::fs::symlink_metadata(root.join("dirlink")).is_err());
        assert!(root.join("dir/inside.txt").exists());
        // and a folder holding a link to another folder goes without emptying that one
        std::fs::create_dir(root.join("holder")).unwrap();
        symlink("../dir", root.join("holder/to-dir")).unwrap();
        b.delete("", &[], &["holder/".into()], &AtomicBool::new(false), &none).await.unwrap();
        assert!(!root.join("holder").exists());
        assert!(root.join("dir/inside.txt").exists());

        // replacing a file keeps its mode, and writing to a link updates what it points at
        std::fs::write(root.join("secret.env"), "old").unwrap();
        std::fs::set_permissions(root.join("secret.env"), std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(root.join("run.sh"), "old").unwrap();
        std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        symlink("dir/inside.txt", root.join("inside-link")).unwrap();
        for (key, body) in [("secret.env", b"new" as &'static [u8]), ("run.sh", b"echo"), ("inside-link", b"through the link")] {
            assert_eq!(put(&b, key, body).await.key, key);
        }
        let mode = |p: &str| std::fs::metadata(root.join(p)).unwrap().permissions().mode() & 0o7777;
        assert_eq!((mode("secret.env"), mode("run.sh")), (0o600, 0o755));
        assert!(std::fs::symlink_metadata(root.join("inside-link")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(root.join("dir/inside.txt")).unwrap(), "through the link");

        // "only if nothing is there" holds to the end of the upload
        let racer = root.join("race.txt");
        let body: crate::storage::ByteStream = Box::pin(futures_util::stream::once(async move {
            std::fs::write(&racer, "theirs").unwrap();
            Ok(Bytes::from_static(b"mine"))
        }));
        let pre = WriteOpts { precondition: Precondition::IfNoneMatch, ..Default::default() };
        let out = b.write("", "race.txt", WriteSource::Stream { len: Some(4), body, reopen: None }, pre, &none, &never).await.unwrap();
        assert!(matches!(out, WriteOutcome::Conflict(Some(_))), "refused, not replaced");
        assert_eq!(std::fs::read_to_string(root.join("race.txt")).unwrap(), "theirs");
        assert!(temp_files(&root).is_empty());
    });
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}
