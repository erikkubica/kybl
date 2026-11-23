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
    let plan = ops::plan_pack(&*st, &root, &["docs/".into(), "photo.jpg".into()]).await.unwrap();
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
