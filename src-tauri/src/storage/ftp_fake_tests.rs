//! The FTP backend against a small in-memory FTP server: plain FTP, passive data connections,
//! MLSD that (like some servers) calls a link to a folder a folder, LIST that shows links as
//! links, and knobs for the misbehaviours the tests need.

use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex as StdMutex;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Default)]
struct Fs {
    files: BTreeMap<String, Vec<u8>>,
    dirs: BTreeSet<String>,
    /// a link (path) to a folder (absolute path)
    links: BTreeMap<String, String>,
    /// sign-ins (one per new control connection)
    logins: usize,
    /// REST answered with 502
    refuse_rest: bool,
    /// the next RETR sends only this many bytes, then closes its data connection and says 226
    cut_next_retr: Option<usize>,
}

type Shared = Arc<StdMutex<Fs>>;

enum Child {
    File(usize),
    Dir,
    Link(String),
}

impl Fs {
    /// The path with every link on the way followed.
    fn resolve(&self, p: &str) -> String {
        let mut out = String::new();
        for part in p.split('/').filter(|s| !s.is_empty()) {
            let cand = format!("{out}/{part}");
            out = self.links.get(&cand).cloned().unwrap_or(cand);
        }
        if out.is_empty() { "/".into() } else { out }
    }

    fn is_dir(&self, p: &str) -> bool {
        let r = self.resolve(p);
        r == "/" || self.dirs.contains(&r)
    }

    fn children(&self, dir: &str) -> Vec<(String, Child)> {
        let d = self.resolve(dir);
        let under = |p: &str| {
            let (parent, name) = p.rsplit_once('/').unwrap();
            ((if parent.is_empty() { "/" } else { parent }) == d).then(|| name.to_string())
        };
        let mut out = Vec::new();
        out.extend(self.files.iter().filter_map(|(p, b)| under(p).map(|n| (n, Child::File(b.len())))));
        out.extend(self.dirs.iter().filter_map(|p| under(p).map(|n| (n, Child::Dir))));
        out.extend(self.links.iter().filter_map(|(p, t)| under(p).map(|n| (n, Child::Link(t.clone())))));
        out
    }

    fn mlsd(&self, dir: &str) -> Vec<String> {
        self.children(dir)
            .into_iter()
            .map(|(n, c)| match c {
                Child::File(len) => format!("type=file;size={len};modify=20260101000000; {n}"),
                // the misbehaviour: a link to a folder listed as a folder
                Child::Dir | Child::Link(_) => format!("type=dir;modify=20260101000000; {n}"),
            })
            .collect()
    }

    fn list(&self, dir: &str) -> Vec<String> {
        self.children(dir)
            .into_iter()
            .map(|(n, c)| match c {
                Child::File(len) => format!("-rw-r--r-- 1 u g {len} Jan 01 00:00 {n}"),
                Child::Dir => format!("drwxr-xr-x 1 u g 0 Jan 01 00:00 {n}"),
                Child::Link(t) => format!("lrwxrwxrwx 1 u g 4 Jan 01 00:00 {n} -> {t}"),
            })
            .collect()
    }
}

fn norm(cwd: &str, p: &str) -> String {
    if p.starts_with('/') { clean_base(p) } else { clean_base(&format!("{cwd}/{p}")) }
}

async fn server(fs: Shared) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { return };
            tokio::spawn(session(sock, fs.clone()));
        }
    });
    port
}

async fn session(sock: tokio::net::TcpStream, fs: Shared) {
    let (r, mut w) = sock.into_split();
    let mut lines = BufReader::new(r).lines();
    let _ = w.write_all(b"220 fake\r\n").await;
    let mut cwd = "/".to_string();
    let mut data: Option<tokio::net::TcpListener> = None;
    let mut rest: Option<usize> = None;
    let mut rename_from: Option<String> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        let (verb, arg) = line.split_once(' ').map_or((line.as_str(), ""), |(v, a)| (v, a));
        let verb = verb.to_ascii_uppercase();
        let path = norm(&cwd, arg);
        let reply: String = match verb.as_str() {
            "USER" => {
                fs.lock().unwrap().logins += 1;
                "331 password\r\n".into()
            }
            "PASS" => "230 in\r\n".into(),
            "FEAT" => "211-Features:\r\n MLST type*;size*;modify*;\r\n211 End\r\n".into(),
            "PWD" => "257 \"/\"\r\n".into(),
            "CWD" => {
                if fs.lock().unwrap().is_dir(&path) {
                    cwd = path;
                    "250 ok\r\n".into()
                } else {
                    "550 no such folder\r\n".into()
                }
            }
            "PASV" | "EPSV" => {
                let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let p = l.local_addr().unwrap().port();
                data = Some(l);
                if verb == "PASV" { format!("227 Entering Passive Mode (127,0,0,1,{},{})\r\n", p >> 8, p & 0xff) } else { format!("229 Entering Extended Passive Mode (|||{p}|)\r\n") }
            }
            "SIZE" => {
                let g = fs.lock().unwrap();
                match g.files.get(&g.resolve(&path)).map(Vec::len) {
                    Some(n) => format!("213 {n}\r\n"),
                    None => "550 no such file\r\n".into(),
                }
            }
            "MDTM" => "213 20260101000000\r\n".into(),
            "REST" => {
                if fs.lock().unwrap().refuse_rest {
                    "502 REST not implemented\r\n".into()
                } else {
                    rest = arg.trim().parse().ok();
                    "350 restarting\r\n".into()
                }
            }
            "RETR" => {
                let (bytes, cut) = {
                    let mut g = fs.lock().unwrap();
                    let r = g.resolve(&path);
                    (g.files.get(&r).cloned(), g.cut_next_retr.take())
                };
                let Some(bytes) = bytes else {
                    let _ = w.write_all(b"550 no such file\r\n").await;
                    continue;
                };
                let Some(l) = data.take() else { return };
                let _ = w.write_all(b"150 sending\r\n").await;
                let (mut d, _) = l.accept().await.unwrap();
                let from = rest.take().unwrap_or(0).min(bytes.len());
                let to = cut.map_or(bytes.len(), |c| (from + c).min(bytes.len()));
                let _ = d.write_all(&bytes[from..to]).await;
                let _ = d.shutdown().await;
                drop(d);
                "226 done\r\n".into()
            }
            "STOR" => {
                let Some(l) = data.take() else { return };
                let _ = w.write_all(b"150 send it\r\n").await;
                let (mut d, _) = l.accept().await.unwrap();
                let mut got = Vec::new();
                let _ = d.read_to_end(&mut got).await;
                let mut g = fs.lock().unwrap();
                let mut now = match rest.take() {
                    Some(at) => g.files.get(&path).map(|b| b[..at.min(b.len())].to_vec()).unwrap_or_default(),
                    None => Vec::new(),
                };
                now.extend(got);
                g.files.insert(path, now);
                "226 stored\r\n".into()
            }
            "DELE" => {
                let mut g = fs.lock().unwrap();
                // a link goes as a link
                if g.links.remove(&path).is_some() {
                    "250 deleted\r\n".into()
                } else {
                    let r = g.resolve(&path);
                    if g.files.remove(&r).is_some() { "250 deleted\r\n".into() } else { "550 no such file\r\n".into() }
                }
            }
            "RMD" => {
                let mut g = fs.lock().unwrap();
                if g.links.contains_key(&path) || !g.dirs.contains(&path) || !g.children(&path).is_empty() {
                    "550 can't\r\n".into()
                } else {
                    g.dirs.remove(&path);
                    "250 removed\r\n".into()
                }
            }
            "RNFR" => {
                rename_from = Some(path);
                "350 go on\r\n".into()
            }
            "RNTO" => {
                let mut g = fs.lock().unwrap();
                match rename_from.take().and_then(|f| g.files.remove(&f)) {
                    Some(b) => {
                        g.files.insert(path, b);
                        "250 renamed\r\n".into()
                    }
                    None => "550 no such file\r\n".into(),
                }
            }
            "MLSD" | "LIST" | "NLST" => {
                let dir = if arg.is_empty() || verb != "MLSD" { cwd.clone() } else { path };
                let out = {
                    let g = fs.lock().unwrap();
                    if verb == "MLSD" { g.mlsd(&dir) } else { g.list(&dir) }
                };
                let Some(l) = data.take() else { return };
                let _ = w.write_all(b"150 listing\r\n").await;
                let (mut d, _) = l.accept().await.unwrap();
                for o in out {
                    let _ = d.write_all(format!("{o}\r\n").as_bytes()).await;
                }
                let _ = d.shutdown().await;
                drop(d);
                "226 listed\r\n".into()
            }
            "QUIT" => {
                let _ = w.write_all(b"221 bye\r\n").await;
                return;
            }
            _ => "200 ok\r\n".into(),
        };
        if w.write_all(reply.as_bytes()).await.is_err() {
            return;
        }
    }
}

async fn backend(fs: &Shared) -> FtpBackend {
    let port = server(fs.clone()).await;
    let cfg = NetConfig { host: "127.0.0.1".into(), port, user: "u".into(), tls: TlsMode::None, base_path: "/base".into(), ..Default::default() };
    FtpBackend::new(&cfg, Some("pw".into())).unwrap()
}

fn fs_with(f: impl FnOnce(&mut Fs)) -> Shared {
    let mut fs = Fs::default();
    fs.dirs.insert("/base".into());
    f(&mut fs);
    Arc::new(StdMutex::new(fs))
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap().block_on(f)
}

/// Deleting a "folder" that is a link to a folder elsewhere removes the link and never empties
/// the folder it points at, even on a server whose MLSD calls the link a folder.
#[test]
fn deleting_a_link_to_a_folder_removes_only_the_link() {
    let fs = fs_with(|f| {
        f.dirs.insert("/base/releases".into());
        f.files.insert("/base/releases/app.bin".into(), b"precious".to_vec());
        f.links.insert("/base/current".into(), "/base/releases".into());
    });
    run(async {
        let b = backend(&fs).await;
        let page = b.list("", "", None).await.unwrap();
        assert!(page.folders.contains(&"current/".to_string()), "MLSD shows the link as a folder: {:?}", page.folders);
        b.delete("", &[], &["current/".to_string()], &AtomicBool::new(false), &|_, _| {}).await.unwrap();
        let g = fs.lock().unwrap();
        assert!(!g.links.contains_key("/base/current"), "the link is gone");
        assert_eq!(g.files.get("/base/releases/app.bin").map(Vec::as_slice), Some(&b"precious"[..]), "what it pointed at is untouched");
        assert!(g.dirs.contains("/base/releases"));
    });
    // a real folder is still deleted with everything in it
    let fs = fs_with(|f| {
        f.dirs.insert("/base/old".into());
        f.files.insert("/base/old/a.txt".into(), b"a".to_vec());
    });
    run(async {
        let b = backend(&fs).await;
        b.delete("", &[], &["old/".to_string()], &AtomicBool::new(false), &|_, _| {}).await.unwrap();
        let g = fs.lock().unwrap();
        assert!(!g.dirs.contains("/base/old") && g.files.is_empty());
    });
}

/// A data connection that closes before the size SIZE gave is a cut read: an error, which a
/// download picks up where it stopped, never a short file taken as whole.
#[test]
fn a_cut_transfer_is_never_a_whole_file() {
    let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let fs = fs_with(|f| {
        f.files.insert("/base/big.bin".into(), data.clone());
        f.cut_next_retr = Some(70_000);
    });
    run(async {
        let b = backend(&fs).await;
        // the stream itself says so
        let r = b.read("", "big.bin", None, None).await.unwrap();
        let mut body = r.body;
        let mut got = 0usize;
        let mut failed = false;
        while let Some(c) = body.next().await {
            match c {
                Ok(c) => got += c.len(),
                Err(e) => {
                    assert_eq!(e.kind(), std::io::ErrorKind::UnexpectedEof, "{e}");
                    failed = true;
                }
            }
        }
        assert!(failed && got == 70_000, "got {got}");
        // and a download carries on from there, ending with the whole file
        fs.lock().unwrap().cut_next_retr = Some(50_000);
        let dir = std::env::temp_dir().join(format!("kybl-ftp-{}", uuid::Uuid::new_v4().simple()));
        let dest = dir.join("big.bin");
        let mut dl = generic_cmds::Dl::default();
        let r = generic_cmds::download_resumable(&b, "", "big.bin", &dest, None, true, &AtomicBool::new(false), &|_, _| {}, None, &mut dl).await;
        assert!(matches!(r, Ok(crate::transfers::Outcome::Done)), "{:?}", r.err());
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        let _ = std::fs::remove_dir_all(dir);
    });
}

/// A file read to its end gives its connection back to the pool: reading several files doesn't
/// sign in once per file.
#[test]
fn whole_file_reads_return_their_connection() {
    let fs = fs_with(|f| {
        for i in 0..4 {
            f.files.insert(format!("/base/f{i}.txt"), vec![b'x'; 1000 + i]);
        }
    });
    run(async {
        let b = backend(&fs).await;
        for i in 0..4 {
            let r = b.read("", &format!("f{i}.txt"), None, None).await.unwrap();
            let mut body = r.body;
            let mut n = 0;
            while let Some(c) = body.next().await {
                n += c.unwrap().len();
            }
            assert_eq!(n, 1000 + i);
        }
        assert_eq!(fs.lock().unwrap().logins, 1, "one sign-in for all four reads");
    });
}

/// A server that refuses REST can't carry an upload on: the kept temporary file goes and the
/// upload starts over at once, instead of failing the same way on every Retry.
#[test]
fn an_upload_starts_over_where_rest_is_refused() {
    let tmp = temp_key("up.bin");
    let full: Vec<u8> = (0..60_000u32).map(|i| (i % 253) as u8).collect();
    let fs = fs_with(|f| {
        f.files.insert(format!("/base/{tmp}"), full[..20_000].to_vec());
        f.refuse_rest = true;
    });
    let dir = std::env::temp_dir().join(format!("kybl-ftp-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("up.bin");
    std::fs::write(&src, &full).unwrap();
    run(async {
        let b = backend(&fs).await;
        let opts = WriteOpts { resume: Some(ResumeState { upload_id: tmp.clone(), part_size: 0, parts: vec![] }), ..Default::default() };
        let r = b.write("", "up.bin", WriteSource::Path(src.clone()), opts, &|_, _| {}, &Arc::new(AtomicBool::new(false))).await;
        assert!(matches!(r, Ok(WriteOutcome::Done(_))), "{:?}", r.err());
        let g = fs.lock().unwrap();
        assert_eq!(g.files.get("/base/up.bin"), Some(&full));
        assert!(!g.files.contains_key(&format!("/base/{tmp}")), "the old temporary file is gone");
        assert_eq!(g.files.len(), 1, "{:?}", g.files.keys().collect::<Vec<_>>());
    });
    let _ = std::fs::remove_dir_all(dir);
}
