use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
};

use futures_util::StreamExt;

use super::{
    backend::ArchiveBackend,
    decode_id, encode_id,
    index::{safe_key, Format, Index},
    ops, remote,
};
use crate::storage::{local::LocalBackend, RootKind, Storage};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let d = std::env::temp_dir().join(format!("kybl-archive-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        Scratch(std::fs::canonicalize(d).unwrap())
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn no() -> AtomicBool {
    AtomicBool::new(false)
}

/// A zip with nested folders, an explicit empty folder, and the classic hostile entries.
fn hostile_zip(path: &Path) {
    let f = std::fs::File::create(path).unwrap();
    let mut z = zip::ZipWriter::new(f);
    let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, body) in [
        ("site/index.html", "<h1>hi</h1>".repeat(50)),
        ("site/css/app.css", "body{}".into()),
        ("site/notes.txt", "hello archive\n".into()),
        ("../evil.txt", "escaped".into()),
        ("/etc/abs.txt", "absolute".into()),
        ("site/../../up.txt", "escaped too".into()),
        ("C:\\win.txt", "drive".into()),
        ("site\\win\\back.txt", "backslashes".into()),
    ] {
        z.start_file(name, o).unwrap();
        z.write_all(body.as_bytes()).unwrap();
    }
    z.add_directory("site/empty/", o).unwrap();
    z.add_symlink("site/link", "/etc/passwd", o).unwrap();
    z.finish().unwrap();
}

#[test]
fn safe_keys_never_leave_the_folder() {
    assert_eq!(safe_key("a/b.txt", false).as_deref(), Some("a/b.txt"));
    assert_eq!(safe_key("./a//b/", true).as_deref(), Some("a/b/"));
    assert_eq!(safe_key("a\\b.txt", false).as_deref(), Some("a/b.txt"));
    for bad in ["../x", "a/../../x", "a/..", "/etc/passwd", "\\\\server\\x", "C:\\x", "c:x", "a\0b", "", "./", ".."] {
        assert_eq!(safe_key(bad, false), None, "{bad:?}");
    }
    // `..` inside a name is just a name
    assert_eq!(safe_key("a..b/c", false).as_deref(), Some("a..b/c"));
}

#[test]
fn ids_round_trip() {
    let id = encode_id("local", "/Users/me", "Downloads/site backup.zip");
    assert!(id.starts_with("archive:") && !id.contains('/'));
    assert_eq!(decode_id(&id), Some(("local".into(), "/Users/me".into(), "Downloads/site backup.zip".into())));
    assert_eq!(decode_id("archive:%%%"), None);
}

#[test]
fn formats_by_name() {
    assert_eq!(Format::of("A.ZIP"), Some(Format::Zip));
    assert_eq!(Format::of("x.tar.gz"), Some(Format::TarGz));
    assert_eq!(Format::of("x.tgz"), Some(Format::TarGz));
    assert_eq!(Format::of("x.tar"), Some(Format::Tar));
    assert_eq!(Format::of("x.gz"), None);
}

#[test]
fn zip_listing_leaves_out_hostile_entries() {
    let s = Scratch::new();
    let p = s.0.join("site.zip");
    hostile_zip(&p);
    let ix = Index::open(&p, Format::Zip, &s.0, &no()).unwrap();
    assert_eq!(ix.top(), vec!["site/".to_string()]);
    let (dirs, files) = ix.list("site/");
    assert_eq!(dirs, vec!["site/css/", "site/empty/", "site/win/"]);
    assert_eq!(files.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(), vec!["site/index.html", "site/notes.txt"]);
    assert_eq!(ix.skipped.unsafe_paths, 4, "../evil, /etc/abs, site/../../up, C:\\win");
    assert_eq!(ix.skipped.links, 1);
    assert!(ix.item("site/win/back.txt").is_some());
    assert!(ix.items.iter().all(|i| !i.key.contains("..") && !i.key.starts_with('/')));
    assert_eq!(ix.total, 550 + 6 + 14 + 11);
}

#[test]
fn reads_files_and_ranges_out_of_a_zip() {
    let s = Scratch::new();
    let p = s.0.join("site.zip");
    hostile_zip(&p);
    let ix = Index::open(&p, Format::Zip, &s.0, &no()).unwrap();
    let it = ix.item("site/notes.txt").unwrap();
    let mut all = Vec::new();
    ix.read(it, None, &mut |c| {
        all.extend_from_slice(c);
        true
    })
    .unwrap();
    assert_eq!(all, b"hello archive\n");
    let mut part = Vec::new();
    ix.read(it, Some(6..13), &mut |c| {
        part.extend_from_slice(c);
        true
    })
    .unwrap();
    assert_eq!(part, b"archive");
}

/// A tar whose entries are written raw, so names the tar crate's builder refuses get in too.
fn raw_tar(path: &Path, entries: &[(&str, tar::EntryType, &[u8])]) {
    let f = std::fs::File::create(path).unwrap();
    let mut b = tar::Builder::new(f);
    for (name, kind, body) in entries {
        let mut h = tar::Header::new_ustar();
        let n = name.as_bytes();
        h.as_old_mut().name[..n.len()].copy_from_slice(n);
        h.set_entry_type(*kind);
        h.set_size(body.len() as u64);
        h.set_mode(0o644);
        h.set_mtime(1_700_000_000);
        if *kind == tar::EntryType::Symlink {
            h.set_link_name("/etc/passwd").unwrap();
        }
        h.set_cksum();
        b.append(&h, *body).unwrap();
    }
    b.finish().unwrap();
}

#[test]
fn tar_and_tar_gz_list_and_read() {
    let s = Scratch::new();
    let entries: &[(&str, tar::EntryType, &[u8])] = &[
        ("app/", tar::EntryType::Directory, b""),
        ("app/main.rs", tar::EntryType::Regular, b"fn main() {}\n"),
        ("app/deep/x.txt", tar::EntryType::Regular, b"x"),
        ("../../etc/cron.d/evil", tar::EntryType::Regular, b"* * * * * root sh"),
        ("app/link", tar::EntryType::Symlink, b""),
    ];
    let tar_path = s.0.join("app.tar");
    raw_tar(&tar_path, entries);
    let ix = Index::open(&tar_path, Format::Tar, &s.0, &no()).unwrap();
    assert_eq!(ix.top(), vec!["app/".to_string()]);
    assert_eq!(ix.list("app/").0, vec!["app/deep/"]);
    assert_eq!(ix.skipped.unsafe_paths, 1);
    assert_eq!(ix.skipped.links, 1);
    let it = ix.item("app/main.rs").unwrap();
    assert_eq!(it.modified, Some(1_700_000_000_000));
    let mut got = Vec::new();
    ix.read(it, None, &mut |c| {
        got.extend_from_slice(c);
        true
    })
    .unwrap();
    assert_eq!(got, b"fn main() {}\n");

    // the same as .tar.gz
    let gz_path = s.0.join("app.tar.gz");
    let mut enc = flate2::write::GzEncoder::new(std::fs::File::create(&gz_path).unwrap(), flate2::Compression::default());
    enc.write_all(&std::fs::read(&tar_path).unwrap()).unwrap();
    enc.finish().unwrap();
    let work = s.0.join("work");
    let gz = Index::open(&gz_path, Format::TarGz, &work, &no()).unwrap();
    assert_eq!(gz.items.len(), 2);
    assert!(gz.item("app/deep/x.txt").is_some());
}

#[test]
fn refuses_decompression_bombs() {
    let s = Scratch::new();
    let p = s.0.join("bomb.zip");
    let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
    let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    z.start_file("zeros.bin", o).unwrap();
    let chunk = vec![0u8; 1 << 20];
    // 1.2 GB of zeros deflates to about a megabyte: far past the ratio limit
    for _ in 0..1200 {
        z.write_all(&chunk).unwrap();
    }
    z.finish().unwrap();
    let err = Index::open(&p, Format::Zip, &s.0, &no()).err().expect("refused");
    assert!(err.to_string().contains("decompression bomb"), "{err}");
}

#[tokio::test]
async fn backend_lists_reads_and_stays_read_only() {
    let s = Scratch::new();
    let p = s.0.join("site.zip");
    hostile_zip(&p);
    let ix = Arc::new(Index::open(&p, Format::Zip, &s.0, &no()).unwrap());
    let b = ArchiveBackend::new("site.zip".into(), ix);
    let page = b.list("site.zip", "", None).await.unwrap();
    assert_eq!(page.folders, vec!["site/"]);
    let page = b.list("site.zip", "site/", None).await.unwrap();
    assert_eq!(page.objects.len(), 2);
    assert!(page.objects.iter().all(|o| o.etag.is_some()));
    let r = b.read("site.zip", "site/notes.txt", None, None).await.unwrap();
    assert_eq!(r.collect(1 << 20).await.unwrap(), b"hello archive\n");
    assert!(b.stat("site.zip", "site/css/").await.unwrap().is_some());
    assert!(b.stat("site.zip", "nope.txt").await.unwrap().is_none());
    assert!(b.mkdir("site.zip", "x/").await.is_err());
}

/// Unpacked from an archive that came from elsewhere: the files carry the downloaded-file mark;
/// from one of this computer's own, they don't.
#[cfg(target_os = "macos")]
#[tokio::test]
async fn files_from_an_archive_of_elsewhere_are_marked() {
    use crate::platform::quarantine::is_marked;
    let s = Scratch::new();
    let p = s.0.join("site.zip");
    hostile_zip(&p);
    let ix = Arc::new(Index::open(&p, Format::Zip, &s.0, &no()).unwrap());
    let cancel = Arc::new(AtomicBool::new(false));
    for mark in [true, false] {
        let out = s.0.join(format!("out-{mark}"));
        std::fs::create_dir_all(&out).unwrap();
        let dst: Arc<dyn Storage> = Arc::new(LocalBackend::with_roots(vec![("out".into(), RootKind::Folder, out.clone())], false));
        let root = out.to_string_lossy().into_owned();
        let mut plan = ops::plan_extract(&ix, &[], "", "", None, &Default::default());
        plan.mark = mark;
        ops::extract(ix.clone(), dst, &root, &plan, false, &|_| {}, &cancel).await.unwrap();
        assert_eq!(is_marked(&out.join("site/notes.txt")), mark);
    }
}

#[tokio::test]
async fn extracts_into_a_new_folder_without_nesting_it_twice() {
    let s = Scratch::new();
    let p = s.0.join("site.zip");
    hostile_zip(&p);
    let out = s.0.join("out");
    std::fs::create_dir_all(&out).unwrap();
    let ix = Arc::new(Index::open(&p, Format::Zip, &s.0, &no()).unwrap());
    let dst: Arc<dyn Storage> = Arc::new(LocalBackend::with_roots(vec![("out".into(), RootKind::Folder, out.clone())], false));
    let root = out.to_string_lossy().into_owned();

    // "site.zip" holds one top folder "site/": unpacking into "site" doesn't make site/site
    let plan = ops::plan_extract(&ix, &[], "", "", Some("site"), &Default::default());
    assert!(plan.files.iter().all(|(_, k)| k.starts_with("site/") && !k.starts_with("site/site/")));
    let cancel = Arc::new(AtomicBool::new(false));
    let (written, skipped) = ops::extract(ix.clone(), dst.clone(), &root, &plan, false, &|_| {}, &cancel).await.unwrap();
    assert_eq!((written, skipped), (4, 0));
    assert_eq!(std::fs::read_to_string(out.join("site/notes.txt")).unwrap(), "hello archive\n");
    assert!(out.join("site/empty").is_dir(), "empty folders come along");
    assert!(!s.0.join("evil.txt").exists() && !out.join("evil.txt").exists() && !s.0.join("up.txt").exists());
    assert!(!out.join("site/link").exists());

    // again without replacing: what's there stays, and is counted as skipped
    std::fs::write(out.join("site/notes.txt"), "mine").unwrap();
    let (_, skipped) = ops::extract(ix.clone(), dst.clone(), &root, &plan, false, &|_| {}, &cancel).await.unwrap();
    assert_eq!(skipped, 4);
    assert_eq!(std::fs::read_to_string(out.join("site/notes.txt")).unwrap(), "mine");
    // replacing
    ops::extract(ix.clone(), dst.clone(), &root, &plan, true, &|_| {}, &cancel).await.unwrap();
    assert_eq!(std::fs::read_to_string(out.join("site/notes.txt")).unwrap(), "hello archive\n");

    // a selection from inside, relative to the folder on screen
    let picked = ["site/css/".to_string(), "site/notes.txt".to_string()];
    let plan = ops::plan_extract(&ix, &picked, "site/", "picked/", None, &Default::default());
    let keys: Vec<&str> = plan.files.iter().map(|(_, k)| k.as_str()).collect();
    assert_eq!(keys, vec!["picked/css/app.css", "picked/notes.txt"]);
    // "Keep both": picked entries under new names; a rename never takes a path along
    let renames = [("site/css/".to_string(), "css (1)".to_string()), ("site/notes.txt".to_string(), "../notes.txt".to_string())].into();
    let plan = ops::plan_extract(&ix, &picked, "site/", "picked/", None, &renames);
    let keys: Vec<&str> = plan.files.iter().map(|(_, k)| k.as_str()).collect();
    assert_eq!(keys, vec!["picked/css (1)/app.css", "picked/notes.txt"]);
    assert!(plan.dirs.contains(&"picked/css (1)/".to_string()));
}

#[tokio::test]
async fn compresses_folders_and_files_into_a_zip_that_reads_back() {
    let s = Scratch::new();
    let src = s.0.join("src");
    std::fs::create_dir_all(src.join("docs/sub")).unwrap();
    std::fs::create_dir_all(src.join("docs/empty")).unwrap();
    std::fs::write(src.join("docs/a.txt"), "alpha").unwrap();
    std::fs::write(src.join("docs/sub/b.txt"), "beta".repeat(1000)).unwrap();
    std::fs::write(src.join("photo.jpg"), [0xffu8, 0xd8, 0xff]).unwrap();
    let st: Arc<dyn Storage> = Arc::new(LocalBackend::with_roots(vec![("src".into(), RootKind::Folder, src.clone())], false));
    let root = src.to_string_lossy().into_owned();
    let (plan, left_out) = ops::plan_pack(&*st, &root, &["docs/".into(), "photo.jpg".into()]).await.unwrap();
    assert!(left_out.is_empty());
    let names: Vec<&str> = plan.iter().map(|i| i.name.as_str()).collect();
    assert!(names.contains(&"docs/") && names.contains(&"docs/sub/b.txt") && names.contains(&"docs/empty/") && names.contains(&"photo.jpg"));
    let out = s.0.join("Archive.zip");
    let seen = std::sync::atomic::AtomicU64::new(0);
    ops::pack_to_file(st, &root, &plan, &out, &|n| seen.store(n, std::sync::atomic::Ordering::Relaxed), &no()).await.unwrap();
    assert_eq!(seen.load(std::sync::atomic::Ordering::Relaxed), 5 + 4000 + 3);

    let ix = Index::open(&out, Format::Zip, &s.0, &no()).unwrap();
    assert_eq!(ix.top(), vec!["docs/".to_string(), "photo.jpg".to_string()]);
    assert!(ix.has_dir("docs/empty/"));
    let it = ix.item("docs/sub/b.txt").unwrap();
    assert_eq!(it.size, 4000);
    let mut body = Vec::new();
    ix.read(it, None, &mut |c| {
        body.extend_from_slice(c);
        true
    })
    .unwrap();
    assert_eq!(body, "beta".repeat(1000).as_bytes());
}

#[tokio::test]
async fn fetch_copies_a_file_with_progress() {
    let s = Scratch::new();
    std::fs::write(s.0.join("a.zip"), b"0123456789").unwrap();
    let st = LocalBackend::with_roots(vec![("s".into(), RootKind::Folder, s.0.clone())], false);
    let root = s.0.to_string_lossy().into_owned();
    let last = std::sync::Mutex::new((0, 0));
    let to = s.0.join("cache/x.zip");
    ops::fetch(&st, &root, "a.zip", &to, &|n, t| *last.lock().unwrap() = (n, t), &no()).await.unwrap();
    assert_eq!(std::fs::read(&to).unwrap(), b"0123456789");
    assert_eq!(*last.lock().unwrap(), (10, 10));
    let mut rs = st.read(&root, "a.zip", Some(2..4), None).await.unwrap().body;
    assert_eq!(&rs.next().await.unwrap().unwrap()[..], b"23");
}

#[test]
fn server_scripts_quote_everything() {
    let sc = remote::compress_script("/srv/www/it's here", &["a b".into(), "$(x)".into()], "Archive.zip");
    assert!(sc.contains("cd '/srv/www/it'\\''s here'"));
    assert!(sc.contains("-- 'a b' '$(x)'"));
    assert!(sc.starts_with("command -v zip"));
    let ex = remote::extract_script("/srv/site.zip", Format::Zip, "/srv/", "site");
    assert!(ex.contains("unzip -Z1") && ex.contains("exit 125") && ex.contains("D='/srv/site'"));
    let ex = remote::extract_script("/srv/a.tgz", Format::TarGz, "/srv", "a");
    assert!(ex.contains("tar -xzf") && ex.contains("^[lh]"));
}

/// A rebuilt archive at the same path (a re-zipped file, a newer download to the same place) is
/// read again instead of listing the old contents.
#[test]
fn a_changed_archive_is_not_served_from_the_old_index() {
    let s = Scratch::new();
    let p = s.0.join("site.zip");
    hostile_zip(&p);
    let ix = Index::open(&p, Format::Zip, &s.0, &no()).unwrap();
    let id = encode_id("stale-test", "", &p.to_string_lossy());
    let local = p.to_string_lossy().into_owned();
    super::OPENED.lock().unwrap().insert(
        id.clone(),
        super::Opened { backend: Arc::new(ArchiveBackend::new("site.zip".into(), Arc::new(ix))), stamp: super::stamp_of(&p) },
    );
    assert!(super::reusable(&id, Some(&local)).is_some());
    assert!(super::reusable(&id, None).is_some());
    // another copy than the one it was read from
    assert!(super::reusable(&id, Some("/elsewhere/site.zip")).is_none());
    // rewritten in place
    let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
    z.start_file("new.txt", zip::write::SimpleFileOptions::default()).unwrap();
    z.write_all(b"new").unwrap();
    z.finish().unwrap();
    assert!(super::reusable(&id, Some(&local)).is_none());
    assert!(super::reusable(&id, None).is_none());
    super::OPENED.lock().unwrap().remove(&id);
}

#[test]
fn the_work_folder_is_kept_under_its_budget_sparing_open_and_unfinished_files() {
    let s = Scratch::new();
    let file = |name: &str, age: u64| {
        let p = s.0.join(name);
        std::fs::write(&p, vec![0u8; 100]).unwrap();
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(age)).unwrap();
        p
    };
    let oldest = file("a.zip", 400);
    let open = file("b.tar", 300);
    let part = file("c.zip.3.part", 200);
    let pack = file("pack-1.zip", 200);
    let newest = file("d.tgz", 100);
    super::prune(&s.0, std::slice::from_ref(&open), 250);
    assert!(!oldest.exists(), "the oldest goes first");
    assert!(open.exists(), "an open archive's file stays");
    assert!(part.exists() && pack.exists(), "unfinished files stay");
    assert!(newest.exists(), "within the budget once the oldest is gone");
    super::prune(&s.0, &[], 0);
    assert!(!open.exists() && !newest.exists());
}

#[test]
fn temporary_names_never_repeat() {
    let out = Path::new("/w/abc.tar");
    let (a, b) = (super::index::part_path(out), super::index::part_path(out));
    assert_ne!(a, b);
    assert!(a.to_string_lossy().starts_with("/w/abc.tar.") && a.to_string_lossy().ends_with(".part"));
}

#[test]
fn only_folders_without_planned_files_count_as_empty() {
    let s = Scratch::new();
    let p = s.0.join("site.zip");
    hostile_zip(&p);
    let ix = Index::open(&p, Format::Zip, &s.0, &no()).unwrap();
    let plan = ops::plan_extract(&ix, &[], "", "out/", Some("x"), &Default::default());
    let empty: Vec<&str> = plan.empty_dirs.iter().map(String::as_str).collect();
    assert_eq!(empty, ["out/x/site/empty/"]);
}

#[test]
fn extract_folder_must_be_one_plain_name() {
    for bad in ["", ".", "..", "a/b", "..\\x", "a\0b"] {
        assert!(!remote::plain_folder_name(bad), "{bad:?}");
    }
    for good in ["site", "...", ".hidden", "My Site's"] {
        assert!(remote::plain_folder_name(good), "{good:?}");
    }
}

/// Stand-ins for the server's `unzip`, `tar` and `zip`, driven by env vars: `N` is the one name
/// the listing shows, `FAIL` makes the listing fail, `SLOW` makes the (un)packing hang (its pid
/// goes to `$PIDFILE`). Unpacking otherwise leaves an `ok` file in the target.
#[cfg(unix)]
struct FakeServer {
    s: Scratch,
}

#[cfg(unix)]
impl FakeServer {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new();
        std::fs::create_dir_all(s.0.join("bin")).unwrap();
        let slow = r#"[ -n "$SLOW" ] && { echo $$ > "$PIDFILE"; exec sleep 30; }"#;
        let tools = [
            ("unzip", format!("case \"$1\" in\n-Z) [ -n \"$FAIL\" ] && exit 9; echo '-rw-r--r--  3.0 unx 2 tx stor 24-Jan-01 00:00 x'; exit 0;;\n-Z1) [ -n \"$FAIL\" ] && exit 9; printf '%s\\n' \"$N\"; exit 0;;\nesac\n{slow}\n: > \"$5/ok\"\n")),
            ("tar", format!("case \"$1\" in\n-tvf) [ -n \"$FAIL\" ] && exit 9; echo '-rw-r--r--  0 0 0 2 Jan  1  2024 x'; exit 0;;\n-tf) [ -n \"$FAIL\" ] && exit 9; printf '%s\\n' \"$N\"; exit 0;;\nesac\n{slow}\n: > \"$4/ok\"\n")),
            ("zip", format!(": > \"$4\"\n{slow}\nexit 0\n")),
        ];
        for (name, body) in tools {
            let p = s.0.join("bin").join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        FakeServer { s }
    }

    fn dir(&self) -> String {
        self.s.0.join("srv").to_string_lossy().into_owned()
    }

    /// `script` started by `sh` (in a process group of its own, like an SSH session).
    fn start(&self, sh: &str, script: &str, env: &[(&str, &str)]) -> std::process::Child {
        use std::os::unix::process::CommandExt;
        std::fs::create_dir_all(self.dir()).unwrap();
        let mut c = std::process::Command::new(sh);
        c.arg("-c").arg(script).env("PATH", format!("{}:/usr/bin:/bin", self.s.0.join("bin").display())).env("PIDFILE", self.s.0.join("pid")).process_group(0);
        c.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        for (k, v) in env {
            c.env(k, v);
        }
        c.spawn().unwrap()
    }

    fn run(&self, sh: &str, script: &str, env: &[(&str, &str)]) -> Option<i32> {
        self.start(sh, script, env).wait().unwrap().code()
    }

    /// Starts `script` with the tool hanging, stops it the way the app does (TERM to the shell),
    /// and says whether the tool is gone.
    fn stop_midway(&self, sh: &str, script: &str) -> bool {
        let _ = std::fs::remove_file(self.s.0.join("pid"));
        let mut child = self.start(sh, script, &[("SLOW", "1")]);
        let pid_file = self.s.0.join("pid");
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let tool: i32 = loop {
            if let Some(p) = std::fs::read_to_string(&pid_file).ok().and_then(|t| t.trim().parse().ok()) {
                break p;
            }
            assert!(std::time::Instant::now() < until, "the tool never started");
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        // SAFETY: plain syscalls on processes this test started
        unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
        let st = child.wait().unwrap();
        assert_ne!(st.code(), Some(0));
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < until {
            if unsafe { libc::kill(tool, 0) } != 0 {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        unsafe { libc::kill(tool, libc::SIGKILL) };
        false
    }

    /// Hidden temporary files and folders the scripts left in the server folder.
    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.dir()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".kybl-")).collect()
    }
}

#[cfg(unix)]
fn shells() -> Vec<&'static str> {
    ["/bin/sh", "/bin/dash", "/bin/bash"].into_iter().filter(|p| Path::new(p).exists()).collect()
}

/// The server-side name checks, run by a real sh against stand-in tools.
#[cfg(unix)]
#[test]
fn server_name_checks_refuse_unsafe_names() {
    let f = FakeServer::new();
    let script = |format| remote::extract_script(&format!("{}/a", f.dir()), format, &f.dir(), "out");
    for sh in shells() {
        for format in [Format::Zip, Format::Tar, Format::TarGz] {
            for name in ["../x", "a/../../x", "/etc/passwd", "..\\..\\x", "a\\b"] {
                assert_eq!(f.run(sh, &script(format), &[("N", name)]), Some(125), "{sh} {format:?} {name:?}");
            }
            for name in ["a/b.txt", "..x/y", "x.."] {
                let _ = std::fs::remove_dir_all(format!("{}/out", f.dir()));
                assert_eq!(f.run(sh, &script(format), &[("N", name)]), Some(0), "{sh} {format:?} {name:?}");
                assert!(Path::new(&format!("{}/out/ok", f.dir())).exists());
            }
        }
        assert_eq!(f.run(sh, &script(Format::Zip), &[("N", "C:x")]), Some(125));
        assert!(f.leftovers().is_empty(), "{:?}", f.leftovers());
    }
}

/// A listing that fails proves nothing: the server-side unpack is not done (the app's own path,
/// which skips links and unsafe names, takes over).
#[cfg(unix)]
#[test]
fn server_unpack_fails_closed_when_the_archive_cant_be_listed() {
    let f = FakeServer::new();
    for sh in shells() {
        for format in [Format::Zip, Format::Tar] {
            let _ = std::fs::remove_dir_all(format!("{}/out", f.dir()));
            let script = remote::extract_script(&format!("{}/a", f.dir()), format, &f.dir(), "out");
            assert_eq!(f.run(sh, &script, &[("N", "fine.txt"), ("FAIL", "1")]), Some(125), "{sh} {format:?}");
            assert!(!Path::new(&format!("{}/out", f.dir())).exists());
        }
    }
}

/// Unpacking into a folder that is there already merges into it, but not when it holds a link
/// (someone else could point `out/link` at a folder elsewhere): the app's own path takes over.
/// Zipping never moves the zip into a folder of the zip's name.
#[cfg(unix)]
#[test]
fn server_unpack_never_merges_through_links() {
    let f = FakeServer::new();
    let out = format!("{}/out", f.dir());
    for sh in shells() {
        for format in [Format::Zip, Format::Tar] {
            let script = remote::extract_script(&format!("{}/a", f.dir()), format, &f.dir(), "out");
            let _ = std::fs::remove_dir_all(&out);
            std::fs::create_dir_all(format!("{out}/sub")).unwrap();
            assert_eq!(f.run(sh, &script, &[("N", "x")]), Some(0), "{sh} {format:?}");
            assert!(Path::new(&format!("{out}/ok")).exists());
            std::fs::remove_file(format!("{out}/ok")).unwrap();
            std::os::unix::fs::symlink(f.s.0.join("bin"), format!("{out}/sub/link")).unwrap();
            assert_eq!(f.run(sh, &script, &[("N", "x")]), Some(125), "{sh} {format:?}");
            assert!(!Path::new(&format!("{out}/ok")).exists());
            // the folder itself a link
            let _ = std::fs::remove_dir_all(&out);
            std::os::unix::fs::symlink(f.s.0.join("bin"), &out).unwrap();
            assert_eq!(f.run(sh, &script, &[("N", "x")]), Some(125), "{sh} {format:?}");
            assert!(!f.s.0.join("bin/ok").exists());
            std::fs::remove_file(&out).unwrap();
            assert!(f.leftovers().is_empty(), "{:?}", f.leftovers());
        }
        std::fs::create_dir_all(format!("{}/A.zip", f.dir())).unwrap();
        assert_eq!(f.run(sh, &remote::compress_script(&f.dir(), &["a b".into()], "A.zip"), &[]), Some(1), "{sh}");
        assert!(std::fs::read_dir(format!("{}/A.zip", f.dir())).unwrap().next().is_none());
        assert!(f.leftovers().is_empty(), "{:?}", f.leftovers());
        std::fs::remove_dir(format!("{}/A.zip", f.dir())).unwrap();
    }
}

/// Stop while the server unzips or zips: the tool is stopped and the temporary folder or
/// `.part` file removed, whichever sh the server has.
#[cfg(unix)]
#[test]
fn stopping_a_server_side_unpack_or_zip_cleans_up() {
    let f = FakeServer::new();
    for sh in shells() {
        for format in [Format::Zip, Format::TarGz] {
            let script = remote::extract_script(&format!("{}/a", f.dir()), format, &f.dir(), "out");
            assert!(f.stop_midway(sh, &script), "{sh} {format:?}: the unpack kept running");
            assert!(f.leftovers().is_empty(), "{sh} {format:?}: {:?}", f.leftovers());
        }
        let script = remote::compress_script(&f.dir(), &["a b".into()], "Archive.zip");
        assert!(f.stop_midway(sh, &script), "{sh}: zip kept running");
        assert!(f.leftovers().is_empty(), "{sh}: {:?}", f.leftovers());
    }
}

/// The scripts are one line, so a csh login shell passes them to sh whole.
#[cfg(unix)]
#[test]
fn server_scripts_run_under_a_csh_login_shell() {
    let f = FakeServer::new();
    for csh in ["/bin/tcsh", "/bin/csh"].into_iter().filter(|p| Path::new(p).exists()) {
        let _ = std::fs::remove_dir_all(format!("{}/out", f.dir()));
        let ex = crate::actions::sh_c(&remote::extract_script(&format!("{}/it's a", f.dir()), Format::Zip, &f.dir(), "out")).unwrap();
        assert_eq!(f.run(csh, &ex, &[("N", "x.txt")]), Some(0), "{csh}");
        assert!(Path::new(&format!("{}/out/ok", f.dir())).exists());
        let zip = crate::actions::sh_c(&remote::compress_script(&f.dir(), &["a b".into()], "A.zip")).unwrap();
        assert_eq!(f.run(csh, &zip, &[]), Some(0), "{csh}");
        assert!(Path::new(&format!("{}/A.zip", f.dir())).exists());
    }
    // a name with a line break is never sent
    assert!(crate::actions::sh_c(&remote::compress_script("/srv", &["a\nb".into()], "A.zip")).is_none());
}

/// Links on this computer (`local_links`): unpacking never writes through a link in the
/// destination folder (S2-2), and a zip made here leaves out links met inside the folder and names
/// a careless unzip would misuse (S2-3, S2-6).
#[cfg(unix)]
#[tokio::test]
async fn links_are_never_followed_in_or_out() {
    let s = Scratch::new();
    let p = s.0.join("site.zip");
    hostile_zip(&p);
    let ix = Arc::new(Index::open(&p, Format::Zip, &s.0, &no()).unwrap());
    let out = s.0.join("out");
    let home = out.join("home");
    std::fs::create_dir_all(out.join("dl")).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    std::os::unix::fs::symlink(&home, out.join("dl/site")).unwrap();
    let dst: Arc<dyn Storage> = Arc::new(LocalBackend::with_roots(vec![("out".into(), RootKind::Folder, out.clone())], false));
    let root = out.to_string_lossy().into_owned();
    let plan = ops::plan_extract(&ix, &[], "", "dl/", None, &Default::default());
    let cancel = Arc::new(AtomicBool::new(false));
    let err = ops::extract(ix.clone(), dst.clone(), &root, &plan, true, &|_| {}, &cancel).await.unwrap_err();
    assert!(err.to_string().contains("is a link"), "{err}");
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0, "nothing landed behind the link");

    // compressing a folder here: the link to a secret is left out, and said
    let src = s.0.join("src");
    std::fs::create_dir_all(src.join("proj")).unwrap();
    std::fs::write(src.join("proj/readme.md"), "hi").unwrap();
    std::fs::write(s.0.join("secret"), "key").unwrap();
    std::os::unix::fs::symlink(s.0.join("secret"), src.join("proj/config.json")).unwrap();
    let st: Arc<dyn Storage> = Arc::new(LocalBackend::with_roots(vec![("src".into(), RootKind::Folder, src.clone())], false));
    let sroot = src.to_string_lossy().into_owned();
    let (plan, left_out) = ops::plan_pack(&*st, &sroot, &["proj/".into()]).await.unwrap();
    let names: Vec<&str> = plan.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, vec!["proj/", "proj/readme.md"]);
    assert_eq!(left_out, vec!["proj/config.json".to_string()]);
    assert!(ops::left_out_note(&left_out).contains("proj/config.json"));
}

#[test]
fn zip_names_stay_inside() {
    let long = "x".repeat(256);
    for ok in ["a.txt", "a/b/", "a..b", ".env", "logs/2024-01-01T10:00.log", "1:2.txt"] {
        assert!(ops::zip_name_ok(ok), "{ok}");
    }
    for bad in ["", "/etc/passwd", "a/../../x", "./a", "a//b", "a\\b", "..", "a/./b", "C:x", "c:/x", long.as_str()] {
        assert!(!ops::zip_name_ok(bad), "{bad}");
    }
}

#[tokio::test]
async fn picked_items_with_unsafe_names_are_left_out_of_the_zip() {
    let s = Scratch::new();
    let src = s.0.join("src");
    std::fs::create_dir_all(src.join("C:evil")).unwrap();
    std::fs::write(src.join("C:evil/x.txt"), "x").unwrap();
    std::fs::write(src.join("..\\..\\run.bat"), "boom").unwrap();
    std::fs::write(src.join("ok.txt"), "fine").unwrap();
    let st: Arc<dyn Storage> = Arc::new(LocalBackend::with_roots(vec![("src".into(), RootKind::Folder, src.clone())], false));
    let root = src.to_string_lossy().into_owned();
    let picked = vec!["..\\..\\run.bat".to_string(), "C:evil/".to_string(), "ok.txt".to_string()];
    let (plan, left_out) = ops::plan_pack(&*st, &root, &picked).await.unwrap();
    let names: Vec<&str> = plan.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, vec!["ok.txt"]);
    assert_eq!(left_out, vec!["..\\..\\run.bat".to_string(), "C:evil/".to_string()]);
}
