//! Links on this computer (`local_links`): a copy out of a folder here never follows a link out
//! of it (S2-3), and files from elsewhere are never written through a link in the destination
//! folder (S2-2).

use super::*;

/// This device's disk dressed up as a remote store: no local paths, so the engine treats what it
/// reads as coming from elsewhere.
struct Remote {
    inner: Arc<LocalBackend>,
    caps: Capabilities,
}

#[async_trait]
impl Storage for Remote {
    fn kind(&self) -> ConnKind {
        ConnKind::Sftp
    }
    fn caps(&self) -> &Capabilities {
        &self.caps
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

fn remote(dir: &Path) -> (Arc<dyn Storage>, String) {
    let (b, root) = local(dir);
    let caps = Capabilities { local_paths: false, ..b.caps().clone() };
    (Arc::new(Remote { inner: b, caps }), root)
}

#[test]
fn a_copy_from_this_computer_leaves_links_in_the_folder_alone() {
    tauri::async_runtime::block_on(async {
        let (s, d, secrets) = (tmp(), tmp(), tmp());
        write(&secrets.0, "credentials", b"aws secret");
        write(&secrets.0, "dir/inner.txt", b"inner");
        write(&s.0, "proj/readme.md", b"hi");
        std::os::unix::fs::symlink(secrets.0.join("credentials"), s.0.join("proj/config.json")).unwrap();
        std::os::unix::fs::symlink(secrets.0.join("dir"), s.0.join("proj/linked")).unwrap();
        let (src, sr) = local(&s.0);
        let (dst, dr) = remote(&d.0);
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let id = m.create(spec(&sr, &[("proj/", true)], &dr, "")).unwrap();
        let j = finished(&m, &id).await;
        let got = files(&d.0);
        assert_eq!(got.keys().collect::<Vec<_>>(), vec!["proj/readme.md"], "only the real file");
        assert_eq!(j.progress.files_failed, 2, "both links are listed as not copied");
        let f = m.failures(&id, 0, 5).unwrap();
        assert!(f.iter().all(|f| f.error.contains("link")), "{f:?}");
    });
}

#[test]
fn a_mirror_list_naming_a_link_still_leaves_it_alone() {
    tauri::async_runtime::block_on(async {
        let (s, d, secrets) = (tmp(), tmp(), tmp());
        write(&secrets.0, "id_ed25519", b"key");
        write(&s.0, "site/index.html", b"<h1>");
        std::os::unix::fs::symlink(secrets.0.join("id_ed25519"), s.0.join("site/notes.txt")).unwrap();
        let (src, sr) = local(&s.0);
        let (dst, dr) = remote(&d.0);
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let mut sp = spec(&sr, &[("site/", true)], &dr, "out/");
        sp.mirror = Some(Mirror { copy: vec![mf("index.html", 4), mf("notes.txt", 3)], ..Default::default() });
        let id = m.create(sp).unwrap();
        finished(&m, &id).await;
        let got = files(&d.0);
        assert_eq!(got.keys().collect::<Vec<_>>(), vec!["out/index.html"]);
    });
}

#[test]
fn files_from_elsewhere_are_not_written_through_links_at_the_destination() {
    tauri::async_runtime::block_on(async {
        // the links point inside the destination's root (which allows it), outside the picked folder
        let (s, d) = (tmp(), tmp());
        let home = Tmp(d.0.join("home"));
        write(&s.0, "pull/Documents/report.docx", b"attacker");
        write(&s.0, "pull/notes.txt", b"attacker");
        write(&s.0, "pull/ok.txt", b"fine");
        write(&home.0, "Documents/keep.docx", b"mine");
        write(&home.0, ".zshrc", b"mine");
        std::fs::create_dir_all(d.0.join("dl/pull")).unwrap();
        std::os::unix::fs::symlink(home.0.join("Documents"), d.0.join("dl/pull/Documents")).unwrap();
        std::os::unix::fs::symlink(home.0.join(".zshrc"), d.0.join("dl/pull/notes.txt")).unwrap();
        let (src, sr) = remote(&s.0);
        let (dst, dr) = local(&d.0);
        let m = JobManager::open(None, TestHost::with(vec![("src", src), ("dst", dst)])).unwrap();
        let mut sp = spec(&sr, &[("pull/", true)], &dr, "dl/");
        sp.conflict = Conflict::Overwrite;
        let id = m.create(sp).unwrap();
        finished(&m, &id).await;
        assert!(!home.0.join("Documents/report.docx").exists(), "nothing landed in the linked folder");
        assert_eq!(std::fs::read(home.0.join(".zshrc")).unwrap(), b"mine", "a file link isn't written through");
        assert_eq!(std::fs::read(d.0.join("dl/pull/ok.txt")).unwrap(), b"fine");
        let f = m.failures(&id, 0, 10).unwrap();
        assert!(f.iter().any(|f| f.path == "pull/notes.txt") && f.iter().all(|f| f.error.contains("is a link")), "{f:?}");
    });
}
