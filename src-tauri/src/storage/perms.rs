//! Unix permissions and symbolic links on servers (SFTP, and FTP's `SITE CHMOD`): the commands
//! behind "Permissions…", "Show original" and "Make link…". Connections that don't keep either
//! (`caps().permissions`, `caps().links`) refuse, and the UI never offers them there.

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use super::*;
use crate::commands::{MoveProgress, OpResult};

/// One item picked in the list, with the permissions it listed with (when the server said).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PermItem {
    pub key: String,
    pub is_dir: bool,
    #[serde(default)]
    pub mode: Option<u32>,
}

/// "Apply to enclosed items": what inside picked folders changes too (FileZilla's choice).
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Recurse {
    All,
    Files,
    Folders,
}

impl Recurse {
    fn takes(self, is_dir: bool) -> bool {
        match self {
            Recurse::All => true,
            Recurse::Files => !is_dir,
            Recurse::Folders => is_dir,
        }
    }
}

/// The new permissions: `set` bits on, `clear` bits off, the rest kept from `old`. None when a
/// bit is kept but `old` isn't known.
pub fn apply_mode(old: Option<u32>, set: u32, clear: u32) -> Option<u32> {
    let (set, clear) = (set & 0o7777, clear & 0o7777 & !set);
    let touched = set | clear;
    match old {
        Some(o) => Some(((o & 0o7777) & !clear) | set),
        // every read/write/run bit is decided: the special bits stay off, as chmod 644 does
        None if touched & 0o777 == 0o777 => Some(set),
        None => None,
    }
}

struct Run<'a> {
    s: &'a dyn Storage,
    root: &'a str,
    set: u32,
    clear: u32,
    done: u64,
    total: u64,
    cancel: &'a AtomicBool,
    report: &'a (dyn Fn(u64, u64) + Send + Sync),
    last: Instant,
}

impl Run<'_> {
    async fn apply(&mut self, key: &str, listed: Option<u32>) -> SResult<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(StorageError::cancelled());
        }
        let old = match listed {
            Some(m) => Some(m),
            None if apply_mode(None, self.set, self.clear).is_none() => self.s.stat(self.root, key).await?.and_then(|e| e.mode),
            None => None,
        };
        let Some(mode) = apply_mode(old, self.set, self.clear) else {
            let name = key.trim_end_matches('/').rsplit('/').next().unwrap_or(key);
            return Err(StorageError::other(format!("Kybl can't tell what the permissions of “{name}” are now, so it can't keep the boxes left as they were. Tick or untick every box.")));
        };
        if old != Some(mode) {
            self.s.set_mode(self.root, key, mode).await?;
        }
        self.done += 1;
        if self.last.elapsed().as_millis() > 120 {
            (self.report)(self.done, self.total);
            self.last = Instant::now();
        }
        Ok(())
    }

    /// Everything inside `dir`, folder by folder. Links aren't followed (what they point at may
    /// be anywhere on the server) and aren't changed (changing one changes what it points at).
    async fn inside(&mut self, dir: &str, recurse: Recurse) -> SResult<()> {
        let mut queue = VecDeque::from([dir.to_string()]);
        while let Some(d) = queue.pop_front() {
            let mut token = None;
            loop {
                let page = self.s.list(self.root, &d, token).await?;
                let info: std::collections::HashMap<&str, &Entry> = page.folder_info.iter().map(|e| (e.key.as_str(), e)).collect();
                let folders: Vec<(String, Option<u32>)> = page
                    .folders
                    .iter()
                    .filter(|f| info.get(f.as_str()).is_none_or(|e| e.link.is_none()))
                    .map(|f| (f.clone(), info.get(f.as_str()).and_then(|e| e.mode)))
                    .collect();
                let files: Vec<(String, Option<u32>)> = page.objects.iter().filter(|e| e.link.is_none()).map(|e| (e.key.clone(), e.mode)).collect();
                self.total += (if recurse.takes(true) { folders.len() } else { 0 } + if recurse.takes(false) { files.len() } else { 0 }) as u64;
                if recurse.takes(false) {
                    for (k, m) in &files {
                        self.apply(k, *m).await?;
                    }
                }
                for (k, m) in folders {
                    if recurse.takes(true) {
                        self.apply(&k, m).await?;
                    }
                    queue.push_back(k);
                }
                token = page.next_token;
                if token.is_none() {
                    break;
                }
            }
        }
        Ok(())
    }
}

/// Sets permissions on `items` (and, with `recurse`, on what is inside the folders among them,
/// the folders themselves included only when `recurse` takes folders). `set` and `clear` are the
/// bits to turn on and off; bits in neither are kept per item, so a selection with mixed
/// permissions can have one box changed. Reports `move-progress` (phase "permissions").
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn set_permissions(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    items: Vec<PermItem>,
    set: u32,
    clear: u32,
    recurse: Option<Recurse>,
    op_id: Option<String>,
) -> Result<OpResult, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    if !s.caps().permissions {
        return Err("This connection doesn't keep Unix permissions.".into());
    }
    let op = op_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op.clone(), flag.clone());
    let report = |done: u64, total: u64| {
        let _ = app.emit("move-progress", MoveProgress { op_id: op.clone(), phase: "permissions", done, total, bytes: 0, total_bytes: 0 });
    };
    let r = run(&*s, &bucket, &items, set, clear, recurse, &flag, &report).await;
    state.cancels.lock().await.remove(&op);
    Ok(r)
}

#[allow(clippy::too_many_arguments)]
async fn run(
    s: &dyn Storage,
    root: &str,
    items: &[PermItem],
    set: u32,
    clear: u32,
    recurse: Option<Recurse>,
    cancel: &AtomicBool,
    report: &(dyn Fn(u64, u64) + Send + Sync),
) -> OpResult {
    let mut r = Run { s, root, set, clear, done: 0, total: 0, cancel, report, last: Instant::now() };
    let res: SResult<()> = async {
        for it in items {
            // a picked folder changes unless only what is inside should (files only)
            if recurse.is_none_or(|rc| rc.takes(it.is_dir)) {
                r.total += 1;
                r.apply(&it.key, it.mode).await?;
            }
            if let Some(rc) = recurse.filter(|_| it.is_dir) {
                r.inside(&it.key, rc).await?;
            }
        }
        Ok(())
    }
    .await;
    report(r.done, r.total);
    OpResult { done: r.done, total: r.total, error: res.err().map(String::from) }
}

/// Where a link finally leads, as an entry of the same root (a key ending with `/` for a folder).
#[tauri::command]
pub async fn resolve_link(app: AppHandle, state: State<'_, AppState>, profile_id: String, bucket: String, key: String) -> Result<Entry, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    Ok(s.resolve_link(&bucket, &key).await?)
}

/// Makes a symbolic link at `key` pointing at `target` (relative to the link's folder, or an
/// absolute server path).
#[tauri::command]
pub async fn make_link(app: AppHandle, state: State<'_, AppState>, profile_id: String, bucket: String, key: String, target: String) -> Result<(), String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    if !s.caps().links {
        return Err("This connection can't make links.".into());
    }
    Ok(s.make_link(&bucket, &key, &target).await?)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn modes_change_only_the_boxes_touched() {
        // a full grid: exactly that, special bits kept only when known
        assert_eq!(apply_mode(Some(0o4755), 0o644, 0o133), Some(0o4644));
        assert_eq!(apply_mode(None, 0o644, 0o133), Some(0o644));
        // one box (group write) on, the rest as each item had it
        assert_eq!(apply_mode(Some(0o644), 0o020, 0), Some(0o664));
        assert_eq!(apply_mode(Some(0o600), 0o020, 0), Some(0o620));
        assert_eq!(apply_mode(None, 0o020, 0), None);
        // a bit in both: on wins
        assert_eq!(apply_mode(Some(0), 0o100, 0o100), Some(0o100));
    }

    /// A tiny server: a few folders and files with modes, one link to a folder, and what was set.
    struct Fake {
        set: Mutex<Vec<(String, u32)>>,
    }

    #[async_trait::async_trait]
    impl Storage for Fake {
        fn kind(&self) -> ConnKind {
            ConnKind::Sftp
        }
        fn caps(&self) -> &Capabilities {
            unimplemented!()
        }
        async fn roots(&self) -> SResult<Vec<RootInfo>> {
            Ok(vec![])
        }
        async fn list(&self, _root: &str, dir: &str, _token: Option<String>) -> SResult<Page> {
            let f = |k: &str, mode: u32| Entry { key: k.into(), mode: Some(mode), ..Default::default() };
            Ok(match dir {
                "site/" => Page {
                    folders: vec!["site/css/".into(), "site/elsewhere/".into()],
                    objects: vec![f("site/index.html", 0o600), Entry { link: Some("index.html".into()), ..f("site/home.html", 0o600) }],
                    folder_info: vec![f("site/css/", 0o700), Entry { link: Some("/etc".into()), ..f("site/elsewhere/", 0o755) }],
                    ..Default::default()
                },
                "site/css/" => Page { objects: vec![f("site/css/a.css", 0o640)], ..Default::default() },
                other => panic!("listed {other}, which is behind a link"),
            })
        }
        async fn stat(&self, _root: &str, path: &str) -> SResult<Option<Entry>> {
            Ok(Some(Entry { key: path.into(), mode: Some(0o700), ..Default::default() }))
        }
        async fn read(&self, _: &str, _: &str, _: Option<Range<u64>>, _: Option<&str>) -> SResult<ReadStream> {
            unsupported()
        }
        async fn write(&self, _: &str, _: &str, _: WriteSource, _: WriteOpts<'_>, _: Progress<'_>, _: &Arc<AtomicBool>) -> SResult<WriteOutcome> {
            unsupported()
        }
        async fn mkdir(&self, _: &str, _: &str) -> SResult<()> {
            unsupported()
        }
        async fn delete(&self, _: &str, _: &[String], _: &[String], _: &AtomicBool, _: &(dyn Fn(u64, u64) + Send + Sync)) -> SResult<(u64, u64)> {
            unsupported()
        }
        async fn rename(&self, _: &Loc, _: &Loc, _: bool) -> SResult<()> {
            unsupported()
        }
        async fn set_mode(&self, _root: &str, path: &str, mode: u32) -> SResult<()> {
            self.set.lock().unwrap().push((path.into(), mode));
            Ok(())
        }
    }

    fn apply(items: &[PermItem], set: u32, clear: u32, recurse: Option<Recurse>) -> (OpResult, Vec<(String, u32)>) {
        let fake = Fake { set: Mutex::default() };
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let r = rt.block_on(run(&fake, "", items, set, clear, recurse, &AtomicBool::new(false), &|_, _| {}));
        (r, fake.set.into_inner().unwrap())
    }

    fn folder(key: &str, mode: u32) -> PermItem {
        PermItem { key: key.into(), is_dir: true, mode: Some(mode) }
    }

    #[test]
    fn enclosed_items_by_kind_without_following_links() {
        let (r, set) = apply(&[folder("site/", 0o700)], 0o644, 0o133, Some(Recurse::Files));
        assert_eq!(r.error, None);
        // files only: the folder itself stays; the link and what's behind the folder link don't change
        assert_eq!(set, [("site/index.html".to_string(), 0o644), ("site/css/a.css".into(), 0o644)]);

        let (_, set) = apply(&[folder("site/", 0o700)], 0o755, 0o022, Some(Recurse::Folders));
        assert_eq!(set, [("site/".to_string(), 0o755), ("site/css/".into(), 0o755)]);

        let (r, set) = apply(&[folder("site/", 0o755)], 0o755, 0o022, Some(Recurse::All));
        // already 755 itself: nothing sent for it, but counted
        assert_eq!(set.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["site/index.html", "site/css/", "site/css/a.css"]);
        assert_eq!((r.done, r.total), (4, 4));
    }

    #[test]
    fn walks_keep_out_of_links_to_folders() {
        use futures_util::StreamExt;
        let fake = Fake { set: Mutex::default() };
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        // (the fake panics when listed behind its link)
        let all: Vec<Entry> = rt.block_on(fake.walk("", "site/").map(|b| b.unwrap()).concat());
        let keys: Vec<(&str, Option<&str>)> = all.iter().map(|e| (e.key.as_str(), e.link.as_deref())).collect();
        assert_eq!(
            keys,
            [
                ("site/css/", None),
                ("site/elsewhere/", Some("/etc")),
                ("site/index.html", None),
                ("site/home.html", Some("index.html")),
                ("site/css/a.css", None)
            ]
        );
    }

    #[test]
    fn a_partial_change_reads_what_isnt_listed() {
        // group write on, for an item listed without a mode: the server is asked (0o700 here)
        let (r, set) = apply(&[PermItem { key: "x.txt".into(), is_dir: false, mode: None }], 0o020, 0, None);
        assert_eq!((r.error, set), (None, vec![("x.txt".to_string(), 0o720)]));
    }
}
