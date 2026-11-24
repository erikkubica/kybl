//! OneDrive (Microsoft Graph v1.0, hand-written on reqwest). Roots: the user's drive ([`ME`])
//! and a read-only "Shared with me" ([`SHARED`]). OneDrive is path-based: items are addressed as
//! `/me/drive/root:/a/b.txt:`. Files over 4 MiB go up in an upload session (pieces a multiple of
//! 320 KiB, as Graph requires) that resumes after a dropped connection and, through
//! `ResumeState.upload_id` (the session address), in a later run. Deleting goes to the recycle
//! bin. Share links: the temporary download address for an hour or less, else a view-only
//! "anyone with the link" link with an expiry.

use std::{
    collections::{HashMap, HashSet},
    ops::Range,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    extras::{self, Source},
    gdrive::paths::number_page,
    *,
};
use crate::oauth::http::{backoff, check, enc, read_json, unexpected, Api};

pub const ME: &str = "me";
pub const SHARED: &str = "shared-with-me";
/// Up to this size a file goes up in one request.
const SIMPLE_MAX: u64 = 4 * 1024 * 1024;
const QUANTUM: u64 = 320 * 1024;
const DEFAULT_PIECE: u64 = 32 * QUANTUM;
const FAILURES: u32 = 5;
const SELECT: &str = "id,name,size,lastModifiedDateTime,eTag,cTag,file,folder,parentReference,package,remoteItem,deleted";

pub fn onedrive_caps() -> Capabilities {
    Capabilities {
        roots: RootsMode::Drives,
        folders: FolderMode::Real,
        rename: RenameMode::Native,
        server_copy: ServerCopy::SameRoot,
        share: ShareMode::Link,
        share_expiry: true,
        // the temporary download address takes ranges, so media can play from it directly
        streaming: StreamingMode::Presign,
        range_read: true,
        conditional_write: CondWrite::IfMatch,
        hashes: vec![HashKind::Quickxor],
        thumbnails: ThumbMode::LocalRemote,
        trash: true,
        changes: true,
        multipart: true,
        max_object_size: Some(250 * 1024 * 1024 * 1024),
        ..Capabilities::default()
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub size: Option<i64>,
    pub last_modified_date_time: Option<String>,
    pub e_tag: Option<String>,
    pub file: Option<Value>,
    pub folder: Option<Value>,
    pub package: Option<Value>,
    pub parent_reference: Option<Value>,
    pub remote_item: Option<Box<Item>>,
    pub deleted: Option<Value>,
    #[serde(rename = "@microsoft.graph.downloadUrl")]
    pub download_url: Option<String>,
}

impl Item {
    pub fn is_folder(&self) -> bool {
        self.folder.is_some() || self.remote_item.as_ref().is_some_and(|r| r.folder.is_some())
    }
    pub fn entry(&self, key: String) -> Entry {
        let file = self.file.as_ref().or_else(|| self.remote_item.as_ref().and_then(|r| r.file.as_ref()));
        let hash = |k: &str| file.and_then(|f| f["hashes"][k].as_str()).map(str::to_string);
        Entry {
            key,
            size: self.size.unwrap_or(0),
            modified: self.last_modified_date_time.as_deref().and_then(extras::parse_rfc3339),
            etag: self.e_tag.clone(),
            storage_class: None,
            id: Some(self.id.clone()),
            mime: file.and_then(|f| f["mimeType"].as_str()).map(str::to_string),
            hashes: Hashes { quickxor: hash("quickXorHash"), sha1: hash("sha1Hash"), sha256: hash("sha256Hash"), ..Default::default() },
            native: None,
            ..Default::default()
        }
    }
}

/// A shared item's place in someone else's drive.
#[derive(Clone, Debug)]
struct Remote {
    drive: String,
    id: String,
}

pub struct OneDrive {
    api: Api,
    base: String,
    caps: Capabilities,
    /// "Shared with me" names → where they live
    shared: Mutex<HashMap<String, Remote>>,
}

fn read_only() -> StorageError {
    StorageError::new(ErrKind::PermissionDenied, "Nothing can be added to Shared with me itself. Open a shared folder and add it there.")
}

fn dir_key(dir: &str) -> String {
    if dir.is_empty() || dir.ends_with('/') { dir.to_string() } else { format!("{dir}/") }
}

impl OneDrive {
    pub fn new(api: Api) -> Self {
        Self::with_base(api, "https://graph.microsoft.com/v1.0")
    }

    pub fn with_base(api: Api, base: impl Into<String>) -> Self {
        Self { api, base: base.into().trim_end_matches('/').to_string(), caps: onedrive_caps(), shared: Default::default() }
    }

    /// The Graph address of the item at `path` in `root`.
    async fn item_url(&self, root: &str, path: &str) -> SResult<String> {
        let parts = extras::components(path)?;
        let encoded = |p: &[&str]| p.iter().map(|c| enc(c)).collect::<Vec<_>>().join("/");
        match root {
            ME if parts.is_empty() => Ok(format!("{}/me/drive/root", self.base)),
            ME => Ok(format!("{}/me/drive/root:/{}:", self.base, encoded(&parts))),
            SHARED => {
                let Some(top) = parts.first() else { return Err(read_only()) };
                let r = self.shared_item(top).await?.ok_or_else(StorageError::not_found)?;
                let item = format!("{}/drives/{}/items/{}", self.base, enc(&r.drive), enc(&r.id));
                Ok(if parts.len() == 1 { item } else { format!("{item}:/{}:", encoded(&parts[1..])) })
            }
            _ => Err(StorageError::not_found()),
        }
    }

    async fn shared_item(&self, name: &str) -> SResult<Option<Remote>> {
        if let Some(r) = self.shared.lock().unwrap().get(name) {
            return Ok(Some(r.clone()));
        }
        self.list_shared().await?;
        Ok(self.shared.lock().unwrap().get(name).cloned())
    }

    /// The top of "Shared with me" (names numbered like Drive's duplicates).
    async fn list_shared(&self) -> SResult<Page> {
        // every page: names are numbered over the whole list, and a missing item's path 404s
        let mut url = format!("{}/me/drive/sharedWithMe", self.base);
        let mut items: Vec<Item> = Vec::new();
        let mut seen = HashSet::new();
        for _ in 0..100 {
            let v: Value = self.api.json(|c| c.get(&url)).await?;
            items.extend(serde_json::from_value::<Vec<Item>>(v["value"].clone()).unwrap_or_default());
            match v["@odata.nextLink"].as_str() {
                Some(next) if next.starts_with(&self.base) && seen.insert(next.to_string()) => url = next.to_string(),
                _ => break,
            }
        }
        let names: Vec<(String, bool)> = items.iter().map(|i| (i.name.clone(), i.is_folder())).collect();
        let (shown, _) = number_page(&names, &Default::default());
        let mut page = Page::default();
        let mut map = self.shared.lock().unwrap();
        for (it, name) in items.iter().zip(shown) {
            let Some(remote) = &it.remote_item else { continue };
            let drive = remote.parent_reference.as_ref().and_then(|p| p["driveId"].as_str()).unwrap_or_default().to_string();
            map.insert(name.clone(), Remote { drive, id: remote.id.clone() });
            if it.is_folder() {
                page.folders.push(format!("{name}/"));
            } else {
                page.objects.push(it.entry(name));
            }
        }
        Ok(page)
    }

    /// The key of the folder with this id in the user's drive ("" for the top, "a/b/" below);
    /// None when it no longer exists or isn't in the drive.
    async fn folder_key(&self, id: &str) -> SResult<Option<String>> {
        let url = format!("{}/me/drive/items/{}?$select={}", self.base, enc(id), enc("id,name,parentReference,root"));
        let res = self.api.send(|c| c.get(&url)).await?;
        if res.status().as_u16() == 404 {
            return Ok(None);
        }
        let v: Value = read_json(ConnKind::Onedrive, check(ConnKind::Onedrive, res).await?).await?;
        if !v["root"].is_null() {
            return Ok(Some(String::new()));
        }
        let (Some(path), Some(name)) = (v["parentReference"]["path"].as_str(), v["name"].as_str()) else { return Ok(None) };
        Ok(key_from_parent(path, name, true))
    }

    async fn get_item(&self, root: &str, path: &str) -> SResult<Option<Item>> {
        let url = format!("{}?$select={}", self.item_url(root, path).await?, enc(SELECT));
        let res = self.api.send(|c| c.get(&url)).await?;
        if res.status().as_u16() == 404 {
            return Ok(None);
        }
        let res = check(ConnKind::Onedrive, res).await?;
        Ok(Some(read_json(ConnKind::Onedrive, res).await?))
    }

    /// The folder `dir` and every missing parent. OneDrive keeps names unique, so a folder
    /// someone else just made is simply there (409) and parallel calls can't make two.
    async fn ensure_dir(&self, root: &str, dir: &str) -> SResult<()> {
        let parts = extras::components(dir)?;
        if root == SHARED && parts.len() <= 1 {
            return if parts.is_empty() || self.shared_item(parts[0]).await?.is_some() { Ok(()) } else { Err(read_only()) };
        }
        // most uploads go into folders that exist: check the deepest first
        if parts.is_empty() || self.get_item(root, dir).await?.is_some_and(|i| i.is_folder()) {
            return Ok(());
        }
        let skip = if root == SHARED { 1 } else { 0 };
        for i in skip..parts.len() {
            let parent = parts[..i].join("/");
            let url = format!("{}/children", self.item_url(root, &parent).await?);
            let body = json!({ "name": parts[i], "folder": {}, "@microsoft.graph.conflictBehavior": "fail" }).to_string();
            let res = self.api.send(|c| c.post(&url).header("content-type", "application/json").body(body.clone())).await?;
            match res.status().as_u16() {
                200 | 201 | 409 => {}
                _ => {
                    check(ConnKind::Onedrive, res).await?;
                }
            }
        }
        Ok(())
    }

    fn precondition_fails(pre: &Precondition, existing: Option<&Item>, key: &str) -> Option<WriteOutcome> {
        let fails = match pre {
            Precondition::None | Precondition::IfMatch(_) => false,
            Precondition::IfNoneMatch => existing.is_some(),
            Precondition::IfUnchanged { etag, size, modified } => match existing {
                None => true,
                Some(it) => match etag {
                    Some(t) => it.e_tag.as_deref() != Some(t.as_str()),
                    None => {
                        let e = it.entry(key.to_string());
                        e.size != *size || e.modified != *modified
                    }
                },
            },
        };
        fails.then(|| WriteOutcome::Conflict(existing.map(|i| i.entry(key.to_string()))))
    }

    async fn upload_session(
        &self,
        item: &str,
        name: &str,
        mut src: Source,
        opts: &WriteOpts<'_>,
        progress: Progress<'_>,
        cancel: &AtomicBool,
    ) -> SResult<Option<Result<Item, ()>>> {
        let total = src.len.unwrap_or(0);
        let piece = opts.part_size.map(|p| (p / QUANTUM).max(1) * QUANTUM).unwrap_or(DEFAULT_PIECE);
        let behavior = if matches!(opts.precondition, Precondition::IfNoneMatch) { "fail" } else { "replace" };
        let if_match = if_match_of(&opts.precondition).map(str::to_string);
        let start = || async {
            let url = format!("{item}/createUploadSession");
            let body = json!({ "item": { "@microsoft.graph.conflictBehavior": behavior, "name": name } }).to_string();
            let res = self
                .api
                .send(|c| {
                    let r = c.post(&url).header("content-type", "application/json").body(body.clone());
                    match &if_match {
                        Some(t) => r.header("if-match", t),
                        None => r,
                    }
                })
                .await?;
            match res.status().as_u16() {
                409 | 412 => Ok(None),
                _ => {
                    let v: Value = read_json(ConnKind::Onedrive, check(ConnKind::Onedrive, res).await?).await?;
                    v["uploadUrl"].as_str().map(|s| Some(s.to_string())).ok_or_else(|| unexpected(ConnKind::Onedrive, "no upload address"))
                }
            }
        };
        // how far a session got: Some(next byte), None when it's gone
        let status = |session: String| async move {
            let res = self.api.send_unsigned(|c| c.get(&session)).await?;
            if matches!(res.status().as_u16(), 404 | 410) {
                return Ok::<_, StorageError>(None);
            }
            let v: Value = read_json(ConnKind::Onedrive, check(ConnKind::Onedrive, res).await?).await?;
            Ok(Some(next_expected(&v).unwrap_or(0)))
        };
        // B3-5: a session that is gone right after its last piece was sent may well have finished
        // (the answer was lost on the way): the item is there, with this size, written just now,
        // and not the version an If-Match named, so it is taken as done instead of failing.
        let landed = |end: u64| {
            let if_match = if_match.clone();
            async move {
                const RECENT_MS: i64 = 15 * 60 * 1000;
                if end != total {
                    return None;
                }
                let url = format!("{item}?$select={}", enc(SELECT));
                let res = self.api.send(|c| c.get(&url)).await.ok()?;
                let it: Item = read_json(ConnKind::Onedrive, check(ConnKind::Onedrive, res).await.ok()?).await.ok()?;
                let fresh = it.last_modified_date_time.as_deref().and_then(extras::parse_rfc3339).is_some_and(|t| (extras::now_ms() - t).abs() < RECENT_MS);
                let changed = if_match.is_none_or(|old| it.e_tag.as_deref() != Some(old.as_str()));
                (!it.is_folder() && it.size == Some(total as i64) && fresh && changed).then_some(it)
            }
        };
        let mut offset = 0u64;
        let mut session = None;
        if let Some(rs) = &opts.resume
            && let Some(at) = status(rs.upload_id.clone()).await?
        {
            session = Some(rs.upload_id.clone());
            offset = at;
        }
        let mut session = match session {
            Some(s) => s,
            None => match start().await? {
                Some(s) => s,
                None => return Ok(Some(Err(()))),
            },
        };
        let mut restarted = false;
        let mut failures = 0u32;
        loop {
            // with `on_part` the caller keeps the session to carry on later (a paused transfer)
            if cancel.load(Ordering::Relaxed) {
                if opts.on_part.is_none() {
                    let _ = self.api.send_unsigned(|c| c.delete(&session)).await;
                }
                return Ok(None);
            }
            src.seek(offset).await?;
            let chunk = match src.chunk(piece as usize, cancel).await {
                Err(e) if e.is_cancelled() => {
                    if opts.on_part.is_none() {
                        let _ = self.api.send_unsigned(|c| c.delete(&session)).await;
                    }
                    return Ok(None);
                }
                r => r?,
            };
            if chunk.is_empty() {
                return Err(StorageError::other("The file got shorter while it was uploading. Try again."));
            }
            let end = offset + chunk.len() as u64;
            let range = format!("bytes {offset}-{}/{total}", end - 1);
            let len = chunk.len();
            let sent = self.api.send_piece(false, &chunk, |c, body| c.put(&session).header("content-range", &range).header("content-length", len).body(body)).await;
            let res = match sent {
                Ok(r) => r,
                Err(e) if e.kind == ErrKind::Network && failures < FAILURES => {
                    failures += 1;
                    tokio::time::sleep(backoff(failures)).await;
                    offset = loop {
                        // a probe the network drops too counts against the same budget (B3-4)
                        match status(session.clone()).await {
                            Err(e) if e.kind == ErrKind::Network && failures < FAILURES => {
                                failures += 1;
                                tokio::time::sleep(backoff(failures)).await;
                            }
                            r => match r? {
                                Some(at) => break at,
                                None => match landed(end).await {
                                    Some(it) => {
                                        progress(total, total);
                                        return Ok(Some(Ok(it)));
                                    }
                                    None => return Err(StorageError::other("OneDrive dropped the upload. Try again.")),
                                },
                            },
                        }
                    };
                    continue;
                }
                Err(e) => return Err(e),
            };
            match res.status().as_u16() {
                200 | 201 => {
                    progress(total, total);
                    return Ok(Some(Ok(read_json(ConnKind::Onedrive, res).await?)));
                }
                202 => {
                    let v: Value = read_json(ConnKind::Onedrive, res).await?;
                    let next = next_expected(&v).unwrap_or(end);
                    if next > offset {
                        failures = 0;
                        if let Some(f) = opts.on_part {
                            f(PartRecord { number: (offset / piece) as u32 + 1, size: next - offset, etag: session.clone() });
                        }
                    } else {
                        failures += 1;
                        if failures > FAILURES {
                            return Err(StorageError::other("OneDrive didn't take the upload. Try again."));
                        }
                    }
                    offset = next;
                    progress(offset, total);
                }
                409 | 412 => return Ok(Some(Err(()))),
                404 | 410 if !restarted => {
                    restarted = true;
                    session = match start().await? {
                        Some(s) => s,
                        None => return Ok(Some(Err(()))),
                    };
                    offset = 0;
                }
                s if s >= 500 && failures < FAILURES => {
                    failures += 1;
                    tokio::time::sleep(backoff(failures)).await;
                    offset = loop {
                        // a probe the network drops too counts against the same budget (B3-4)
                        match status(session.clone()).await {
                            Err(e) if e.kind == ErrKind::Network && failures < FAILURES => {
                                failures += 1;
                                tokio::time::sleep(backoff(failures)).await;
                            }
                            r => match r? {
                                Some(at) => break at,
                                None => match landed(end).await {
                                    Some(it) => {
                                        progress(total, total);
                                        return Ok(Some(Ok(it)));
                                    }
                                    None => return Err(StorageError::other("OneDrive dropped the upload. Try again.")),
                                },
                            },
                        }
                    };
                }
                _ => return Err(check(ConnKind::Onedrive, res).await.err().unwrap_or_else(|| unexpected(ConnKind::Onedrive, "upload"))),
            }
        }
    }

    /// Waits for a server-side copy (Graph answers with a monitor address).
    async fn wait_copy(&self, monitor: &str) -> SResult<()> {
        // a redirect is the "done" answer, so it must be seen rather than followed
        let api = Api { http: crate::oauth::http::client_no_redirect(), ..self.api.clone() };
        for i in 0..600u32 {
            let res = api.send_unsigned(|c| c.get(monitor)).await?;
            // done: the monitor sends us to the new item (or answers with it)
            if res.status().is_redirection() || res.status().as_u16() == 200 && res.headers().get("location").is_some() {
                return Ok(());
            }
            let v: Value = read_json(ConnKind::Onedrive, check(ConnKind::Onedrive, res).await?).await?;
            match v["status"].as_str() {
                Some("completed") => return Ok(()),
                Some("failed") => {
                    return Err(StorageError::other("OneDrive couldn't finish the copy.").with_detail(v["error"].to_string()));
                }
                _ => {}
            }
            if v["resourceId"].is_string() && v["status"].is_null() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(if i < 10 { 300 } else { 1000 })).await;
        }
        Err(StorageError::other("OneDrive is still copying. Check again in a while."))
    }

    /// The id and drive of the folder at `dir` (made if missing), for copies and moves.
    async fn folder_ref(&self, root: &str, dir: &str) -> SResult<Value> {
        self.ensure_dir(root, dir).await?;
        let it = self.get_item(root, dir).await?.ok_or_else(StorageError::not_found)?;
        let drive = it.parent_reference.as_ref().and_then(|p| p["driveId"].as_str()).map(str::to_string);
        Ok(match drive {
            Some(d) => json!({ "id": it.id, "driveId": d }),
            None => json!({ "id": it.id }),
        })
    }
}

/// The start of the first range in `nextExpectedRanges` (["12345-"] or ["12345-67890"]).
pub fn next_expected(v: &Value) -> Option<u64> {
    v["nextExpectedRanges"][0].as_str()?.split('-').next()?.trim().parse().ok()
}

/// "/drive/root:/a/b" (a parent's path in delta answers) + name → "a/b/name".
pub fn key_from_parent(parent_path: &str, name: &str, folder: bool) -> Option<String> {
    let rest = parent_path.split_once("root:")?.1.trim_start_matches('/');
    let rest = percent_encoding::percent_decode_str(rest).decode_utf8_lossy();
    let sep = if rest.is_empty() { "" } else { "/" };
    Some(format!("{rest}{sep}{name}{}", if folder { "/" } else { "" }))
}

#[async_trait]
impl Storage for OneDrive {
    fn kind(&self) -> ConnKind {
        ConnKind::Onedrive
    }

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        Ok(vec![
            RootInfo { id: ME.into(), name: "OneDrive".into(), kind: RootKind::Drive, created: None, read_only: false },
            RootInfo { id: SHARED.into(), name: "Shared with me".into(), kind: RootKind::Shared, created: None, read_only: true },
        ])
    }

    async fn list(&self, root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        let dir = dir_key(dir);
        if root == SHARED && dir.is_empty() {
            return self.list_shared().await;
        }
        let url = match token {
            // the next page's address, as Graph gave it (never anywhere else)
            Some(t) if t.starts_with(&self.base) => t,
            Some(_) => return Err(StorageError::other("This listing can't carry on. Open the folder again.")),
            None => format!("{}/children?$top=1000&$select={}", self.item_url(root, &dir).await?, enc(SELECT)),
        };
        let v: Value = self.api.json(|c| c.get(&url)).await?;
        let items: Vec<Item> = serde_json::from_value(v["value"].clone()).map_err(|e| unexpected(ConnKind::Onedrive, e))?;
        let mut page = Page::default();
        for it in items {
            // OneNote notebooks can't be opened as files or folders
            if it.package.is_some() && it.folder.is_none() && it.file.is_none() {
                continue;
            }
            if it.is_folder() {
                page.folders.push(format!("{dir}{}/", it.name));
            } else {
                page.objects.push(it.entry(format!("{dir}{}", it.name)));
            }
        }
        page.next_token = v["@odata.nextLink"].as_str().map(str::to_string);
        Ok(page)
    }

    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>> {
        if path.is_empty() || (root == SHARED && extras::components(path)?.is_empty()) {
            return Ok(Some(Entry { key: path.to_string(), ..Default::default() }));
        }
        let Some(it) = self.get_item(root, path).await? else { return Ok(None) };
        if it.is_folder() != path.ends_with('/') {
            return Ok(None);
        }
        Ok(Some(it.entry(path.to_string())))
    }

    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        let item = self.item_url(root, path).await?;
        let mut etag = None;
        if let Some(tag) = if_match {
            let it = self.get_item(root, path).await?.ok_or_else(StorageError::not_found)?;
            if it.e_tag.as_deref() != Some(tag) {
                return Err(StorageError::conflict());
            }
            etag = it.e_tag;
        }
        if range.as_ref().is_some_and(|r| r.end <= r.start) {
            return Ok(ReadStream { body: Box::pin(futures_util::stream::empty()), len: Some(0), total: None, range, etag, content_type: None });
        }
        let url = format!("{item}/content");
        let header = range.as_ref().and_then(extras::range_header);
        // Graph sends the client on to a temporary download address (which takes the range)
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
            return Ok(extras::read_stream(res, range.as_ref(), etag));
        }
        let res = check(ConnKind::Onedrive, res).await?;
        Ok(extras::read_stream(res, range.as_ref(), etag))
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
        let existing = match &opts.precondition {
            Precondition::IfUnchanged { .. } => self.get_item(root, path).await?,
            _ => None,
        };
        if let Some(c) = Self::precondition_fails(&opts.precondition, existing.as_ref(), path) {
            return Ok(c);
        }
        let conflict = || async { Ok(WriteOutcome::Conflict(self.get_item(root, path).await?.map(|i| i.entry(path.to_string())))) };
        let source = Source::open(src).await?.spool(cancel).await?;
        let total = source.len.unwrap_or(0);
        progress(0, total);
        let item = self.item_url(root, path).await?;
        if total <= SIMPLE_MAX.min(opts.part_size.unwrap_or(SIMPLE_MAX)) && opts.resume.is_none() {
            let mut source = source;
            let bytes = match source.rest(SIMPLE_MAX, cancel).await {
                Err(e) if e.is_cancelled() => return Ok(WriteOutcome::Cancelled),
                r => r?,
            };
            let behavior = if matches!(opts.precondition, Precondition::IfNoneMatch) { "fail" } else { "replace" };
            let url = format!("{item}/content?@microsoft.graph.conflictBehavior={behavior}");
            let ctype = opts.content_type.clone().unwrap_or_else(|| mime_guess::from_path(name).first_or_octet_stream().to_string());
            let put = || {
                self.api.send_piece(true, &bytes, |c, body| {
                    let r = c.put(&url).header("content-type", &ctype).header("content-length", bytes.len()).body(body);
                    match if_match_of(&opts.precondition) {
                        Some(t) => r.header("if-match", t),
                        None => r,
                    }
                })
            };
            let mut res = put().await?;
            if res.status().as_u16() == 404 && !dir.is_empty() {
                // the folder isn't there yet
                self.ensure_dir(root, dir).await?;
                res = put().await?;
            }
            if matches!(res.status().as_u16(), 409 | 412) {
                return conflict().await;
            }
            let it: Item = read_json(ConnKind::Onedrive, check(ConnKind::Onedrive, res).await?).await?;
            progress(total, total);
            return Ok(WriteOutcome::Done(it.entry(path.to_string())));
        }
        if !dir.is_empty() {
            self.ensure_dir(root, dir).await?;
        }
        match self.upload_session(&item, name, source, &opts, progress, cancel).await? {
            Some(Ok(it)) => Ok(WriteOutcome::Done(it.entry(path.to_string()))),
            Some(Err(())) => conflict().await,
            None => Ok(WriteOutcome::Cancelled),
        }
    }

    async fn mkdir(&self, root: &str, dir: &str) -> SResult<()> {
        self.ensure_dir(root, dir).await
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
        let min = if root == SHARED { 2 } else { 1 };
        if keys.iter().any(|k| extras::components(k).map(|c| c.len() < min).unwrap_or(true)) {
            return Err(if root == SHARED { read_only() } else { StorageError::other("The top of a drive can't be deleted.") });
        }
        let counter = AtomicU64::new(0);
        let done = &counter;
        {
            let mut work = futures_util::stream::iter(keys.into_iter().map(|key: String| async move {
                if cancel.load(Ordering::Relaxed) {
                    return Err(StorageError::cancelled());
                }
                let url = self.item_url(root, &key).await?;
                let res = self.api.send(|c| c.delete(&url)).await?;
                if res.status().as_u16() != 404 {
                    check(ConnKind::Onedrive, res).await?;
                }
                on_progress(done.fetch_add(1, Ordering::Relaxed) + 1, total);
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
        if from.root != to.root {
            return Err(StorageError::unsupported());
        }
        let src_key = if is_dir { dir_key(&from.path) } else { from.path.clone() };
        let dst_key = if is_dir { dir_key(&to.path) } else { to.path.clone() };
        let (dir, name) = extras::parent_and_name(&dst_key);
        if is_dir && self.get_item(&to.root, &dst_key).await?.is_some() {
            return Err(StorageError::new(ErrKind::Exists, "A folder with this name is already there."));
        }
        let parent = self.folder_ref(&to.root, dir).await?;
        let url = format!("{}/copy?@microsoft.graph.conflictBehavior=replace", self.item_url(&from.root, &src_key).await?);
        let body = json!({ "parentReference": parent, "name": name }).to_string();
        let res = self.api.ok(|c| c.post(&url).header("content-type", "application/json").body(body.clone())).await?;
        match res.headers().get("location").and_then(|v| v.to_str().ok()) {
            Some(monitor) => self.wait_copy(monitor).await,
            None => Ok(()),
        }
    }

    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        if from.root != to.root {
            return Err(StorageError::unsupported());
        }
        let src_key = if is_dir { dir_key(&from.path) } else { from.path.clone() };
        let dst_key = if is_dir { dir_key(&to.path) } else { to.path.clone() };
        if extras::components(&src_key)?.len() < if from.root == SHARED { 2 } else { 1 } {
            return Err(StorageError::other("The top of a drive can't be moved."));
        }
        if src_key == dst_key {
            return Err(StorageError::other("Source and destination are the same"));
        }
        if is_dir && dst_key.starts_with(&src_key) {
            return Err(StorageError::other("Cannot move a folder into itself"));
        }
        let (dir, name) = extras::parent_and_name(&dst_key);
        let parent = self.folder_ref(&to.root, dir).await?;
        let behavior = if is_dir { "fail" } else { "replace" };
        let url = format!("{}?@microsoft.graph.conflictBehavior={behavior}", self.item_url(&from.root, &src_key).await?);
        let body = json!({ "name": name, "parentReference": { "id": parent["id"] } }).to_string();
        self.api.ok(|c| c.patch(&url).header("content-type", "application/json").body(body.clone())).await.map(|_| ())
    }

    async fn share_link(&self, loc: &Loc, ttl: Option<Duration>) -> SResult<String> {
        // an hour or less: the temporary download address (private to whoever has it, like a
        // presigned URL); longer: a view-only link that anyone can open until it expires
        if ttl.is_some_and(|t| t <= Duration::from_secs(3600)) {
            let url = self.item_url(&loc.root, &loc.path).await?;
            let it: Item = self.api.json(|c| c.get(&url)).await?;
            if let Some(u) = it.download_url {
                return Ok(u);
            }
        }
        let url = format!("{}/createLink", self.item_url(&loc.root, &loc.path).await?);
        let mut body = json!({ "type": "view", "scope": "anonymous" });
        if let Some(t) = ttl {
            body["expirationDateTime"] = json!(extras::format_rfc3339(extras::now_ms() + t.as_millis() as i64));
        }
        let body = body.to_string();
        let res = self.api.send(|c| c.post(&url).header("content-type", "application/json").body(body.clone())).await?;
        if res.status().as_u16() == 400 && ttl.is_some() {
            let b = res.bytes().await.unwrap_or_default();
            return Err(StorageError::new(ErrKind::Unsupported, "OneDrive didn't make a link that expires. Your account may not allow expiring links: pick a shorter time.")
                .with_detail(String::from_utf8_lossy(&b).to_string()));
        }
        let v: Value = read_json(ConnKind::Onedrive, check(ConnKind::Onedrive, res).await?).await?;
        v["link"]["webUrl"].as_str().map(str::to_string).ok_or_else(|| unexpected(ConnKind::Onedrive, "no link"))
    }

    async fn thumbnail(&self, loc: &Loc, _e: &Entry) -> SResult<Option<bytes::Bytes>> {
        let url = format!("{}/thumbnails/0/medium/content", self.item_url(&loc.root, &loc.path).await?);
        let res = self.api.send(|c| c.get(&url)).await?;
        if !res.status().is_success() {
            return Ok(None);
        }
        Ok(Some(res.bytes().await.map_err(|e| crate::oauth::http::net_error(ConnKind::Onedrive, &e))?))
    }

    async fn changes(&self, root: &str, cursor: Option<String>) -> SResult<ChangeBatch> {
        if root != ME {
            return unsupported();
        }
        let url = match cursor {
            Some(c) if c.starts_with(&self.base) => c,
            Some(_) => return Err(StorageError::other("This change list can't carry on. Start again.")),
            // "latest": a cursor for from now on, without listing everything first
            None => format!("{}/me/drive/root/delta?token=latest", self.base),
        };
        let mut changes = Vec::new();
        let v: Value = self.api.json(|c| c.get(&url)).await?;
        // delta answers leave out `parentReference.path` ("track items by id"): a changed item's
        // folder is found by the parent's id, asked once per folder (None: not in the drive)
        let mut dirs: HashMap<String, Option<String>> = HashMap::new();
        for raw in v["value"].as_array().into_iter().flatten() {
            let Ok(it) = serde_json::from_value::<Item>(raw.clone()) else { continue };
            if !raw["root"].is_null() {
                if let Some(id) = raw["id"].as_str() {
                    dirs.insert(id.to_string(), Some(String::new()));
                }
                continue;
            }
            let parent = it.parent_reference.as_ref().and_then(|p| p["path"].as_str()).map(str::to_string);
            let mut key = parent.and_then(|p| key_from_parent(&p, &it.name, it.is_folder()));
            if it.deleted.is_some() {
                // a removed item can't be looked up; the sync finds it by id
                changes.push(Change { key: key.unwrap_or_default(), entry: None, id: Some(it.id) });
                continue;
            }
            if key.is_none() {
                if let Some(pid) = it.parent_reference.as_ref().and_then(|p| p["id"].as_str()) {
                    let dir = match dirs.get(pid) {
                        Some(d) => d.clone(),
                        None => {
                            let d = self.folder_key(pid).await?;
                            dirs.insert(pid.to_string(), d.clone());
                            d
                        }
                    };
                    key = dir.map(|d| format!("{d}{}{}", it.name, if it.is_folder() { "/" } else { "" }));
                }
            }
            match key {
                Some(key) => {
                    if it.is_folder() {
                        dirs.insert(it.id.clone(), Some(key.clone()));
                    }
                    changes.push(Change { entry: Some(it.entry(key.clone())), key, id: Some(it.id.clone()) });
                }
                // a folder that is gone meanwhile (its removal comes in the feed too): nothing to
                // say from here, and guessing "removed" could delete a synced copy
                None => {}
            }
        }
        let (cursor, has_more) = match (v["@odata.nextLink"].as_str(), v["@odata.deltaLink"].as_str()) {
            (Some(n), _) => (n.to_string(), true),
            (None, Some(d)) => (d.to_string(), false),
            _ => return Err(unexpected(ConnKind::Onedrive, "no delta link")),
        };
        Ok(ChangeBatch { changes, cursor, has_more })
    }

    async fn quota(&self) -> SResult<Option<Quota>> {
        let url = format!("{}/me/drive?$select=quota", self.base);
        let v: Value = self.api.json(|c| c.get(&url)).await?;
        Ok(Some(Quota { used: v["quota"]["used"].as_u64().unwrap_or(0), total: v["quota"]["total"].as_u64() }))
    }
}

/// The version a write must still find there, sent as `If-Match` so Graph refuses (412) an
/// edit made between the check and the upload instead of replacing it (B3-5): an explicit
/// `IfMatch`, or `IfUnchanged` with a known eTag (checked up front too).
fn if_match_of(pre: &Precondition) -> Option<&str> {
    match pre {
        Precondition::IfMatch(t) | Precondition::IfUnchanged { etag: Some(t), .. } => Some(t),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::{
        http::client,
        mock::{Mock, Req, Resp},
        token::tests::fixed,
    };

    fn api() -> Api {
        Api { http: client(), tokens: fixed("tok"), kind: ConnKind::Onedrive, max_wait: Duration::from_millis(5) }
    }

    #[test]
    fn helpers() {
        assert_eq!(next_expected(&json!({ "nextExpectedRanges": ["12345-"] })), Some(12345));
        assert_eq!(next_expected(&json!({ "nextExpectedRanges": ["10-20", "30-"] })), Some(10));
        assert_eq!(next_expected(&json!({})), None);
        assert_eq!(key_from_parent("/drive/root:", "a.txt", false).unwrap(), "a.txt");
        assert_eq!(key_from_parent("/drive/root:/My%20Docs/x", "b", true).unwrap(), "My Docs/x/b/");
        assert_eq!(key_from_parent("/drives/abc/items/1", "b", true), None);
    }

    /// "Shared with me" over two pages; a copy whose monitor answers "303: done".
    #[tokio::test]
    async fn shared_pages_and_a_copy_monitor_redirect() {
        let base = Arc::new(Mutex::new(String::new()));
        let b2 = base.clone();
        let remote = |id: &str| json!({ "id": id, "parentReference": { "driveId": "d" }, "file": {} });
        let mock = Mock::start(move |req| {
            let base = b2.lock().unwrap().clone();
            match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/me/drive/sharedWithMe") if req.q("$skiptoken").is_none() => Resp::json(
                    200,
                    &json!({ "value": [{ "id": "s1", "name": "a.txt", "file": {}, "remoteItem": remote("r1") }], "@odata.nextLink": format!("{base}/me/drive/sharedWithMe?$skiptoken=2") }),
                ),
                ("GET", "/me/drive/sharedWithMe") => Resp::json(200, &json!({ "value": [{ "id": "s2", "name": "b.txt", "file": {}, "remoteItem": remote("r2") }] })),
                ("GET", "/me/drive/root:/a.txt:") => Resp::json(200, &json!({ "id": "1", "name": "a.txt", "file": {} })),
                ("GET", "/me/drive/root") | ("GET", "/me/drive/root:/dir:") => Resp::json(200, &json!({ "id": "D", "name": "dir", "folder": {}, "parentReference": { "driveId": "d" } })),
                ("POST", "/me/drive/root:/a.txt:/copy") => Resp::status(202).header("location", &format!("{base}/monitor")),
                ("GET", "/monitor") => Resp::status(303).header("location", &format!("{base}/drives/d/items/new")),
                _ => Resp::status(404),
            }
        })
        .await;
        *base.lock().unwrap() = mock.base.clone();
        let od = OneDrive::with_base(api(), &mock.base);
        let page = od.list(SHARED, "", None).await.unwrap();
        assert_eq!(page.objects.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), vec!["a.txt", "b.txt"]);
        let loc = |p: &str| Loc { root: ME.into(), path: p.into() };
        od.copy(&loc("a.txt"), &loc("dir/a.txt"), false).await.unwrap();
        assert!(mock.seen("/drives/d/items/new").is_empty(), "the redirect is the answer, not followed");
    }

    /// Delta answers carry no `parentReference.path`: changed items are placed by their parent's
    /// id (asked once per folder), removed ones keep their id.
    #[tokio::test]
    async fn delta_items_are_placed_by_their_parent_id() {
        let mock = Mock::start(|req| match req.path.as_str() {
            "/me/drive/root/delta" => Resp::json(200, &json!({
                "value": [
                    { "id": "R", "name": "root", "root": {}, "folder": {} },
                    { "id": "1", "name": "a.txt", "size": 1, "file": {}, "parentReference": { "id": "D" } },
                    { "id": "2", "name": "b.txt", "size": 2, "file": {}, "parentReference": { "id": "D" } },
                    { "id": "3", "name": "top.txt", "size": 3, "file": {}, "parentReference": { "id": "R" } },
                    { "id": "4", "name": "new", "folder": {}, "parentReference": { "id": "R" } },
                    { "id": "5", "name": "c.txt", "size": 3, "file": {}, "parentReference": { "id": "4" } },
                    { "id": "6", "name": "x.txt", "deleted": {}, "parentReference": { "id": "D" } }
                ],
                "@odata.deltaLink": "BASE/next"
            })),
            "/me/drive/items/D" => Resp::json(200, &json!({ "id": "D", "name": "My Docs", "parentReference": { "path": "/drive/root:/work" } })),
            _ => Resp::status(404),
        })
        .await;
        let od = OneDrive::with_base(api(), &mock.base);
        let batch = od.changes(ME, Some(format!("{}/me/drive/root/delta?token=t", mock.base))).await.unwrap();
        let got: Vec<(&str, bool, Option<&str>)> = batch.changes.iter().map(|c| (c.key.as_str(), c.entry.is_some(), c.id.as_deref())).collect();
        assert_eq!(
            got,
            vec![
                ("work/My Docs/a.txt", true, Some("1")),
                ("work/My Docs/b.txt", true, Some("2")),
                ("top.txt", true, Some("3")),
                ("new/", true, Some("4")),
                ("new/c.txt", true, Some("5")),
                ("", false, Some("6")),
            ]
        );
        assert_eq!(mock.seen("/me/drive/items/").len(), 1, "one lookup per unknown folder");
    }

    #[tokio::test]
    async fn paths_list_and_page() {
        let mock = Mock::start(|req| {
            assert_eq!(req.header("authorization"), Some("Bearer tok"));
            match req.path.as_str() {
                "/me/drive/root:/My Docs/a#1:/children" => {
                    if req.q("$skiptoken").is_some() {
                        return Resp::json(200, &json!({ "value": [{ "id": "3", "name": "z.txt", "size": 1, "file": {} }] }));
                    }
                    Resp::json(200, &json!({
                        "value": [
                            { "id": "1", "name": "sub", "folder": { "childCount": 0 } },
                            { "id": "2", "name": "x.jpg", "size": 5, "eTag": "\"e2\"", "lastModifiedDateTime": "2024-01-01T00:00:00Z",
                              "file": { "mimeType": "image/jpeg", "hashes": { "quickXorHash": "aCgDG9jwBhDc4Q1yawMZAAAAAAA=" } } },
                            { "id": "n", "name": "Notebook", "package": { "type": "oneNote" } }
                        ],
                        "@odata.nextLink": format!("{}/me/drive/root:/My%20Docs/a%231:/children?$skiptoken=abc", "BASE")
                    }))
                }
                _ => Resp::status(404),
            }
        })
        .await;
        let od = OneDrive::with_base(api(), &mock.base);
        let p = od.list(ME, "My Docs/a#1/", None).await.unwrap();
        assert_eq!(p.folders, vec!["My Docs/a#1/sub/"]);
        assert_eq!(p.objects.len(), 1, "OneNote notebooks are left out");
        let e = &p.objects[0];
        assert_eq!((e.key.as_str(), e.etag.as_deref(), e.hashes.quickxor.as_deref()), ("My Docs/a#1/x.jpg", Some("\"e2\""), Some("aCgDG9jwBhDc4Q1yawMZAAAAAAA=")));
        // a next page address that doesn't belong to this server isn't followed
        assert!(od.list(ME, "My Docs/a#1/", p.next_token).await.is_err());
        let seen = mock.seen("/me/drive/root:");
        assert!(seen[0].q("$top").is_some() || seen[0].q("%24top").is_some(), "{}", seen[0].query);
    }

    /// Graph's upload sessions: the second piece is lost once (status asked, then resent).
    #[tokio::test]
    async fn upload_sessions_go_up_in_pieces_without_the_token() {
        let got = Arc::new(Mutex::new(Vec::<u8>::new()));
        let base = Arc::new(Mutex::new(String::new()));
        let lost = Arc::new(AtomicU64::new(0));
        let (g2, b2, l2) = (got.clone(), base.clone(), lost.clone());
        let mock = Mock::start(move |req: &Req| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/me/drive/root:/docs:") => Resp::json(200, &json!({ "id": "d", "name": "docs", "folder": {} })),
            ("POST", "/me/drive/root:/docs/big.bin:/createUploadSession") => {
                assert_eq!(req.json()["item"]["@microsoft.graph.conflictBehavior"], "replace");
                Resp::json(200, &json!({ "uploadUrl": format!("{}/up/s1", b2.lock().unwrap()) }))
            }
            ("GET", "/up/s1") => {
                assert!(req.header("authorization").is_none(), "upload addresses carry their own authorization");
                Resp::json(200, &json!({ "nextExpectedRanges": [format!("{}-", g2.lock().unwrap().len())] }))
            }
            ("PUT", "/up/s1") => {
                assert!(req.header("authorization").is_none());
                let range = req.header("content-range").unwrap();
                let (span, total) = range.strip_prefix("bytes ").unwrap().split_once('/').unwrap();
                let start: usize = span.split('-').next().unwrap().parse().unwrap();
                let mut got = g2.lock().unwrap();
                assert_eq!(start, got.len());
                // the second piece "fails" with a server error once, without being kept
                if start > 0 && l2.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Resp::status(500);
                }
                got.extend_from_slice(&req.body);
                if got.len().to_string() == total {
                    return Resp::json(201, &json!({ "id": "f", "name": "big.bin", "size": got.len(), "eTag": "\"new\"", "file": {} }));
                }
                Resp::json(202, &json!({ "nextExpectedRanges": [format!("{}-", got.len())] }))
            }
            _ => Resp::status(404),
        })
        .await;
        *base.lock().unwrap() = mock.base.clone();
        let od = OneDrive::with_base(api(), &mock.base);
        let data: Vec<u8> = (0..1_000_000u32).map(|i| (i % 249) as u8).collect();
        let opts = WriteOpts { part_size: Some(QUANTUM), ..Default::default() };
        let cancel = Arc::new(AtomicBool::new(false));
        let out = od.write(ME, "docs/big.bin", WriteSource::Bytes(data.clone().into()), opts, &|_, _| {}, &cancel).await.unwrap();
        let WriteOutcome::Done(e) = out else { panic!("not done") };
        assert_eq!((e.key.as_str(), e.etag.as_deref()), ("docs/big.bin", Some("\"new\"")));
        assert_eq!(*got.lock().unwrap(), data);
        let puts = mock.seen("/up/s1").into_iter().filter(|r| r.method == "PUT").count();
        assert_eq!(puts, 1_000_000usize.div_ceil(QUANTUM as usize) + 1, "one piece sent twice");
    }

    /// B3-5 (round 4): the last piece committed but its answer was lost; the session is gone (404)
    /// and the item is there with the right size, just written: done, not "dropped". An item
    /// written long ago is not taken for it.
    #[tokio::test]
    async fn a_last_piece_whose_answer_was_lost_counts_as_done() {
        let got = Arc::new(Mutex::new(Vec::<u8>::new()));
        let base = Arc::new(Mutex::new(String::new()));
        let stale = Arc::new(AtomicU64::new(0));
        let (g2, b2, s2) = (got.clone(), base.clone(), stale.clone());
        let total = 3 * QUANTUM as usize;
        let mock = Mock::start(move |req: &Req| match (req.method.as_str(), req.path.as_str()) {
            ("POST", "/me/drive/root:/big.bin:/createUploadSession") => Resp::json(200, &json!({ "uploadUrl": format!("{}/up/s1", b2.lock().unwrap()) })),
            ("GET", "/up/s1") => {
                let n = g2.lock().unwrap().len();
                if n == total {
                    Resp::status(404)
                } else {
                    Resp::json(200, &json!({ "nextExpectedRanges": [format!("{n}-")] }))
                }
            }
            ("PUT", "/up/s1") => {
                let mut got = g2.lock().unwrap();
                got.extend_from_slice(&req.body);
                if got.len() == total {
                    return Resp::status(500); // committed, but the answer didn't make it
                }
                Resp::json(202, &json!({ "nextExpectedRanges": [format!("{}-", got.len())] }))
            }
            ("GET", "/me/drive/root:/big.bin:") => {
                let when = if s2.load(Ordering::SeqCst) == 1 { 0 } else { extras::now_ms() };
                Resp::json(200, &json!({ "id": "f", "name": "big.bin", "size": total, "eTag": "\"new\"", "file": {}, "lastModifiedDateTime": extras::format_rfc3339(when) }))
            }
            _ => Resp::status(404),
        })
        .await;
        *base.lock().unwrap() = mock.base.clone();
        let od = OneDrive::with_base(api(), &mock.base);
        let data: Vec<u8> = (0..total as u32).map(|i| (i % 247) as u8).collect();
        let cancel = Arc::new(AtomicBool::new(false));
        let opts = WriteOpts { part_size: Some(QUANTUM), ..Default::default() };
        let out = od.write(ME, "big.bin", WriteSource::Bytes(data.clone().into()), opts, &|_, _| {}, &cancel).await.unwrap();
        let WriteOutcome::Done(e) = out else { panic!("not done") };
        assert_eq!(e.etag.as_deref(), Some("\"new\""));
        assert_eq!(*got.lock().unwrap(), data, "sent once");

        got.lock().unwrap().clear();
        stale.store(1, Ordering::SeqCst);
        let opts = WriteOpts { part_size: Some(QUANTUM), ..Default::default() };
        let err = od.write(ME, "big.bin", WriteSource::Bytes(data.clone().into()), opts, &|_, _| {}, &cancel).await.err().expect("an old item isn't this upload");
        assert!(err.message.contains("dropped"), "{}", err.message);
    }

    #[tokio::test]
    async fn small_uploads_honour_if_match_and_report_conflicts() {
        let mock = Mock::start(|req| match (req.method.as_str(), req.path.as_str()) {
            ("PUT", "/me/drive/root:/a.txt:/content") => {
                if req.header("if-match") == Some("\"old\"") {
                    return Resp::json(412, &json!({ "error": { "code": "resourceModified" } }));
                }
                Resp::json(200, &json!({ "id": "a", "name": "a.txt", "size": 2, "eTag": "\"v2\"", "file": {} }))
            }
            ("GET", "/me/drive/root:/a.txt:") => Resp::json(200, &json!({ "id": "a", "name": "a.txt", "size": 9, "eTag": "\"cur\"", "file": {} })),
            _ => Resp::status(404),
        })
        .await;
        let od = OneDrive::with_base(api(), &mock.base);
        let cancel = Arc::new(AtomicBool::new(false));
        let ok = od.write(ME, "a.txt", WriteSource::Bytes("hi".into()), WriteOpts::default(), &|_, _| {}, &cancel).await.unwrap();
        assert!(matches!(ok, WriteOutcome::Done(ref e) if e.etag.as_deref() == Some("\"v2\"")));
        let opts = WriteOpts { precondition: Precondition::IfMatch("\"old\"".into()), ..Default::default() };
        let c = od.write(ME, "a.txt", WriteSource::Bytes("hi".into()), opts, &|_, _| {}, &cancel).await.unwrap();
        assert!(matches!(c, WriteOutcome::Conflict(Some(ref e)) if e.etag.as_deref() == Some("\"cur\"")));
    }

    /// B3-5: a write checked against a known eTag sends it as If-Match, so an edit made between
    /// the check and the upload comes back as a conflict instead of being replaced.
    #[tokio::test]
    async fn an_unchanged_check_is_sent_along_as_if_match() {
        let mock = Mock::start(|req| match (req.method.as_str(), req.path.as_str()) {
            // someone saved a new version after Kybl looked: Graph refuses the stale eTag
            ("PUT", "/me/drive/root:/a.txt:/content") if req.header("if-match") == Some("\"cur\"") => Resp::json(412, &json!({ "error": { "code": "resourceModified" } })),
            ("PUT", "/me/drive/root:/a.txt:/content") => Resp::json(200, &json!({ "id": "a", "name": "a.txt", "size": 2, "eTag": "\"v2\"", "file": {} })),
            ("GET", "/me/drive/root:/a.txt:") => Resp::json(200, &json!({ "id": "a", "name": "a.txt", "size": 9, "eTag": "\"cur\"", "file": {} })),
            _ => Resp::status(404),
        })
        .await;
        let od = OneDrive::with_base(api(), &mock.base);
        let cancel = Arc::new(AtomicBool::new(false));
        let opts = WriteOpts { precondition: Precondition::IfUnchanged { etag: Some("\"cur\"".into()), size: 9, modified: None }, ..Default::default() };
        let out = od.write(ME, "a.txt", WriteSource::Bytes("hi".into()), opts, &|_, _| {}, &cancel).await.unwrap();
        assert!(matches!(out, WriteOutcome::Conflict(_)), "a stale eTag is a conflict");
    }

    #[tokio::test]
    async fn short_links_are_download_addresses_long_ones_expire() {
        let mock = Mock::start(|req| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/me/drive/root:/v.mp4:") => Resp::json(200, &json!({ "id": "v", "name": "v.mp4", "@microsoft.graph.downloadUrl": "https://dl.example/v?tempauth=x" })),
            ("POST", "/me/drive/root:/v.mp4:/createLink") => {
                let v = req.json();
                assert_eq!((v["type"].as_str(), v["scope"].as_str()), (Some("view"), Some("anonymous")));
                assert!(v["expirationDateTime"].as_str().unwrap().ends_with('Z'));
                Resp::json(200, &json!({ "link": { "webUrl": "https://1drv.ms/v/abc" } }))
            }
            _ => Resp::status(404),
        })
        .await;
        let od = OneDrive::with_base(api(), &mock.base);
        let loc = Loc::new(ME, "v.mp4");
        assert_eq!(od.share_link(&loc, Some(Duration::from_secs(600))).await.unwrap(), "https://dl.example/v?tempauth=x");
        assert_eq!(od.share_link(&loc, Some(Duration::from_secs(7 * 86400))).await.unwrap(), "https://1drv.ms/v/abc");
    }
}
