//! Google Drive (v3, hand-written on reqwest). Roots: My Drive (`root`), each shared drive (its
//! id) and a read-only "Shared with me" ([`SHARED`]). Paths are mapped to Drive's ids with a
//! short-lived cache and a rule for duplicate names (see [`paths`]).
//!
//! Google Docs, Sheets and Slides have no bytes of their own: they list with size 0 and
//! `native.exports` (Office format first). Reading one returns its first export; reading the
//! same path with an export's extension added ("Budget" → "Budget.pdf") returns that format.
//! So a download should be saved as `key + "." + native.exports[0].ext`, and "Download as PDF"
//! reads `key + ".pdf"`. They can't be overwritten from Kybl.
//!
//! Deleting moves to Drive's trash. Shortcuts open their target; deleting or moving one affects
//! the shortcut only.

pub mod api;
pub mod paths;
pub mod upload;

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ops::Range,
    sync::{atomic::AtomicBool, Arc},
};

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use self::{
    api::{exports_of, quote, Corpus, DFile, Drive, Export, FILE_FIELDS},
    paths::{drive_name, dup_index, number_page_with, parse_dup, Carry, Node, PathCache},
};
use super::{extras, *};
use crate::oauth::http::{enc, Api};

/// The virtual root of what others shared with this account.
pub const SHARED: &str = "shared-with-me";
/// My Drive (Drive's own alias for its top folder).
pub const MY_DRIVE: &str = "root";
const PAGE: u32 = 1000;
/// Name, then age: the duplicate-name rule numbers same-named files oldest first.
const ORDER: &str = "name,createdTime";

pub fn gdrive_caps() -> Capabilities {
    Capabilities {
        roots: RootsMode::Drives,
        folders: FolderMode::Real,
        rename: RenameMode::Native,
        server_copy: ServerCopy::CrossRoot,
        // Drive links are public permissions, not expiring URLs: not offered (and previews must
        // not create them by accident)
        share: ShareMode::None,
        streaming: StreamingMode::Proxy,
        range_read: true,
        conditional_write: CondWrite::Compare,
        hashes: vec![HashKind::Md5],
        thumbnails: ThumbMode::LocalRemote,
        trash: true,
        changes: true,
        multipart: true,
        max_object_size: Some(5 * 1024 * 1024 * 1024 * 1024),
        ..Capabilities::default()
    }
}

pub struct GDrive {
    api: Api,
    base: String,
    caps: Capabilities,
    cache: PathCache,
    /// one folder creation at a time, so parallel uploads into a new folder don't make two
    mkdir: tokio::sync::Mutex<()>,
    /// the real id of My Drive's top folder (changes name their parents by it)
    my_root: tokio::sync::OnceCell<String>,
}

/// What a path leads to.
struct Found {
    node: Node,
    /// the metadata, when it was just fetched
    file: Option<DFile>,
    /// a Google Docs file asked for in this format ("Budget.pdf")
    export: Option<&'static Export>,
}

#[derive(Serialize, Deserialize, Default)]
struct Token {
    #[serde(rename = "t")]
    page: String,
    #[serde(rename = "c", default)]
    carry: Carry,
}

/// The query part that picks a folder's children (None: the top of Shared with me).
fn scope_of(parent: Option<&Node>) -> String {
    match parent {
        Some(p) => format!("{} in parents", quote(&p.id)),
        None => "sharedWithMe = true".to_string(),
    }
}

/// Same-named files oldest first, ties by id: the order duplicates are numbered in.
fn oldest_first(files: &mut [DFile]) {
    files.sort_by(|a, b| (a.created_time.as_deref(), a.id.as_str()).cmp(&(b.created_time.as_deref(), b.id.as_str())));
}

fn read_only() -> StorageError {
    StorageError::new(ErrKind::PermissionDenied, "Nothing can be added to Shared with me itself. Open a shared folder and add it there.")
}

fn native_read_only() -> StorageError {
    StorageError::new(ErrKind::PermissionDenied, "Google Docs, Sheets and Slides can't be replaced from Kybl. Save it under another name.")
}

impl GDrive {
    pub fn new(api: Api) -> Self {
        Self::with_base(api, "https://www.googleapis.com")
    }

    pub fn with_base(api: Api, base: impl Into<String>) -> Self {
        Self {
            api,
            base: base.into().trim_end_matches('/').to_string(),
            caps: gdrive_caps(),
            cache: PathCache::default(),
            mkdir: Default::default(),
            my_root: Default::default(),
        }
    }

    fn d(&self) -> Drive<'_> {
        Drive { api: &self.api, base: &self.base }
    }

    fn corpus<'a>(&self, root: &'a str) -> Corpus<'a> {
        match root {
            MY_DRIVE => Corpus::User,
            SHARED => Corpus::All,
            d => Corpus::Drive(d),
        }
    }

    /// The top folder of a root; None for "Shared with me", which has none.
    fn root_node(&self, root: &str) -> SResult<Option<Node>> {
        match root {
            "" => Err(StorageError::not_found()),
            SHARED => Ok(None),
            id => Ok(Some(Node { id: id.to_string(), own_id: id.to_string(), folder: true, mime: api::FOLDER.into() })),
        }
    }

    /// The file named `display` (a name as Kybl shows it) in `parent` (None: the top of Shared
    /// with me). A numbered duplicate ("a (2).txt") finds the second "a.txt", oldest first; numbers
    /// that are real names in the folder are skipped, as listings skip them.
    async fn lookup(&self, root: &str, parent: Option<&Node>, display: &str, folder: bool) -> SResult<Option<DFile>> {
        let scope = scope_of(parent);
        let find = |name: String| {
            let q = format!("{scope} and name = {} and trashed = false", quote(&name));
            async move {
                let list = self.d().list(&q, self.corpus(root), "createdTime", None, 100).await?;
                // Drive may match names regardless of case: only the exact name is this file
                let mut same: Vec<DFile> = list.files.into_iter().filter(|f| f.is_folder() == folder && f.name == name).collect();
                oldest_first(&mut same);
                Ok::<_, StorageError>(same)
            }
        };
        let mut same = find(drive_name(display)).await?;
        if !same.is_empty() {
            return Ok(Some(same.remove(0)));
        }
        let Some((base, n)) = parse_dup(display, folder) else { return Ok(None) };
        let base = drive_name(&base);
        // a number is only given out to as many duplicates as there are files named `base`, so
        // the search for it stops there (a name like "x (4000000).txt" must not ask Drive about
        // millions of numbered names)
        let mut same = find(base.clone()).await?;
        if same.len() < 2 {
            return Ok(None);
        }
        let max = same.len() - 1;
        let Some(i) = self.with_taken(root, &scope, HashMap::new(), |taken| dup_index(&base, folder, n, max, taken)).await? else { return Ok(None) };
        Ok((i < same.len()).then(|| same.swap_remove(i)))
    }

    /// Which of `names` ((folder, Drive name)) are real files or folders in `scope`.
    async fn real_names(&self, root: &str, scope: &str, names: &[(bool, String)]) -> SResult<HashSet<(bool, String)>> {
        let mut real = HashSet::new();
        for chunk in names.chunks(20) {
            let any = chunk.iter().map(|(_, n)| format!("name = {}", quote(n))).collect::<Vec<_>>().join(" or ");
            let q = format!("{scope} and ({any}) and trashed = false");
            let mut token: Option<String> = None;
            loop {
                let list = self.d().list(&q, self.corpus(root), "name", token.as_deref(), PAGE).await?;
                real.extend(list.files.iter().map(|f| (f.is_folder(), f.name.clone())));
                token = list.next_page_token;
                if token.is_none() {
                    break;
                }
            }
        }
        Ok(real)
    }

    /// Runs the duplicate-numbering rule `f` with a `taken(folder, name)` that answers whether a
    /// name is a real one in `scope`: names it doesn't know yet are asked of Drive (a batch at a
    /// time) and `f` runs again, until it ran without needing any. `known` starts with names
    /// already known to be real.
    async fn with_taken<R>(&self, root: &str, scope: &str, mut known: HashMap<(bool, String), bool>, f: impl Fn(&dyn Fn(bool, &str) -> bool) -> R) -> SResult<R> {
        loop {
            let unknown: RefCell<Vec<(bool, String)>> = RefCell::default();
            let r = f(&|folder: bool, name: &str| match known.get(&(folder, name.to_string())) {
                Some(t) => *t,
                None => {
                    unknown.borrow_mut().push((folder, name.to_string()));
                    false
                }
            });
            let mut unknown = unknown.into_inner();
            if unknown.is_empty() {
                return Ok(r);
            }
            drop(r);
            unknown.sort();
            unknown.dedup();
            let real = self.real_names(root, scope, &unknown).await?;
            for k in unknown {
                let t = real.contains(&k);
                known.insert(k, t);
            }
        }
    }

    /// The file or folder at `key` (folders end with "/").
    async fn resolve(&self, root: &str, key: &str) -> SResult<Option<Found>> {
        let want_folder = key.is_empty() || key.ends_with('/');
        let parts = extras::components(key)?;
        if parts.is_empty() {
            return Ok(match self.root_node(root)? {
                Some(node) => Some(Found { node, file: None, export: None }),
                // the top of Shared with me: a folder with no id
                None => Some(Found { node: Node { id: String::new(), own_id: String::new(), folder: true, mime: api::FOLDER.into() }, file: None, export: None }),
            });
        }
        let path_of = |i: usize, folder: bool| format!("{}{}", parts[..=i].join("/"), if folder { "/" } else { "" });
        if let Some(node) = self.cache.get(root, &path_of(parts.len() - 1, want_folder)) {
            return Ok(Some(Found { node, file: None, export: None }));
        }
        // start below the deepest folder already known
        let mut parent = self.root_node(root)?;
        let mut start = 0;
        for i in (0..parts.len() - 1).rev() {
            if let Some(n) = self.cache.get(root, &path_of(i, true)) {
                parent = Some(n);
                start = i + 1;
                break;
            }
        }
        for i in start..parts.len() {
            let last = i == parts.len() - 1;
            let folder = !last || want_folder;
            match self.lookup(root, parent.as_ref(), parts[i], folder).await? {
                Some(f) => {
                    let node = f.node();
                    self.cache.put(root, &path_of(i, folder), node.clone());
                    if last {
                        return Ok(Some(Found { node, file: Some(f), export: None }));
                    }
                    if !node.folder {
                        return Ok(None);
                    }
                    parent = Some(node);
                }
                None if last && !folder => return self.lookup_export(root, parent.as_ref(), parts[i]).await,
                None => return Ok(None),
            }
        }
        Ok(None)
    }

    /// "Budget.pdf" where only the Google Sheet "Budget" exists: that sheet, as a PDF.
    async fn lookup_export(&self, root: &str, parent: Option<&Node>, display: &str) -> SResult<Option<Found>> {
        let (stem, ext) = extras::split_ext(display);
        if ext.is_empty() {
            return Ok(None);
        }
        let Some(f) = self.lookup(root, parent, stem, false).await? else { return Ok(None) };
        let export = exports_of(f.target().1).and_then(|ex| ex.iter().find(|e| e.ext.eq_ignore_ascii_case(&ext[1..])));
        Ok(export.map(|e| Found { node: f.node(), file: Some(f), export: Some(e) }))
    }

    /// The folder `dir` and every missing parent; its id.
    async fn ensure_dir(&self, root: &str, dir: &str) -> SResult<String> {
        let parts = extras::components(dir)?;
        let path_of = |i: usize| format!("{}/", parts[..=i].join("/"));
        if parts.is_empty() {
            return self.root_node(root)?.map(|n| n.id).ok_or_else(read_only);
        }
        if let Some(n) = self.cache.get(root, &path_of(parts.len() - 1)).filter(|n| n.folder) {
            return Ok(n.id);
        }
        let _one_at_a_time = self.mkdir.lock().await;
        let mut parent = self.root_node(root)?;
        #[allow(clippy::needless_range_loop)] // i also names the path so far
        for i in 0..parts.len() {
            if let Some(n) = self.cache.get(root, &path_of(i)).filter(|n| n.folder) {
                parent = Some(n);
                continue;
            }
            let node = match self.lookup(root, parent.as_ref(), parts[i], true).await? {
                Some(f) => f.node(),
                None => {
                    let Some(p) = parent.as_ref() else { return Err(read_only()) };
                    self.d().create_folder(&p.id, &drive_name(parts[i])).await?.node()
                }
            };
            self.cache.put(root, &path_of(i), node.clone());
            parent = Some(node);
        }
        Ok(parent.map(|n| n.id).unwrap_or_default())
    }

    /// The metadata of what a path found (fetched when the cache only had the id).
    async fn file_of(&self, f: &Found) -> SResult<DFile> {
        let mut d = match &f.file {
            Some(d) => d.clone(),
            None => self.d().get(&f.node.own_id, FILE_FIELDS).await?,
        };
        self.follow_shortcuts(std::slice::from_mut(&mut d)).await;
        Ok(d)
    }

    /// Shortcuts to files take the size, MD5, time and version of the file they point to: a
    /// shortcut has none of its own, and reading one reads the target, so a copy planned from
    /// a listing must expect the target's bytes. A target that can't be read keeps the shortcut's.
    async fn follow_shortcuts(&self, files: &mut [DFile]) {
        let wanted: Vec<(usize, String)> = files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.mime_type == api::SHORTCUT && !f.is_folder() && f.size.is_none())
            .map(|(i, f)| (i, f.target().0.to_string()))
            .filter(|(_, id)| !id.is_empty())
            .collect();
        if wanted.is_empty() {
            return;
        }
        let d = self.d();
        let found: Vec<(usize, SResult<DFile>)> =
            futures_util::stream::iter(wanted).map(|(i, id)| { let d = &d; async move { (i, d.get(&id, api::TARGET_FIELDS).await) } }).buffer_unordered(8).collect().await;
        for (i, t) in found {
            if let Ok(t) = t {
                files[i].take_target(t);
            }
        }
    }

    /// [`resolve`](Self::resolve), then the metadata; a cached id that has gone stale (moved
    /// or deleted elsewhere) is looked up once more.
    async fn resolve_file(&self, root: &str, key: &str) -> SResult<Option<(Found, DFile)>> {
        for second in [false, true] {
            let Some(found) = self.resolve(root, key).await? else { return Ok(None) };
            if found.node.id.is_empty() {
                return Ok(Some((found, DFile { name: "Shared with me".into(), mime_type: api::FOLDER.into(), ..Default::default() })));
            }
            match self.file_of(&found).await {
                Ok(f) => return Ok(Some((found, f))),
                Err(e) if e.kind == ErrKind::NotFound && !second => self.cache.forget(root, key),
                Err(e) => return Err(e),
            }
        }
        Ok(None)
    }

    async fn my_root_id(&self) -> SResult<String> {
        self.my_root.get_or_try_init(|| async { Ok::<_, StorageError>(self.d().get(MY_DRIVE, "id").await?.id) }).await.cloned()
    }

    /// Where a changed file is in `root` (names as Drive has them), or None when elsewhere.
    async fn path_in_root(&self, root: &str, f: &DFile, names: &mut HashMap<String, (String, Option<String>)>) -> SResult<Option<String>> {
        let top = if root == MY_DRIVE { self.my_root_id().await? } else { root.to_string() };
        let mut parts = vec![paths::display_name(&f.name)];
        let mut cur = f.parents.first().cloned();
        // Drive folders nest at most 100 deep
        for _ in 0..128 {
            let Some(id) = cur else { return Ok(None) };
            if id == top {
                parts.reverse();
                return Ok(Some(format!("{}{}", parts.join("/"), if f.is_folder() { "/" } else { "" })));
            }
            let (name, parent) = match names.get(&id) {
                Some(x) => x.clone(),
                None => {
                    // a parent this account can't see (or one deleted meanwhile) isn't a folder
                    // of this root: the file is elsewhere, and one such answer mustn't fail
                    // (and so replay) the whole batch
                    let p = match self.d().get(&id, "id,name,parents").await {
                        Ok(p) => p,
                        Err(e) if matches!(e.kind, ErrKind::NotFound | ErrKind::PermissionDenied) => return Ok(None),
                        Err(e) => return Err(e),
                    };
                    let x = (p.name.clone(), p.parents.first().cloned());
                    names.insert(id.clone(), x.clone());
                    x
                }
            };
            parts.push(paths::display_name(&name));
            cur = parent;
        }
        Ok(None)
    }

    fn precondition_fails(pre: &Precondition, existing: Option<&DFile>, key: &str) -> Option<WriteOutcome> {
        let entry = || existing.map(|f| f.entry(key.to_string()));
        let fails = match pre {
            Precondition::None => false,
            Precondition::IfNoneMatch => existing.is_some(),
            Precondition::IfMatch(tag) => existing.and_then(DFile::etag).as_deref() != Some(tag.trim_matches('"')),
            Precondition::IfUnchanged { etag, size, modified } => match existing {
                None => true,
                Some(f) => match etag {
                    Some(t) => f.etag().as_deref() != Some(t.trim_matches('"')),
                    None => {
                        let e = f.entry(key.to_string());
                        e.size != *size || e.modified != *modified
                    }
                },
            },
        };
        fails.then(|| WriteOutcome::Conflict(entry()))
    }

    /// Copies a file, or a folder with everything inside, into `parent`.
    fn copy_tree<'a>(&'a self, src: DFile, parent: String, name: String) -> BoxFuture<'a, SResult<()>> {
        Box::pin(async move {
            if !src.is_folder() {
                self.d().copy(&src.node().id, &parent, &name).await?;
                return Ok(());
            }
            let made = self.d().create_folder(&parent, &name).await?;
            let q = format!("{} in parents and trashed = false", quote(&src.node().id));
            let mut token = None;
            loop {
                let page = self.d().list(&q, Corpus::All, ORDER, token.as_deref(), PAGE).await?;
                for child in page.files {
                    // shortcuts to folders aren't followed (one to a folder above would copy
                    // forever), as walks don't go into them either
                    if child.mime_type == api::SHORTCUT && child.is_folder() {
                        continue;
                    }
                    let n = child.name.clone();
                    self.copy_tree(child, made.id.clone(), n).await?;
                }
                token = page.next_page_token;
                if token.is_none() {
                    return Ok(());
                }
            }
        })
    }

    /// Clears the way for a copy or move onto `key`: a file there goes to the trash (S3-like
    /// overwrite); a folder there is an error.
    async fn clear_target(&self, root: &str, key: &str, is_dir: bool) -> SResult<()> {
        if let Some((found, _)) = self.resolve_file(root, key).await? {
            if is_dir {
                return Err(StorageError::new(ErrKind::Exists, "A folder with this name is already there."));
            }
            self.d().trash(&found.node.own_id).await?;
            self.cache.forget(root, key);
        }
        Ok(())
    }
}

fn dir_key(dir: &str) -> String {
    if dir.is_empty() || dir.ends_with('/') { dir.to_string() } else { format!("{dir}/") }
}

#[async_trait]
impl Storage for GDrive {
    fn kind(&self) -> ConnKind {
        ConnKind::Gdrive
    }

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        let mut out = vec![RootInfo { id: MY_DRIVE.into(), name: "My Drive".into(), kind: RootKind::Drive, created: None, read_only: false }];
        let mut token: Option<String> = None;
        loop {
            let mut url = format!("{}/drive/v3/drives?pageSize=100&fields={}", self.base, enc("nextPageToken,drives(id,name,createdTime,capabilities/canAddChildren)"));
            if let Some(t) = &token {
                url.push_str(&format!("&pageToken={}", enc(t)));
            }
            let v: Value = self.api.json(|c| c.get(&url)).await?;
            for d in v["drives"].as_array().into_iter().flatten() {
                out.push(RootInfo {
                    id: d["id"].as_str().unwrap_or_default().to_string(),
                    name: d["name"].as_str().unwrap_or_default().to_string(),
                    kind: RootKind::Drive,
                    created: d["createdTime"].as_str().and_then(extras::parse_rfc3339),
                    read_only: d["capabilities"]["canAddChildren"].as_bool() == Some(false),
                });
            }
            token = v["nextPageToken"].as_str().map(str::to_string);
            if token.is_none() {
                break;
            }
        }
        out.push(RootInfo { id: SHARED.into(), name: "Shared with me".into(), kind: RootKind::Shared, created: None, read_only: true });
        Ok(out)
    }

    async fn list(&self, root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        let dir = dir_key(dir);
        let tok: Token = token.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
        let page_token = (!tok.page.is_empty()).then_some(tok.page.as_str());
        let mut retried = false;
        let (scope, mut list) = loop {
            let scope = if root == SHARED && dir.is_empty() {
                scope_of(None)
            } else {
                let Some(found) = self.resolve(root, &dir).await? else { return Err(StorageError::not_found()) };
                scope_of(Some(&found.node))
            };
            let q = format!("{scope} and trashed = false");
            match self.d().list(&q, self.corpus(root), ORDER, page_token, PAGE).await {
                Err(e) if e.kind == ErrKind::NotFound && !retried => {
                    retried = true;
                    self.cache.forget(root, &dir);
                }
                r => break (scope, r?),
            }
        };
        // same-named files in a fixed order (Drive's own order of equal times isn't promised)
        let mut i = 0;
        while i < list.files.len() {
            let j = i + list.files[i..].iter().take_while(|f| f.name == list.files[i].name).count();
            oldest_first(&mut list.files[i..j]);
            i = j;
        }
        self.follow_shortcuts(&mut list.files).await;
        let items: Vec<(String, bool)> = list.files.iter().map(|f| (f.name.clone(), f.is_folder())).collect();
        // what this page shows is real; numbers for duplicates skip those and any other real name
        let known: HashMap<(bool, String), bool> = items.iter().map(|(n, f)| ((*f, n.clone()), true)).collect();
        let (names, carry) = self.with_taken(root, &scope, known, |taken| number_page_with(&items, &tok.carry, taken)).await?;
        let mut page = Page::default();
        for (f, name) in list.files.iter().zip(names) {
            let folder = f.is_folder();
            let key = format!("{dir}{name}{}", if folder { "/" } else { "" });
            self.cache.put(root, &key, f.node());
            if folder {
                // a shortcut to a folder is a link: walks (search, sync, folder size, copies)
                // must not go into it, as one pointing back up would never end
                if f.mime_type == api::SHORTCUT {
                    page.folder_info.push(Entry { link: Some(f.name.clone()), ..f.entry(key.clone()) });
                }
                page.folders.push(key);
            } else {
                page.objects.push(f.entry(key));
            }
        }
        page.next_token = list.next_page_token.map(|t| serde_json::to_string(&Token { page: t, carry }).unwrap_or_default());
        Ok(page)
    }

    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>> {
        if path.is_empty() {
            return Ok(Some(Entry { key: String::new(), ..Default::default() }));
        }
        let Some((found, f)) = self.resolve_file(root, path).await? else { return Ok(None) };
        let mut e = f.entry(path.to_string());
        if let Some(x) = found.export {
            e.mime = Some(x.mime.into());
            e.native = None;
        }
        Ok(Some(e))
    }

    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        let Some((found, f)) = self.resolve_file(root, path).await? else { return Err(StorageError::not_found()) };
        if found.node.folder {
            return Err(StorageError::other("This is a folder, not a file."));
        }
        if let Some(tag) = if_match
            && f.etag().as_deref() != Some(tag.trim_matches('"'))
        {
            return Err(StorageError::conflict());
        }
        let export = found.export.or_else(|| exports_of(&found.node.mime).map(|ex| ex.first()).unwrap_or(None));
        if exports_of(&found.node.mime).is_some_and(<[Export]>::is_empty) {
            return Err(StorageError::new(ErrKind::Unsupported, "This kind of Google file can't be downloaded. Open it in Google Drive."));
        }
        if let Some(x) = export {
            // exports come whole: no ranges
            let url = format!("{}/drive/v3/files/{}/export?mimeType={}", self.base, enc(&found.node.id), enc(x.mime));
            let res = self.api.ok(|c| c.get(&url)).await?;
            return Ok(extras::read_stream(res, None, f.etag()));
        }
        if range.as_ref().is_some_and(|r| r.end <= r.start) {
            return Ok(ReadStream { body: Box::pin(futures_util::stream::empty()), len: Some(0), total: None, range, etag: f.etag(), content_type: None });
        }
        let url = format!("{}/drive/v3/files/{}?alt=media&supportsAllDrives=true", self.base, enc(&found.node.id));
        let header = range.as_ref().and_then(extras::range_header);
        let res = self
            .api
            .send(|c| {
                let r = c.get(&url);
                match &header {
                    Some(h) => r.header("range", h),
                    None => r,
                }
            })
            .await?;
        if res.status().as_u16() == 416 {
            return Ok(extras::read_stream(res, range.as_ref(), f.etag()));
        }
        let res = crate::oauth::http::check(ConnKind::Gdrive, res).await?;
        Ok(extras::read_stream(res, range.as_ref(), f.etag()))
    }

    async fn write(
        &self,
        root: &str,
        path: &str,
        src: WriteSource,
        opts: WriteOpts<'_>,
        progress: Progress<'_>,
        cancel: &Arc<AtomicBool>,
    ) -> SResult<WriteOutcome> {
        let (dir, name) = extras::parent_and_name(path);
        if name.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("A file needs a name."));
        }
        if root == SHARED && dir.is_empty() {
            return Err(read_only());
        }
        let existing = match self.resolve_file(root, path).await? {
            Some((found, _)) if found.export.is_some() => None,
            Some((found, f)) => {
                if exports_of(&found.node.mime).is_some() {
                    return Err(native_read_only());
                }
                Some(f)
            }
            None => None,
        };
        if let Some(c) = Self::precondition_fails(&opts.precondition, existing.as_ref(), path) {
            return Ok(c);
        }
        let parent = self.ensure_dir(root, dir).await?;
        let mime = opts.content_type.clone().unwrap_or_else(|| mime_guess::from_path(name).first_or_octet_stream().to_string());
        let source = extras::Source::open(src).await?;
        let drive_name = drive_name(name);
        // a shortcut to a file is saved through to its target (Drive takes no content on the
        // shortcut itself); the shortcut stays what the path names, so rename and delete still
        // act on it and never on the target
        let target = upload::Target { existing: existing.as_ref().map(|f| f.target().0), parent: &parent, name: &drive_name, mime: &mime };
        match upload::upload(&self.api, &self.base, target, source, &opts, progress, cancel).await? {
            Some(f) => {
                let f = match existing {
                    Some(mut link) if link.target().0 != link.id => {
                        link.take_target(f);
                        link
                    }
                    _ => f,
                };
                self.cache.put(root, path, f.node());
                Ok(WriteOutcome::Done(f.entry(path.to_string())))
            }
            None => Ok(WriteOutcome::Cancelled),
        }
    }

    async fn mkdir(&self, root: &str, dir: &str) -> SResult<()> {
        self.ensure_dir(root, dir).await.map(|_| ())
    }

    async fn delete(
        &self,
        root: &str,
        files: &[String],
        dirs: &[String],
        cancel: &AtomicBool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> SResult<(u64, u64)> {
        let total = (files.len() + dirs.len()) as u64;
        on_progress(0, total);
        let keys: Vec<String> = files.iter().cloned().chain(dirs.iter().map(|d| dir_key(d))).collect();
        if keys.iter().any(|k| extras::components(k).map(|c| c.is_empty()).unwrap_or(true)) {
            return Err(StorageError::other("The top of a drive can't be deleted."));
        }
        let counter = std::sync::atomic::AtomicU64::new(0);
        let done = &counter;
        {
            let mut work = futures_util::stream::iter(keys.into_iter().map(|key: String| async move {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err(StorageError::cancelled());
                }
                if let Some(found) = self.resolve(root, &key).await? {
                    match self.d().trash(&found.node.own_id).await {
                        Ok(()) => {}
                        Err(e) if e.kind == ErrKind::NotFound => {}
                        Err(e) => return Err(e),
                    }
                }
                self.cache.forget(root, &key);
                let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                on_progress(n, total);
                Ok(())
            }))
            .buffer_unordered(6);
            while let Some(r) = work.next().await {
                r?;
            }
        }
        Ok((counter.into_inner(), total))
    }

    async fn copy(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        let src_key = if is_dir { dir_key(&from.path) } else { from.path.clone() };
        let dst_key = if is_dir { dir_key(&to.path) } else { to.path.clone() };
        let Some((_, src)) = self.resolve_file(&from.root, &src_key).await? else { return Err(StorageError::not_found()) };
        let (dir, name) = extras::parent_and_name(&dst_key);
        if to.root == SHARED && dir.is_empty() {
            return Err(read_only());
        }
        self.clear_target(&to.root, &dst_key, is_dir).await?;
        let parent = self.ensure_dir(&to.root, dir).await?;
        self.copy_tree(src, parent, drive_name(name)).await?;
        self.cache.forget(&to.root, &dst_key);
        Ok(())
    }

    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        let src_key = if is_dir { dir_key(&from.path) } else { from.path.clone() };
        let dst_key = if is_dir { dir_key(&to.path) } else { to.path.clone() };
        if extras::components(&src_key)?.is_empty() {
            return Err(StorageError::other("The top of a drive can't be moved."));
        }
        if from.root == to.root && src_key == dst_key {
            return Err(StorageError::other("Source and destination are the same"));
        }
        if is_dir && from.root == to.root && dst_key.starts_with(&src_key) {
            return Err(StorageError::other("Cannot move a folder into itself"));
        }
        let Some((found, src)) = self.resolve_file(&from.root, &src_key).await? else { return Err(StorageError::not_found()) };
        let (dir, name) = extras::parent_and_name(&dst_key);
        if to.root == SHARED && dir.is_empty() {
            return Err(read_only());
        }
        self.clear_target(&to.root, &dst_key, is_dir).await?;
        let parent = self.ensure_dir(&to.root, dir).await?;
        let old_parent = src.parents.first().cloned();
        // the top of My Drive is "root" here but its real id in `parents`: a rename there isn't a
        // move (adding and removing the same parent could leave the file with none)
        let mut moving = old_parent.as_deref() != Some(parent.as_str());
        if moving && parent == MY_DRIVE && to.root == MY_DRIVE && old_parent.is_some() {
            moving = old_parent.as_deref() != Some(self.my_root_id().await?.as_str());
        }
        let new_name = drive_name(name);
        let meta = if new_name != src.name { json!({ "name": new_name }) } else { json!({}) };
        self.d()
            .update(&found.node.own_id, &meta, moving.then_some(parent.as_str()), if moving { old_parent.as_deref() } else { None })
            .await?;
        self.cache.forget(&from.root, &src_key);
        self.cache.forget(&to.root, &dst_key);
        Ok(())
    }

    async fn thumbnail(&self, loc: &Loc, _e: &Entry) -> SResult<Option<bytes::Bytes>> {
        let Some(found) = self.resolve(&loc.root, &loc.path).await? else { return Ok(None) };
        let link = match found.file.as_ref().and_then(|f| f.thumbnail_link.clone()) {
            Some(l) => Some(l),
            None => self.d().get(&found.node.id, "thumbnailLink").await?.thumbnail_link,
        };
        let Some(link) = link else { return Ok(None) };
        // links end with the size ("=s220"); ask for one big enough for the grid
        let link = match link.rfind("=s") {
            Some(i) if link[i + 2..].bytes().all(|b| b.is_ascii_digit()) => format!("{}=s512", &link[..i]),
            _ => link,
        };
        let res = self.api.send(|c| c.get(&link)).await?;
        if !res.status().is_success() {
            return Ok(None);
        }
        Ok(Some(res.bytes().await.map_err(|e| crate::oauth::http::net_error(ConnKind::Gdrive, &e))?))
    }

    async fn changes(&self, root: &str, cursor: Option<String>) -> SResult<ChangeBatch> {
        // "Shared with me" has no folder id a changed file's parents could end at: every change
        // would read as a removal (B3-1). Its syncs list it in full instead, as OneDrive's do.
        if root == SHARED {
            return Err(StorageError::unsupported());
        }
        let drive = match root {
            MY_DRIVE => String::new(),
            d => format!("&driveId={}&includeItemsFromAllDrives=true", enc(d)),
        };
        let Some(cursor) = cursor else {
            let url = format!("{}/drive/v3/changes/startPageToken?supportsAllDrives=true{drive}", self.base);
            let v: Value = self.api.json(|c| c.get(&url)).await?;
            let token = v["startPageToken"].as_str().unwrap_or_default().to_string();
            return Ok(ChangeBatch { changes: vec![], cursor: token, has_more: false });
        };
        let fields = format!("nextPageToken,newStartPageToken,changes(fileId,removed,file({FILE_FIELDS},trashed,driveId))");
        let url = format!(
            "{}/drive/v3/changes?pageToken={}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields={}{drive}",
            self.base,
            enc(&cursor),
            enc(&fields)
        );
        let v: Value = self.api.json(|c| c.get(&url)).await?;
        let mut names = HashMap::new();
        let mut changes = Vec::new();
        for c in v["changes"].as_array().into_iter().flatten() {
            let id = c["fileId"].as_str().map(str::to_string);
            // My Drive's feed also brings every shared drive's changes: those files aren't in it
            // (one moved out of My Drive is gone from it), so no walk up their folders
            let elsewhere = root == MY_DRIVE && c["file"]["driveId"].as_str().is_some_and(|d| !d.is_empty());
            let gone = elsewhere || c["removed"].as_bool() == Some(true) || c["file"]["trashed"].as_bool() == Some(true);
            if gone {
                changes.push(Change { key: String::new(), entry: None, id });
                continue;
            }
            let Ok(mut f) = serde_json::from_value::<DFile>(c["file"].clone()) else { continue };
            let Some(at) = self.path_in_root(root, &f, &mut names).await? else {
                // not (or no longer) in this drive: gone from it, as far as anyone here knows
                changes.push(Change { key: String::new(), entry: None, id });
                continue;
            };
            self.follow_shortcuts(std::slice::from_mut(&mut f)).await;
            changes.push(Change { entry: Some(f.entry(at.clone())), key: at, id });
        }
        if !changes.is_empty() {
            self.cache.forget_root(root);
        }
        let (cursor, has_more) = match v["nextPageToken"].as_str() {
            Some(t) => (t.to_string(), true),
            None => (v["newStartPageToken"].as_str().unwrap_or(&cursor).to_string(), false),
        };
        Ok(ChangeBatch { changes, cursor, has_more })
    }

    async fn quota(&self) -> SResult<Option<Quota>> {
        let url = format!("{}/drive/v3/about?fields={}", self.base, enc("storageQuota(limit,usage)"));
        let v: Value = self.api.json(|c| c.get(&url)).await?;
        let n = |v: &Value| v.as_str().and_then(|s| s.parse::<u64>().ok());
        Ok(Some(Quota { used: n(&v["storageQuota"]["usage"]).unwrap_or(0), total: n(&v["storageQuota"]["limit"]) }))
    }
}

#[cfg(test)]
mod tests;
