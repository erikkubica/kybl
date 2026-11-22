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
    transfers::Outcome,
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
async fn exercise(s: &dyn Storage, disk: &Path) {
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
    let r = generic_cmds::download(s, "", "big/big.bin", &down, &never, &report).await.unwrap();
    assert!(matches!(r, Outcome::Done));
    assert_eq!(std::fs::read(&down).unwrap(), big);
    let r = generic_cmds::upload(s, "", "up/again.bin", down.to_str().unwrap(), &never, &report).await.unwrap();
    assert!(matches!(r, Outcome::Done));
    assert_eq!(std::fs::read(disk.join("up/again.bin")).unwrap().len(), 3_000_000);

    // deletes: files, and folders with everything inside
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    let r = generic_cmds::delete_with(app.handle(), s, "", &["a/b/new.txt".into()], &["moved/".into(), "copied/".into(), "deep/".into(), "up/".into()], None, &AtomicBool::new(false)).await;
    assert_eq!((r.done, r.total, r.error), (5, 5, None));
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

#[test]
fn webdav_against_rclone() {
    let Some(srv) = serve("webdav", &[]) else { return };
    rt().block_on(async {
        let b = WebdavBackend::new(&net(srv.port), Some(PASS.into())).unwrap();
        exercise(&b, &srv.root).await;
        let main = b;

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
        exercise(&b, &srv.root).await;
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
        exercise(&b, &srv.root).await;
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
