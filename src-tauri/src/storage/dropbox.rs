//! Dropbox (API v2, hand-written on reqwest). One root (`""`); paths are Dropbox's own
//! ("/a/b.txt"). Files up to 150 MiB go up in one request, bigger ones (and copies of unknown
//! size) in an upload session that resumes from `ResumeState.upload_id` (the session id).
//! Writes can be conditional on the revision (`rev`, the ETag here). Deleted files stay
//! restorable on dropbox.com for a while. Share links: a temporary download link for four hours
//! or less, else a public link with an expiry (paid plans only).
//!
//! Team accounts with a team space see the member folder only (no `Dropbox-API-Path-Root` yet).

use std::{
    ops::Range,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    extras::{self, Source},
    *,
};
use crate::oauth::http::{backoff, check, provider_error, read_json, unexpected, Api};

/// Up to this size a file goes up in one request (Dropbox's limit for that is 150 MiB).
const SIMPLE_MAX: u64 = 150 * 1024 * 1024;
const DEFAULT_PIECE: u64 = 8 * 1024 * 1024;
const FAILURES: u32 = 5;
/// Temporary links last four hours.
const TEMP_LINK: Duration = Duration::from_secs(4 * 3600);

pub fn dropbox_caps() -> Capabilities {
    Capabilities {
        roots: RootsMode::Single,
        folders: FolderMode::Real,
        rename: RenameMode::Native,
        server_copy: ServerCopy::SameRoot,
        share: ShareMode::Link,
        share_expiry: true,
        // temporary links take ranges, so media can play from them directly
        streaming: StreamingMode::Presign,
        range_read: true,
        conditional_write: CondWrite::Rev,
        hashes: vec![HashKind::Dropbox],
        thumbnails: ThumbMode::LocalRemote,
        trash: true,
        changes: true,
        multipart: true,
        max_object_size: Some(350 * 1024 * 1024 * 1024),
        ..Capabilities::default()
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Meta {
    #[serde(rename = ".tag")]
    pub tag: String,
    pub name: String,
    pub path_display: Option<String>,
    pub id: Option<String>,
    pub client_modified: Option<String>,
    pub server_modified: Option<String>,
    pub rev: Option<String>,
    pub size: Option<i64>,
    pub content_hash: Option<String>,
}

impl Meta {
    pub fn is_folder(&self) -> bool {
        self.tag == "folder"
    }
    pub fn entry(&self, key: String) -> Entry {
        Entry {
            key,
            size: self.size.unwrap_or(0),
            modified: self.client_modified.as_deref().or(self.server_modified.as_deref()).and_then(extras::parse_rfc3339),
            etag: self.rev.clone(),
            storage_class: None,
            id: self.id.clone(),
            mime: None,
            hashes: Hashes { dropbox: self.content_hash.clone(), ..Default::default() },
            native: None,
        }
    }
    /// The key in Kybl's terms ("a/b.txt", folders "a/b/").
    pub fn key(&self) -> String {
        let p = self.path_display.as_deref().unwrap_or(&self.name).trim_start_matches('/');
        if self.is_folder() { format!("{p}/") } else { p.to_string() }
    }
}

/// "a/b/" → "/a/b"; "" → "" (Dropbox's name for the top).
pub fn dbx_path(key: &str) -> SResult<String> {
    let parts = extras::components(key)?;
    Ok(if parts.is_empty() { String::new() } else { format!("/{}", parts.join("/")) })
}

/// JSON for the `Dropbox-API-Arg` header, which must be ASCII: anything else as `\uXXXX`.
pub fn api_arg(v: &Value) -> String {
    let mut out = String::new();
    for c in v.to_string().chars() {
        if c.is_ascii() && c != '\u{7f}' {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for u in c.encode_utf16(&mut buf) {
                out.push_str(&format!("\\u{u:04x}"));
            }
        }
    }
    out
}

/// The `.tag` path of a Dropbox error ("path/not_found/..") and its JSON.
fn dbx_error(body: &[u8]) -> (String, Value) {
    (provider_error(body).0, serde_json::from_slice(body).unwrap_or_default())
}

pub struct Dropbox {
    api: Api,
    rpc: String,
    content: String,
    caps: Capabilities,
}

impl Dropbox {
    pub fn new(api: Api) -> Self {
        Self::with_base(api, "https://api.dropboxapi.com/2", "https://content.dropboxapi.com/2")
    }

    pub fn with_base(api: Api, rpc: impl Into<String>, content: impl Into<String>) -> Self {
        Self { api, rpc: rpc.into(), content: content.into(), caps: dropbox_caps() }
    }

    /// An RPC call; None when Dropbox answers 409 (the error is for the caller to read).
    async fn rpc(&self, route: &str, arg: &Value) -> SResult<Result<Value, (String, Value)>> {
        let url = format!("{}/{route}", self.rpc);
        let body = arg.to_string();
        let res = self.api.send(|c| c.post(&url).header("content-type", "application/json").body(body.clone())).await?;
        if res.status().as_u16() == 409 {
            let b = res.bytes().await.unwrap_or_default();
            return Ok(Err(dbx_error(&b)));
        }
        let res = check(ConnKind::Dropbox, res).await?;
        Ok(Ok(read_json(ConnKind::Dropbox, res).await?))
    }

    /// An RPC call where a 409 is an error like any other.
    async fn call(&self, route: &str, arg: &Value) -> SResult<Value> {
        match self.rpc(route, arg).await? {
            Ok(v) => Ok(v),
            Err((code, v)) => Err(crate::oauth::http::error_of(ConnKind::Dropbox, 409, v.to_string().as_bytes()).with_detail(code)),
        }
    }

    /// A content call (upload or download): the argument goes in a header.
    async fn content_call(&self, route: &str, arg: &Value, body: Bytes, range: Option<&str>) -> SResult<reqwest::Response> {
        let url = format!("{}/{route}", self.content);
        let header = api_arg(arg);
        self.api
            .send(|c| {
                let r = c.post(&url).header("dropbox-api-arg", &header);
                let r = match range {
                    Some(h) => r.header("range", h),
                    None => r,
                };
                if body.is_empty() && route.contains("download") || route.contains("thumbnail") {
                    r
                } else {
                    r.header("content-type", "application/octet-stream").body(body.clone())
                }
            })
            .await
    }

    async fn meta(&self, key: &str) -> SResult<Option<Meta>> {
        let path = dbx_path(key)?;
        if path.is_empty() {
            return Ok(Some(Meta { tag: "folder".into(), ..Default::default() }));
        }
        match self.rpc("files/get_metadata", &json!({ "path": path })).await? {
            Ok(v) => Ok(Some(serde_json::from_value(v).map_err(|e| unexpected(ConnKind::Dropbox, e))?)),
            Err((code, _)) if code.contains("not_found") => Ok(None),
            Err((code, v)) => Err(crate::oauth::http::error_of(ConnKind::Dropbox, 409, v.to_string().as_bytes()).with_detail(code)),
        }
    }

    fn commit(path: &str, opts: &WriteOpts<'_>) -> Value {
        let mode = match &opts.precondition {
            Precondition::IfMatch(rev) => json!({ ".tag": "update", "update": rev }),
            Precondition::IfUnchanged { etag: Some(rev), .. } => json!({ ".tag": "update", "update": rev }),
            Precondition::IfNoneMatch => json!("add"),
            _ => json!("overwrite"),
        };
        let mut c = json!({ "path": path, "mode": mode, "autorename": false, "mute": true });
        if let Some(ms) = opts.modified {
            c["client_modified"] = json!(extras::format_rfc3339(ms));
        }
        c
    }

    /// An upload session; Ok(None) when cancelled, Err((code, json)) inside when Dropbox refused
    /// the commit (a conflict).
    async fn session(&self, path: &str, mut src: Source, opts: &WriteOpts<'_>, progress: Progress<'_>, cancel: &AtomicBool) -> SResult<Option<Result<Meta, (String, Value)>>> {
        let total = src.len;
        let piece = opts.part_size.unwrap_or(DEFAULT_PIECE).max(1);
        let mut offset = 0u64;
        let mut session: Option<String> = opts.resume.as_ref().map(|r| r.upload_id.clone());
        let mut failures = 0u32;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            src.seek(offset).await?;
            let chunk = match src.chunk(piece as usize, cancel).await {
                Err(e) if e.is_cancelled() => return Ok(None),
                r => r?,
            };
            let end = offset + chunk.len() as u64;
            let last = match total {
                Some(t) => end >= t,
                None => (chunk.len() as u64) < piece,
            };
            let (route, arg) = match (&session, last) {
                (None, _) => ("files/upload_session/start", json!({ "close": false })),
                (Some(id), false) => ("files/upload_session/append_v2", json!({ "cursor": { "session_id": id, "offset": offset }, "close": false })),
                (Some(id), true) => ("files/upload_session/finish", json!({ "cursor": { "session_id": id, "offset": offset }, "commit": Self::commit(path, opts) })),
            };
            let res = match self.content_call(route, &arg, chunk.clone(), None).await {
                Ok(r) => r,
                Err(e) if e.kind == ErrKind::Network && failures < FAILURES => {
                    // sent again: a wrong offset answer below says where Dropbox really is
                    failures += 1;
                    tokio::time::sleep(backoff(failures)).await;
                    continue;
                }
                Err(e) => return Err(e),
            };
            let status = res.status().as_u16();
            if status == 409 {
                let b = res.bytes().await.unwrap_or_default();
                let (code, v) = dbx_error(&b);
                let correct = v["error"]["correct_offset"].as_u64().or_else(|| v["error"]["lookup_failed"]["correct_offset"].as_u64());
                match correct {
                    Some(at) if failures < FAILURES * 2 => {
                        failures += 1;
                        offset = at;
                        continue;
                    }
                    _ if code.contains("not_found") && opts.resume.is_some() && session.is_some() && offset == 0 => {
                        // the saved session expired: start a new one
                        session = None;
                        continue;
                    }
                    _ if route.ends_with("finish") => return Ok(Some(Err((code, v)))),
                    _ => return Err(crate::oauth::http::error_of(ConnKind::Dropbox, 409, &b)),
                }
            }
            let res = check(ConnKind::Dropbox, res).await?;
            let v: Value = read_json(ConnKind::Dropbox, res).await?;
            failures = 0;
            if session.is_none() {
                let id = v["session_id"].as_str().ok_or_else(|| unexpected(ConnKind::Dropbox, "no session id"))?.to_string();
                session = Some(id);
                // a file that fits in one piece still needs the finish call
            } else if route.ends_with("finish") {
                progress(end, end);
                return Ok(Some(Ok(serde_json::from_value(v).map_err(|e| unexpected(ConnKind::Dropbox, e))?)));
            }
            if let Some(f) = opts.on_part
                && !chunk.is_empty()
            {
                f(PartRecord { number: (offset / piece) as u32 + 1, size: chunk.len() as u64, etag: session.clone().unwrap_or_default() });
            }
            offset = end;
            progress(offset, total.unwrap_or(offset));
            if last && route.ends_with("start") {
                // everything went with the start call: finish with nothing more
                let id = session.clone().unwrap_or_default();
                let arg = json!({ "cursor": { "session_id": id, "offset": offset }, "commit": Self::commit(path, opts) });
                let res = self.content_call("files/upload_session/finish", &arg, Bytes::new(), None).await?;
                if res.status().as_u16() == 409 {
                    let b = res.bytes().await.unwrap_or_default();
                    return Ok(Some(Err(dbx_error(&b))));
                }
                let v: Value = read_json(ConnKind::Dropbox, check(ConnKind::Dropbox, res).await?).await?;
                progress(offset, offset);
                return Ok(Some(Ok(serde_json::from_value(v).map_err(|e| unexpected(ConnKind::Dropbox, e))?)));
            }
        }
    }

    /// Makes room for a copy or move onto `key`: a file there is deleted (restorable on
    /// dropbox.com); a folder there is an error.
    async fn clear_target(&self, key: &str, is_dir: bool) -> SResult<()> {
        if let Some(m) = self.meta(key).await? {
            if is_dir || m.is_folder() {
                return Err(StorageError::new(ErrKind::Exists, "Something with this name is already there."));
            }
            self.call("files/delete_v2", &json!({ "path": dbx_path(key)? })).await?;
        }
        Ok(())
    }

    fn page_of(v: &Value, dir: &str) -> SResult<Page> {
        let entries: Vec<Meta> = serde_json::from_value(v["entries"].clone()).map_err(|e| unexpected(ConnKind::Dropbox, e))?;
        let mut page = Page::default();
        for m in entries {
            match m.tag.as_str() {
                "folder" => page.folders.push(format!("{dir}{}/", m.name)),
                "file" => page.objects.push(m.entry(format!("{dir}{}", m.name))),
                _ => {}
            }
        }
        page.next_token = (v["has_more"].as_bool() == Some(true)).then(|| v["cursor"].as_str().unwrap_or_default().to_string());
        Ok(page)
    }
}

fn dir_key(dir: &str) -> String {
    if dir.is_empty() || dir.ends_with('/') { dir.to_string() } else { format!("{dir}/") }
}

#[async_trait]
impl Storage for Dropbox {
    fn kind(&self) -> ConnKind {
        ConnKind::Dropbox
    }

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        Ok(vec![RootInfo { id: String::new(), name: "Dropbox".into(), kind: RootKind::Folder, created: None, read_only: false }])
    }

    async fn list(&self, _root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        let dir = dir_key(dir);
        let v = match token {
            Some(cursor) => self.call("files/list_folder/continue", &json!({ "cursor": cursor })).await?,
            None => self.call("files/list_folder", &json!({ "path": dbx_path(&dir)?, "recursive": false, "include_deleted": false, "limit": 2000 })).await?,
        };
        Self::page_of(&v, &dir)
    }

    /// One recursive listing instead of a request per folder.
    fn walk<'a>(&'a self, _root: &'a str, dir: &'a str) -> BoxStream<'a, SResult<Vec<Entry>>> {
        struct St {
            cursor: Option<String>,
            started: bool,
            done: bool,
        }
        Box::pin(futures_util::stream::unfold(St { cursor: None, started: false, done: false }, move |mut st| async move {
            if st.done {
                return None;
            }
            let v = if !st.started {
                st.started = true;
                let path = match dbx_path(dir) {
                    Ok(p) => p,
                    Err(e) => {
                        st.done = true;
                        return Some((Err(e), st));
                    }
                };
                self.call("files/list_folder", &json!({ "path": path, "recursive": true, "include_deleted": false, "limit": 2000 })).await
            } else {
                self.call("files/list_folder/continue", &json!({ "cursor": st.cursor.clone().unwrap_or_default() })).await
            };
            let v = match v {
                Ok(v) => v,
                Err(e) => {
                    st.done = true;
                    return Some((Err(e), st));
                }
            };
            st.cursor = v["cursor"].as_str().map(str::to_string);
            st.done = v["has_more"].as_bool() != Some(true);
            let entries: Vec<Meta> = serde_json::from_value(v["entries"].clone()).unwrap_or_default();
            let top = dir_key(dir);
            let batch = entries
                .into_iter()
                .filter(|m| m.tag != "deleted")
                .map(|m| {
                    let k = m.key();
                    (k, m)
                })
                // the folder itself comes back too
                .filter(|(k, _)| k != &top)
                .map(|(k, m)| m.entry(k))
                .collect();
            Some((Ok(batch), st))
        }))
    }

    async fn stat(&self, _root: &str, path: &str) -> SResult<Option<Entry>> {
        let Some(m) = self.meta(path).await? else { return Ok(None) };
        if dbx_path(path)?.is_empty() {
            return Ok(Some(Entry { key: String::new(), ..Default::default() }));
        }
        if m.is_folder() != path.ends_with('/') {
            return Ok(None);
        }
        Ok(Some(m.entry(path.to_string())))
    }

    async fn read(&self, _root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        let p = dbx_path(path)?;
        if let Some(rev) = if_match {
            let m = self.meta(path).await?.ok_or_else(StorageError::not_found)?;
            if m.rev.as_deref() != Some(rev) {
                return Err(StorageError::conflict());
            }
        }
        if range.as_ref().is_some_and(|r| r.end <= r.start) {
            return Ok(ReadStream { body: Box::pin(futures_util::stream::empty()), len: Some(0), total: None, range, etag: None, content_type: None });
        }
        let header = range.as_ref().and_then(extras::range_header);
        let res = self.content_call("files/download", &json!({ "path": p }), Bytes::new(), header.as_deref()).await?;
        let status = res.status().as_u16();
        if status == 409 {
            let b = res.bytes().await.unwrap_or_default();
            return Err(crate::oauth::http::error_of(ConnKind::Dropbox, 409, &b));
        }
        // the file's metadata comes back in a header
        let meta: Option<Meta> = res.headers().get("dropbox-api-result").and_then(|v| v.to_str().ok()).and_then(|s| serde_json::from_str(s).ok());
        let etag = meta.as_ref().and_then(|m| m.rev.clone());
        if status == 416 {
            return Ok(extras::read_stream(res, range.as_ref(), etag));
        }
        let res = check(ConnKind::Dropbox, res).await?;
        let mut r = extras::read_stream(res, range.as_ref(), etag);
        if r.total.is_none() {
            r.total = meta.and_then(|m| m.size).map(|s| s as u64);
        }
        Ok(r)
    }

    async fn write(
        &self,
        _root: &str,
        path: &str,
        src: WriteSource,
        opts: WriteOpts<'_>,
        progress: Progress<'_>,
        cancel: &Arc<AtomicBool>,
    ) -> SResult<WriteOutcome> {
        let (_, name) = extras::parent_and_name(path);
        if name.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("A file needs a name."));
        }
        let p = dbx_path(path)?;
        // size and time: checked by reading first (a revision, when known, is checked by Dropbox)
        if let Precondition::IfUnchanged { etag: None, size, modified } = &opts.precondition {
            let now = self.meta(path).await?;
            let same = now.as_ref().is_some_and(|m| {
                let e = m.entry(path.to_string());
                e.size == *size && e.modified == *modified
            });
            if !same {
                return Ok(WriteOutcome::Conflict(now.map(|m| m.entry(path.to_string()))));
            }
        }
        let mut source = Source::open(src).await?;
        let total = source.len;
        progress(0, total.unwrap_or(0));
        let refused = match total {
            Some(n) if n <= SIMPLE_MAX.min(opts.part_size.unwrap_or(SIMPLE_MAX).max(1)) && opts.resume.is_none() => {
                let bytes = match source.rest(SIMPLE_MAX, cancel).await {
                    Err(e) if e.is_cancelled() => return Ok(WriteOutcome::Cancelled),
                    r => r?,
                };
                let res = self.content_call("files/upload", &Self::commit(&p, &opts), bytes, None).await?;
                if res.status().as_u16() == 409 {
                    let b = res.bytes().await.unwrap_or_default();
                    Some(dbx_error(&b))
                } else {
                    let m: Meta = read_json(ConnKind::Dropbox, check(ConnKind::Dropbox, res).await?).await?;
                    progress(n, n);
                    return Ok(WriteOutcome::Done(m.entry(path.to_string())));
                }
            }
            _ => match self.session(&p, source, &opts, progress, cancel).await? {
                None => return Ok(WriteOutcome::Cancelled),
                Some(Ok(m)) => return Ok(WriteOutcome::Done(m.entry(path.to_string()))),
                Some(Err(e)) => Some(e),
            },
        };
        let (code, v) = refused.unwrap_or_default();
        if code.contains("conflict") {
            return Ok(WriteOutcome::Conflict(self.meta(path).await?.map(|m| m.entry(path.to_string()))));
        }
        Err(crate::oauth::http::error_of(ConnKind::Dropbox, 409, v.to_string().as_bytes()))
    }

    async fn mkdir(&self, _root: &str, dir: &str) -> SResult<()> {
        let p = dbx_path(dir)?;
        if p.is_empty() {
            return Ok(());
        }
        match self.rpc("files/create_folder_v2", &json!({ "path": p, "autorename": false })).await? {
            Ok(_) => Ok(()),
            // already there (parents are made as needed)
            Err((code, _)) if code.contains("conflict/folder") => Ok(()),
            Err((code, v)) => Err(crate::oauth::http::error_of(ConnKind::Dropbox, 409, v.to_string().as_bytes()).with_detail(code)),
        }
    }

    async fn delete(
        &self,
        _root: &str,
        files: &[String],
        dirs: &[String],
        cancel: &AtomicBool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> SResult<(u64, u64)> {
        let total = (files.len() + dirs.len()) as u64;
        on_progress(0, total);
        let paths: Vec<String> = files.iter().chain(dirs.iter()).map(|k| dbx_path(k)).collect::<SResult<_>>()?;
        if paths.iter().any(String::is_empty) {
            return Err(StorageError::other("The top of your Dropbox can't be deleted."));
        }
        let counter = AtomicU64::new(0);
        let done = &counter;
        {
            // Dropbox takes few writes at once
            let mut work = futures_util::stream::iter(paths.into_iter().map(|p: String| async move {
                if cancel.load(Ordering::Relaxed) {
                    return Err(StorageError::cancelled());
                }
                match self.rpc("files/delete_v2", &json!({ "path": p })).await? {
                    Ok(_) => {}
                    Err((code, _)) if code.contains("not_found") => {}
                    Err((code, v)) => return Err(crate::oauth::http::error_of(ConnKind::Dropbox, 409, v.to_string().as_bytes()).with_detail(code)),
                }
                on_progress(done.fetch_add(1, Ordering::Relaxed) + 1, total);
                Ok(())
            }))
            .buffer_unordered(3);
            while let Some(r) = work.next().await {
                r?;
            }
        }
        Ok((counter.into_inner(), total))
    }

    async fn copy(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        self.clear_target(&to.path, is_dir).await?;
        self.call("files/copy_v2", &json!({ "from_path": dbx_path(&from.path)?, "to_path": dbx_path(&to.path)?, "autorename": false })).await.map(|_| ())
    }

    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        let (src, dst) = (dbx_path(&from.path)?, dbx_path(&to.path)?);
        if src.is_empty() {
            return Err(StorageError::other("The top of your Dropbox can't be moved."));
        }
        if src == dst {
            return Err(StorageError::other("Source and destination are the same"));
        }
        if is_dir && dst.starts_with(&format!("{src}/")) {
            return Err(StorageError::other("Cannot move a folder into itself"));
        }
        // a change of case only ("a.txt" → "A.txt") is the same file to Dropbox: no clearing
        if src.to_lowercase() != dst.to_lowercase() {
            self.clear_target(&to.path, is_dir).await?;
        }
        self.call("files/move_v2", &json!({ "from_path": src, "to_path": dst, "autorename": false, "allow_ownership_transfer": false })).await.map(|_| ())
    }

    async fn share_link(&self, loc: &Loc, ttl: Option<Duration>) -> SResult<String> {
        let p = dbx_path(&loc.path)?;
        if ttl.is_some_and(|t| t <= TEMP_LINK) {
            let v = self.call("files/get_temporary_link", &json!({ "path": p })).await?;
            return v["link"].as_str().map(str::to_string).ok_or_else(|| unexpected(ConnKind::Dropbox, "no link"));
        }
        let mut settings = json!({ "requested_visibility": "public", "audience": "public", "access": "viewer" });
        if let Some(t) = ttl {
            settings["expires"] = json!(extras::format_rfc3339(extras::now_ms() + t.as_millis() as i64));
        }
        let no_expiry = || StorageError::new(ErrKind::Unsupported, "Your Dropbox plan doesn't allow links that expire. Pick four hours or less.");
        match self.rpc("sharing/create_shared_link_with_settings", &json!({ "path": p, "settings": settings })).await? {
            Ok(v) => v["url"].as_str().map(str::to_string).ok_or_else(|| unexpected(ConnKind::Dropbox, "no link")),
            Err((code, v)) if code.contains("shared_link_already_exists") => {
                // there is a link already: give it this expiry
                let url = v["error"]["shared_link_already_exists"]["metadata"]["url"].as_str().map(str::to_string);
                let url = match url {
                    Some(u) => u,
                    None => {
                        let l = self.call("sharing/list_shared_links", &json!({ "path": p, "direct_only": true })).await?;
                        l["links"][0]["url"].as_str().map(str::to_string).ok_or_else(|| unexpected(ConnKind::Dropbox, "no link"))?
                    }
                };
                if ttl.is_none() {
                    return Ok(url);
                }
                match self.rpc("sharing/modify_shared_link_settings", &json!({ "url": url, "settings": settings })).await? {
                    Ok(v) => Ok(v["url"].as_str().map(str::to_string).unwrap_or(url)),
                    Err((code, _)) if code.contains("settings_error") || code.contains("not_authorized") => Err(no_expiry()),
                    Err((code, v)) => Err(crate::oauth::http::error_of(ConnKind::Dropbox, 409, v.to_string().as_bytes()).with_detail(code)),
                }
            }
            Err((code, _)) if code.contains("settings_error") || code.contains("not_authorized") => Err(no_expiry()),
            Err((code, v)) => Err(crate::oauth::http::error_of(ConnKind::Dropbox, 409, v.to_string().as_bytes()).with_detail(code)),
        }
    }

    async fn thumbnail(&self, loc: &Loc, _e: &Entry) -> SResult<Option<Bytes>> {
        let arg = json!({ "resource": { ".tag": "path", "path": dbx_path(&loc.path)? }, "format": "jpeg", "size": "w256h256", "mode": "bestfit" });
        let res = self.content_call("files/get_thumbnail_v2", &arg, Bytes::new(), None).await?;
        if !res.status().is_success() {
            return Ok(None);
        }
        Ok(Some(res.bytes().await.map_err(|e| crate::oauth::http::net_error(ConnKind::Dropbox, &e))?))
    }

    async fn changes(&self, _root: &str, cursor: Option<String>) -> SResult<ChangeBatch> {
        let Some(cursor) = cursor else {
            let v = self.call("files/list_folder/get_latest_cursor", &json!({ "path": "", "recursive": true, "include_deleted": true })).await?;
            return Ok(ChangeBatch { changes: vec![], cursor: v["cursor"].as_str().unwrap_or_default().to_string(), has_more: false });
        };
        let v = self.call("files/list_folder/continue", &json!({ "cursor": cursor })).await?;
        let entries: Vec<Meta> = serde_json::from_value(v["entries"].clone()).unwrap_or_default();
        let changes = entries
            .into_iter()
            .map(|m| {
                let key = m.key();
                match m.tag.as_str() {
                    "deleted" => Change { key, entry: None, id: None },
                    _ => Change { entry: Some(m.entry(key.clone())), key, id: m.id.clone() },
                }
            })
            .collect();
        Ok(ChangeBatch { changes, cursor: v["cursor"].as_str().unwrap_or(&cursor).to_string(), has_more: v["has_more"].as_bool() == Some(true) })
    }

    async fn quota(&self) -> SResult<Option<Quota>> {
        let v = self.call("users/get_space_usage", &Value::Null).await?;
        let a = &v["allocation"];
        Ok(Some(Quota { used: v["used"].as_u64().unwrap_or(0), total: a["allocated"].as_u64() }))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::oauth::{
        http::client,
        mock::{Mock, Req, Resp},
        token::tests::fixed,
    };

    fn api() -> Api {
        Api { http: client(), tokens: fixed("tok"), kind: ConnKind::Dropbox, max_wait: Duration::from_millis(5) }
    }

    #[test]
    fn paths_and_header_arguments() {
        assert_eq!(dbx_path("").unwrap(), "");
        assert_eq!(dbx_path("a/b/").unwrap(), "/a/b");
        assert_eq!(dbx_path("a/b.txt").unwrap(), "/a/b.txt");
        let v = json!({ "path": "/Ünï 😀" });
        let h = api_arg(&v);
        assert!(h.is_ascii(), "{h}");
        assert!(h.contains("u00dc") && h.contains("ud83d"), "{h}");
        assert_eq!(serde_json::from_str::<Value>(&h).unwrap(), v, "the same JSON, escaped");
        let m: Meta = serde_json::from_value(json!({ ".tag": "folder", "name": "B", "path_display": "/a/B" })).unwrap();
        assert_eq!(m.key(), "a/B/");
    }

    fn arg(req: &Req) -> Value {
        serde_json::from_str(req.header("dropbox-api-arg").unwrap_or("null")).unwrap()
    }

    #[tokio::test]
    async fn lists_page_with_cursors_and_reads_ranges() {
        let mock = Mock::start(|req| match req.path.as_str() {
            "/rpc/files/list_folder" => {
                assert_eq!(req.json()["path"], "/Photos");
                Resp::json(200, &json!({ "entries": [
                    { ".tag": "folder", "name": "2024", "path_display": "/Photos/2024", "id": "id:f" },
                    { ".tag": "file", "name": "a.jpg", "path_display": "/Photos/a.jpg", "id": "id:a", "rev": "r1", "size": 10,
                      "client_modified": "2024-01-01T00:00:00Z", "server_modified": "2024-02-01T00:00:00Z", "content_hash": "h" }
                ], "cursor": "C1", "has_more": true }))
            }
            "/rpc/files/list_folder/continue" => {
                assert_eq!(req.json()["cursor"], "C1");
                Resp::json(200, &json!({ "entries": [{ ".tag": "file", "name": "b.jpg", "path_display": "/Photos/b.jpg", "rev": "r2", "size": 3 }], "cursor": "C2", "has_more": false }))
            }
            "/content/files/download" => {
                assert_eq!(arg(req)["path"], "/Photos/a.jpg");
                assert_eq!(req.header("range"), Some("bytes=2-5"));
                Resp::bytes(206, b"cdef".to_vec())
                    .header("content-range", "bytes 2-5/10")
                    .header("dropbox-api-result", r#"{".tag":"file","name":"a.jpg","rev":"r1","size":10}"#)
            }
            _ => Resp::status(404),
        })
        .await;
        let d = Dropbox::with_base(api(), format!("{}/rpc", mock.base), format!("{}/content", mock.base));
        let p = d.list("", "Photos/", None).await.unwrap();
        assert_eq!(p.folders, vec!["Photos/2024/"]);
        let a = &p.objects[0];
        assert_eq!((a.etag.as_deref(), a.hashes.dropbox.as_deref()), (Some("r1"), Some("h")));
        assert_eq!(a.modified, extras::parse_rfc3339("2024-01-01T00:00:00Z"), "the file's own time, as uploaded");
        let p2 = d.list("", "Photos/", p.next_token).await.unwrap();
        assert_eq!(p2.objects[0].key, "Photos/b.jpg");
        assert_eq!(p2.next_token, None);
        let r = d.read("", "Photos/a.jpg", Some(2..6), None).await.unwrap();
        assert_eq!((r.range.clone(), r.total, r.etag.clone()), (Some(2..6), Some(10), Some("r1".into())));
        assert_eq!(r.collect(100).await.unwrap(), b"cdef");
    }

    #[tokio::test]
    async fn sessions_follow_the_offset_dropbox_reports_and_revisions_guard_writes() {
        let got = Arc::new(Mutex::new(Vec::<u8>::new()));
        let skewed = Arc::new(AtomicU64::new(0));
        let (g2, s2) = (got.clone(), skewed.clone());
        let mock = Mock::start(move |req| {
            let a = arg(req);
            let mut got = g2.lock().unwrap();
            match req.path.as_str() {
                "/content/files/upload_session/start" => {
                    got.extend_from_slice(&req.body);
                    Resp::json(200, &json!({ "session_id": "S" }))
                }
                "/content/files/upload_session/append_v2" | "/content/files/upload_session/finish" => {
                    let off = a["cursor"]["offset"].as_u64().unwrap() as usize;
                    // once, pretend an earlier piece was lost: Dropbox says where it really is
                    if off == 2 * 1024 && s2.fetch_add(1, Ordering::SeqCst) == 0 {
                        got.truncate(1024);
                        return Resp::json(409, &json!({ "error_summary": "incorrect_offset/..", "error": { ".tag": "incorrect_offset", "correct_offset": 1024 } }));
                    }
                    assert_eq!(off, got.len());
                    got.extend_from_slice(&req.body);
                    if req.path.ends_with("finish") {
                        let c = &a["commit"];
                        assert_eq!(c["path"], "/big.bin");
                        if c["mode"][".tag"] == "update" && c["mode"]["update"] != "cur" {
                            return Resp::json(409, &json!({ "error_summary": "path/conflict/file/..", "error": { ".tag": "path" } }));
                        }
                        return Resp::json(200, &json!({ ".tag": "file", "name": "big.bin", "path_display": "/big.bin", "rev": "new", "size": got.len() }));
                    }
                    Resp::json(200, &Value::Null)
                }
                "/rpc/files/get_metadata" => Resp::json(200, &json!({ ".tag": "file", "name": "big.bin", "rev": "cur", "size": 1 })),
                _ => Resp::status(404),
            }
        })
        .await;
        let d = Dropbox::with_base(api(), format!("{}/rpc", mock.base), format!("{}/content", mock.base));
        let data: Vec<u8> = (0..5000u32).map(|i| (i % 241) as u8).collect();
        let cancel = Arc::new(AtomicBool::new(false));
        let opts = WriteOpts { part_size: Some(1024), ..Default::default() };
        let out = d.write("", "big.bin", WriteSource::Bytes(data.clone().into()), opts, &|_, _| {}, &cancel).await.unwrap();
        let WriteOutcome::Done(e) = out else { panic!("not done") };
        assert_eq!(e.etag.as_deref(), Some("new"));
        assert_eq!(*got.lock().unwrap(), data, "resent from where Dropbox was");

        // a stale revision: Dropbox refuses, Kybl reports a conflict with what is there now
        got.lock().unwrap().clear();
        let opts = WriteOpts { part_size: Some(1024), precondition: Precondition::IfMatch("old".into()), ..Default::default() };
        let out = d.write("", "big.bin", WriteSource::Bytes(data.clone().into()), opts, &|_, _| {}, &cancel).await.unwrap();
        assert!(matches!(out, WriteOutcome::Conflict(Some(ref e)) if e.etag.as_deref() == Some("cur")));
    }

    #[tokio::test]
    async fn links_rate_limits_and_quota() {
        let calls = Arc::new(AtomicU64::new(0));
        let c2 = calls.clone();
        let mock = Mock::start(move |req| match req.path.as_str() {
            "/rpc/files/get_temporary_link" => {
                if c2.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Resp::json(429, &json!({ "error_summary": "too_many_requests/.." })).header("retry-after", "0");
                }
                Resp::json(200, &json!({ "link": "https://dl.dropboxusercontent.com/x" }))
            }
            "/rpc/sharing/create_shared_link_with_settings" => {
                Resp::json(409, &json!({ "error_summary": "settings_error/not_authorized/..", "error": { ".tag": "settings_error" } }))
            }
            "/rpc/users/get_space_usage" => Resp::json(200, &json!({ "used": 5, "allocation": { ".tag": "individual", "allocated": 100 } })),
            _ => Resp::status(404),
        })
        .await;
        let d = Dropbox::with_base(api(), format!("{}/rpc", mock.base), format!("{}/content", mock.base));
        let loc = Loc::new("", "a.mp4");
        assert_eq!(d.share_link(&loc, Some(Duration::from_secs(3600))).await.unwrap(), "https://dl.dropboxusercontent.com/x");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "waited and tried again after 429");
        let e = d.share_link(&loc, Some(Duration::from_secs(86400 * 7))).await.unwrap_err();
        assert!(e.message.contains("plan"), "{}", e.message);
        let q = d.quota().await.unwrap().unwrap();
        assert_eq!((q.used, q.total), (5, Some(100)));
    }
}
