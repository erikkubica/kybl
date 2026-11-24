//! "Edit" for a connection's files in another app, FileZilla-style but safer.
//!
//! `edit_start` downloads the file into a private folder of its own
//! (`<app cache>/edit/<this run>/<connection>/<session>/<name>`), the page opens that copy in the app the
//! person picked, and a watcher on the session's folder notices every save: in place, or the
//! "write a temp file and rename it over" way most editors save. A burst of events is settled
//! for [`DEBOUNCE`] first, and the file's MD5 is compared with the bytes the server is known to
//! have, so touches, editors that save without changes and our own "reload" write upload nothing.
//!
//! Each save then goes up under the rule the person picked when they opened it:
//! - [`Rule::Auto`]: overwrite whatever is there.
//! - [`Rule::IfUnchanged`]: only if the server still has the version this copy was made from
//!   (or last uploaded). That goes through `doc::save_bytes`, the editor's own ⌘S path, which
//!   always stats the file and compares first, and only adds `If-Match` where the provider
//!   honours it (not on Hetzner). A changed file holds the session in [`Phase::Conflict`] until
//!   the person picks Overwrite, Keep both or Reload ([`edit_resolve`]).
//!
//! After every upload the recorded identity becomes what was uploaded, so the next save compares
//! against that. Nothing runs while nothing is being edited: no watcher, no task. Stopping a
//! session deletes its folder; quitting stops them all, and the next start removes whatever an
//! earlier run left behind (killed, crashed).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex, Weak,
    },
    time::Duration,
};

use md5::{Digest, Md5};
use notify_debouncer_full::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer, RecommendedCache,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::Notify;

use crate::doc::{self, DocMeta, Precondition};
use crate::state::AppState;

/// Largest file edited this way: it is read whole to upload, like the editor's saves.
pub const MAX_BYTES: u64 = 100 * 1000 * 1000;
/// How long a burst of file events must settle before the file is looked at.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// The folder under the app's cache folder.
const DIR: &str = "edit";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Rule {
    /// "Upload changes automatically"
    Auto,
    /// "Upload only if the file on the server hasn't changed since you opened it"
    IfUnchanged,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// open, nothing to upload
    Watching,
    Uploading,
    /// the last save is on the server
    Uploaded,
    /// the server's copy changed (or went away): waiting for the person
    Conflict,
    /// the last upload failed; the next save (or Retry) tries again
    Error,
}

/// One file being edited, as the page shows it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditInfo {
    pub id: String,
    pub profile_id: String,
    pub root: String,
    /// where saves go (a "Keep both" moves it to the "(edited)" copy)
    pub key: String,
    pub name: String,
    /// the copy on this computer
    pub local: String,
    pub rule: Rule,
    pub phase: Phase,
    pub error: Option<String>,
    /// in a conflict: what the server has now (`None` there means it was deleted)
    pub server: Option<DocMeta>,
    /// milliseconds since 1970
    pub last_upload: Option<i64>,
    /// a fresh id per upload attempt, so the page can show each one as a transfer
    pub upload_id: Option<String>,
    /// bytes of the last upload attempt
    pub upload_size: u64,
    /// the copy here has changes the server doesn't have yet
    pub pending: bool,
}

struct Inner {
    info: EditInfo,
    /// the server's version as far as we know: from the download, or our last upload
    known: DocMeta,
    /// MD5 of the bytes that `known` describes
    synced: [u8; 16],
}

struct Session {
    inner: Mutex<Inner>,
    /// held for a whole look-and-upload (the worker's, or an answer to a conflict), so two
    /// uploads of one session never run at once
    busy: tokio::sync::Mutex<()>,
    wake: Notify,
    stop: AtomicBool,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
    /// the session's own folder (deleted on stop)
    dir: PathBuf,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(Default::default);

// ---------------------------------------------------------------- pure decisions (tested)

/// What a settled change to the local copy leads to.
#[derive(Debug, PartialEq)]
pub(crate) enum Next {
    /// the bytes are what the server already has
    Skip,
    /// a conflict is waiting for an answer: keep the change here
    Hold,
    Upload(Precondition),
}

pub(crate) fn decide(rule: Rule, phase: Phase, synced: &[u8; 16], now: &[u8; 16], known: &DocMeta) -> Next {
    if synced == now {
        return Next::Skip;
    }
    if phase == Phase::Conflict {
        return Next::Hold;
    }
    match rule {
        Rule::Auto => Next::Upload(Precondition::Any),
        Rule::IfUnchanged => Next::Upload(Precondition::matching(known)),
    }
}

/// How an upload attempt ended.
#[derive(Debug, PartialEq)]
pub(crate) enum Outcome {
    Uploaded(DocMeta),
    /// the server's copy changed; `None` when it is gone
    Conflict(Option<DocMeta>),
    Failed(String),
}

pub(crate) fn outcome(r: Result<DocMeta, String>) -> Outcome {
    match r {
        Ok(m) => Outcome::Uploaded(m),
        Err(e) => match doc::parse_conflict(&e) {
            Some(now) => Outcome::Conflict(now),
            None => Outcome::Failed(e),
        },
    }
}

/// "notes.md" → "notes (edited).md", "notes (edited 2).md", …
pub(crate) fn edited_key(key: &str, n: u32) -> String {
    let slash = key.rfind('/').map(|i| i + 1).unwrap_or(0);
    let name = &key[slash..];
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let tag = if n > 1 { format!("edited {n}") } else { "edited".into() };
    format!("{}{stem} ({tag}){ext}", &key[..slash])
}

/// Longest segment `safe_segment` makes, in characters.
const SEGMENT_MAX: usize = 120;
/// ... and in UTF-8 bytes: ext4, btrfs and xfs allow 255 bytes per name (85 CJK characters).
const SEGMENT_MAX_BYTES: usize = 240;

/// A name that is safe as one path segment on every OS. A long one is shortened in the middle, so
/// it keeps its extension: the app that opens it (and the open guard, which checks this name) sees
/// the same type as the remote name has (`AAAA….exe.txt` stays a `.txt`).
pub(crate) fn safe_segment(s: &str, fallback: &str) -> String {
    safe_segment_for(s, fallback, cfg!(windows))
}

/// [`safe_segment`], with Windows' device names (CON, NUL, COM1, `aux.txt`…) given a `_` in front
/// when `windows`: there they open the device, not a file.
fn safe_segment_for(s: &str, fallback: &str, windows: bool) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let name = if trimmed.chars().count() <= SEGMENT_MAX && trimmed.len() <= SEGMENT_MAX_BYTES {
        trimmed.to_string()
    } else {
        // the extension (when it has a short one) stays; the stem gives way, whole characters only
        let ext = trimmed.rfind('.').filter(|&i| i > 0).map(|i| &trimmed[i..]).filter(|e| e.chars().count() <= 24).unwrap_or("");
        let (max_chars, max_bytes) = (SEGMENT_MAX - ext.chars().count(), SEGMENT_MAX_BYTES - ext.len());
        let mut stem = String::new();
        for c in trimmed[..trimmed.len() - ext.len()].chars().take(max_chars) {
            if stem.len() + c.len_utf8() > max_bytes {
                break;
            }
            stem.push(c);
        }
        let stem = stem.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
        if stem.is_empty() && ext.is_empty() {
            return fallback.to_string();
        }
        format!("{stem}{ext}")
    };
    if windows && crate::dest::windows_unfit(&name) {
        return format!("_{name}");
    }
    name
}

fn base_name(key: &str) -> String {
    key.trim_end_matches('/').rsplit('/').next().unwrap_or(key).to_string()
}

fn md5(bytes: &[u8]) -> [u8; 16] {
    Md5::digest(bytes).into()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- folders

/// `<app cache>/edit`: each running Kybl works in a folder of its own below it (see
/// `instance_dir`), so a second copy of the app starting up never deletes the first one's copies.
fn edit_base<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(DIR))
}

fn edit_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    crate::instance_dir::claim(&edit_base(app)?).map_err(|e| format!("Couldn't make a private folder for the copy: {e}"))
}

/// Creates `<root>/<connection>/<session>/` (only this user can look inside) and returns the
/// path the file goes to.
pub(crate) fn make_session_dir(root: &Path, profile_id: &str, session: &str, name: &str) -> std::io::Result<PathBuf> {
    let dir = root.join(safe_segment(profile_id, "connection")).join(session);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir.join(safe_segment(name, "file")))
}

/// Removes a session's folder, and its connection's folder once that is empty.
pub(crate) fn remove_session_dir(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
    if let Some(parent) = dir.parent() {
        // fails (and stays) while other sessions of the connection still have folders there
        let _ = std::fs::remove_dir(parent);
    }
}

#[cfg(test)]
fn sweep(root: &Path) {
    let _ = std::fs::remove_dir_all(root);
}

// ---------------------------------------------------------------- sessions

fn emit<R: Runtime>(app: &AppHandle<R>, id: &str, info: Option<EditInfo>) {
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Event {
        id: String,
        /// None: the session ended
        session: Option<EditInfo>,
    }
    let _ = app.emit("edit", Event { id: id.to_string(), session: info });
}

fn snapshot(s: &Session) -> EditInfo {
    s.inner.lock().unwrap().info.clone()
}

/// Changes the session and tells the page, unless the session was stopped meanwhile (an upload
/// that ends after the person stopped editing must not bring its row back).
fn update<R: Runtime>(app: &AppHandle<R>, s: &Session, f: impl FnOnce(&mut Inner)) -> EditInfo {
    let (info, live) = {
        let mut i = s.inner.lock().unwrap();
        let live = !s.stop.load(Ordering::SeqCst);
        if live {
            f(&mut i);
        }
        (i.info.clone(), live)
    };
    if live {
        emit(app, &info.id, Some(info.clone()));
    }
    info
}

fn find(id: &str) -> Result<Arc<Session>, String> {
    SESSIONS.lock().unwrap().get(id).cloned().ok_or_else(|| "That file isn't being edited any more.".to_string())
}

/// Sessions with changes the server doesn't have yet (asked about before quitting).
pub fn unsynced() -> usize {
    SESSIONS.lock().unwrap().values().filter(|s| s.inner.lock().unwrap().info.pending).count()
}

fn watch(s: &Arc<Session>) -> Result<Debouncer<RecommendedWatcher, RecommendedCache>, String> {
    let weak: Weak<Session> = Arc::downgrade(s);
    let mut d = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
        let Some(s) = weak.upgrade() else { return };
        let relevant = match &res {
            Ok(events) => events.iter().any(|e| !e.kind.is_access()),
            // the watcher lost track: look at the file anyway
            Err(_) => true,
        };
        if relevant {
            s.wake.notify_one();
        }
    })
    .map_err(|e| format!("Couldn't watch the file for changes: {e}"))?;
    d.watch(&s.dir, RecursiveMode::NonRecursive).map_err(|e| format!("Couldn't watch the file for changes: {e}"))?;
    Ok(d)
}

/// The session's worker: one look at the file per settled burst of changes, one upload at a time.
/// Changes during an upload leave a permit in `wake`, so they are looked at right after.
async fn run(app: AppHandle, s: Arc<Session>) {
    loop {
        s.wake.notified().await;
        if s.stop.load(Ordering::SeqCst) {
            break;
        }
        changed(&app, &s).await;
    }
}

/// Reads the copy, retrying briefly while an editor's atomic replace has it missing. At most
/// `MAX_BYTES + 1` bytes: a longer file is reported as too large without being read whole.
async fn read_settled(path: &Path) -> Option<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    for _ in 0..3 {
        if let Ok(f) = tokio::fs::File::open(path).await {
            let mut b = Vec::new();
            if f.take(MAX_BYTES + 1).read_to_end(&mut b).await.is_ok() {
                return Some(b);
            }
        }
        tokio::time::sleep(DEBOUNCE).await;
    }
    None
}

async fn changed(app: &AppHandle, s: &Arc<Session>) {
    // an answer to a conflict may be uploading: wait for it, then look at the file as it is now
    let _busy = s.busy.lock().await;
    if s.stop.load(Ordering::SeqCst) {
        return;
    }
    let local = PathBuf::from(snapshot(s).local);
    let Some(bytes) = read_settled(&local).await else { return };
    if s.stop.load(Ordering::SeqCst) {
        return;
    }
    if bytes.len() as u64 > MAX_BYTES {
        update(app, s, |i| {
            i.info.phase = Phase::Error;
            i.info.pending = true;
            i.info.error = Some("The file got too large to upload this way (over 100 MB). Upload it yourself instead.".into());
        });
        return;
    }
    let hash = md5(&bytes);
    let next = {
        let i = s.inner.lock().unwrap();
        decide(i.info.rule, i.info.phase, &i.synced, &hash, &i.known)
    };
    match next {
        Next::Skip => {
            // back to what the server has (an undo, say): nothing waits any more
            let pending = s.inner.lock().unwrap().info.pending;
            if pending {
                update(app, s, |i| {
                    i.info.pending = false;
                    if i.info.phase == Phase::Error {
                        i.info.phase = Phase::Watching;
                        i.info.error = None;
                    }
                });
            }
        }
        Next::Hold => {
            update(app, s, |i| i.info.pending = true);
        }
        Next::Upload(expect) => upload(app, s, None, bytes, hash, expect).await,
    }
}

/// One upload attempt to the session's key (or `to`), and what it leaves the session at.
async fn upload(app: &AppHandle, s: &Arc<Session>, to: Option<String>, bytes: Vec<u8>, hash: [u8; 16], expect: Precondition) {
    let size = bytes.len() as u64;
    let info = update(app, s, |i| {
        i.info.phase = Phase::Uploading;
        i.info.pending = true;
        i.info.error = None;
        i.info.upload_id = Some(uuid::Uuid::new_v4().to_string());
        i.info.upload_size = size;
    });
    let key = to.clone().unwrap_or_else(|| info.key.clone());
    let state = app.state::<AppState>();
    let result = doc::save_bytes(app, &state, info.profile_id.clone(), info.root.clone(), key.clone(), bytes, &expect).await;
    settle(app, s, outcome(result), hash, to);
}

fn settle<R: Runtime>(app: &AppHandle<R>, s: &Session, out: Outcome, hash: [u8; 16], to: Option<String>) {
    update(app, s, |i| match out {
        Outcome::Uploaded(meta) => {
            if let Some(k) = to {
                i.info.name = base_name(&k);
                i.info.key = k;
            }
            i.known = meta;
            i.synced = hash;
            i.info.phase = Phase::Uploaded;
            i.info.pending = false;
            i.info.server = None;
            i.info.error = None;
            i.info.last_upload = Some(now_ms());
        }
        Outcome::Conflict(now) => {
            i.info.phase = Phase::Conflict;
            i.info.pending = true;
            i.info.server = now;
            i.info.error = None;
        }
        Outcome::Failed(e) => {
            i.info.phase = Phase::Error;
            i.info.pending = true;
            i.info.error = Some(e);
        }
    });
}

fn end<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<PathBuf> {
    let s = SESSIONS.lock().unwrap().remove(id)?;
    {
        // under the session's lock: an `update` running now is either sent before the "ended"
        // below, or sees the stop and leaves the page alone
        let _i = s.inner.lock().unwrap();
        s.stop.store(true, Ordering::SeqCst);
    }
    s.watcher.lock().unwrap().take();
    s.wake.notify_one();
    emit(app, id, None);
    Some(s.dir.clone())
}

// ---------------------------------------------------------------- commands

/// Downloads a file to its own private folder and starts watching it. The page opens
/// `local` in the app the person picked. A file already being edited gives its session back
/// (with the newly picked rule), so opening it again shows the same copy.
#[tauri::command]
pub async fn edit_start(app: AppHandle, state: State<'_, AppState>, profile_id: String, root: String, path: String, rule: Rule) -> Result<EditInfo, String> {
    let (p, r, k) = (profile_id.clone(), root.clone(), path.clone());
    let same = move |s: &Arc<Session>| {
        let i = &s.inner.lock().unwrap().info;
        i.profile_id == p && i.root == r && i.key == k
    };
    let existing = SESSIONS.lock().unwrap().values().find(|s| same(s)).cloned();
    if let Some(s) = existing {
        return Ok(update(&app, &s, |i| i.info.rule = rule));
    }

    let (meta, bytes) = doc::open_bytes(&app, &state, profile_id.clone(), root.clone(), path.clone(), MAX_BYTES)
        .await
        .map_err(|e| if e.contains("too large") { "Files up to 100 MB can be edited this way. Download it to edit it instead.".to_string() } else { e })?;
    let id = uuid::Uuid::new_v4().to_string();
    let name = base_name(&path);
    let edit_dir = edit_root(&app)?;
    let local = {
        let (r, p, i, n) = (edit_dir.clone(), profile_id.clone(), id.clone(), name.clone());
        tokio::task::spawn_blocking(move || make_session_dir(&r, &p, &i, &n))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Couldn't make a private folder for the copy: {e}"))?
    };
    let dir = local.parent().map(Path::to_path_buf).unwrap_or_default();
    if let Err(e) = tokio::fs::write(&local, &bytes).await {
        remove_session_dir(&dir);
        return Err(format!("Couldn't save the copy to edit: {e}"));
    }
    // a file from a connection: the system checks it before it runs, as with a download
    crate::platform::quarantine::mark(&local);
    let session = Arc::new(Session {
        inner: Mutex::new(Inner {
            info: EditInfo {
                id: id.clone(),
                profile_id,
                root,
                key: path,
                name,
                local: local.to_string_lossy().into_owned(),
                rule,
                phase: Phase::Watching,
                error: None,
                server: None,
                last_upload: None,
                upload_id: None,
                upload_size: 0,
                pending: false,
            },
            synced: md5(&bytes),
            known: meta,
        }),
        busy: tokio::sync::Mutex::new(()),
        wake: Notify::new(),
        stop: AtomicBool::new(false),
        watcher: Mutex::new(None),
        dir: dir.clone(),
    });
    // a second Edit of the same file that started while this one downloaded: that session it is
    let raced = {
        let mut all = SESSIONS.lock().unwrap();
        let other = all.values().find(|s| same(s)).cloned();
        if other.is_none() {
            all.insert(id.clone(), session.clone());
        }
        other
    };
    if let Some(s) = raced {
        let _ = tokio::task::spawn_blocking(move || remove_session_dir(&dir)).await;
        return Ok(update(&app, &s, |i| i.info.rule = rule));
    }
    match watch(&session) {
        Ok(w) => *session.watcher.lock().unwrap() = Some(w),
        Err(e) => {
            SESSIONS.lock().unwrap().remove(&id);
            remove_session_dir(&dir);
            return Err(e);
        }
    }
    tauri::async_runtime::spawn(run(app.clone(), session.clone()));
    let info = snapshot(&session);
    emit(&app, &id, Some(info.clone()));
    Ok(info)
}

#[tauri::command]
pub fn edit_list() -> Vec<EditInfo> {
    let mut list: Vec<EditInfo> = SESSIONS.lock().unwrap().values().map(|s| snapshot(s)).collect();
    list.sort_by_key(|s| s.name.to_lowercase());
    list
}

/// Stops watching and deletes the copy (changes not uploaded yet go with it: the page asks first).
#[tauri::command]
pub async fn edit_stop(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(dir) = end(&app, &id) {
        let _ = tokio::task::spawn_blocking(move || remove_session_dir(&dir)).await;
    }
    Ok(())
}

/// Tries the last change again (after a failed upload).
/// The text of the copy being edited on this computer, for "Compare…" in a conflict (8 MB at most).
#[tauri::command]
pub async fn edit_local_text(id: String) -> Result<String, String> {
    let path = find(&id)?.inner.lock().unwrap().info.local.clone();
    tokio::task::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > 8_000_000 {
            return Err("The file is too large to compare.".to_string());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        String::from_utf8(bytes).map_err(|_| "The file isn't text, so it can't be compared.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn edit_retry(id: String) -> Result<(), String> {
    find(&id)?.wake.notify_one();
    Ok(())
}

/// The answer to a conflict: "overwrite" the server's copy, "keepBoth" (upload this copy as
/// "name (edited).ext" and keep editing that), or "reload" (replace this copy with the server's).
#[tauri::command]
pub async fn edit_resolve(app: AppHandle, state: State<'_, AppState>, id: String, action: String) -> Result<EditInfo, String> {
    let s = find(&id)?;
    // one upload per session at a time: the worker (or a first click of this answer) goes first
    let _busy = s.busy.lock().await;
    let info = snapshot(&s);
    // answered already (a double click), or stopped meanwhile
    if info.phase != Phase::Conflict || s.stop.load(Ordering::SeqCst) {
        return Ok(info);
    }
    let local = PathBuf::from(&info.local);
    match action.as_str() {
        "overwrite" | "keepBoth" => {
            let bytes = tokio::fs::read(&local).await.map_err(|e| format!("Couldn't read your copy: {e}"))?;
            let hash = md5(&bytes);
            if action == "overwrite" {
                upload(&app, &s, None, bytes, hash, Precondition::Any).await;
            } else {
                let mut done = false;
                for n in 1..=50 {
                    let to = edited_key(&info.key, n);
                    let expect = Precondition::Absent { headers_from: Some(info.key.clone()) };
                    let size = bytes.len() as u64;
                    update(&app, &s, |i| {
                        i.info.phase = Phase::Uploading;
                        i.info.upload_id = Some(uuid::Uuid::new_v4().to_string());
                        i.info.upload_size = size;
                    });
                    let r = doc::save_bytes(&app, &state, info.profile_id.clone(), info.root.clone(), to.clone(), bytes.clone(), &expect).await;
                    match outcome(r) {
                        // that name is taken: the next one
                        Outcome::Conflict(Some(_)) => continue,
                        out => {
                            settle(&app, &s, out, hash, Some(to));
                            done = true;
                            break;
                        }
                    }
                }
                if !done {
                    settle(&app, &s, Outcome::Failed("Couldn't find a free name for the copy.".into()), hash, None);
                }
            }
        }
        "reload" => {
            let (meta, bytes) = doc::open_bytes(&app, &state, info.profile_id.clone(), info.root.clone(), info.key.clone(), MAX_BYTES).await?;
            let hash = md5(&bytes);
            // record it first, so the watcher sees our own write as "nothing new"
            s.inner.lock().unwrap().synced = hash;
            tokio::fs::write(&local, &bytes).await.map_err(|e| format!("Couldn't replace your copy: {e}"))?;
            update(&app, &s, |i| {
                i.known = meta;
                i.synced = hash;
                i.info.phase = Phase::Watching;
                i.info.pending = false;
                i.info.server = None;
                i.info.error = None;
            });
        }
        _ => return Err(format!("Unknown answer: {action}")),
    }
    Ok(snapshot(&s))
}

// ---------------------------------------------------------------- lifecycle

/// Start-up: removes copies an earlier run left behind. Done before the window can start an
/// edit (a handful of small files), so it can never take a new session's copy with it.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let _ = edit_root(app);
}

/// Quitting: stops every session and deletes every copy.
pub async fn shutdown(app: &AppHandle) {
    let ids: Vec<String> = SESSIONS.lock().unwrap().keys().cloned().collect();
    for id in ids {
        end(app, &id);
    }
    if let Ok(base) = edit_base(app) {
        let _ = tokio::task::spawn_blocking(move || crate::instance_dir::clear(&base)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(etag: &str, size: u64) -> DocMeta {
        DocMeta { etag: Some(etag.into()), size, modified: Some(1000), ..Default::default() }
    }

    #[test]
    fn unchanged_bytes_upload_nothing() {
        let h = md5(b"same");
        for rule in [Rule::Auto, Rule::IfUnchanged] {
            for phase in [Phase::Watching, Phase::Uploaded, Phase::Error, Phase::Conflict] {
                assert_eq!(decide(rule, phase, &h, &h, &meta("a", 4)), Next::Skip, "{rule:?} {phase:?}");
            }
        }
    }

    #[test]
    fn automatic_overwrites_and_unchanged_only_matches_the_known_version() {
        let (old, new) = (md5(b"old"), md5(b"new"));
        let known = meta("abc", 3);
        assert_eq!(decide(Rule::Auto, Phase::Watching, &old, &new, &known), Next::Upload(Precondition::Any));
        assert_eq!(
            decide(Rule::IfUnchanged, Phase::Uploaded, &old, &new, &known),
            Next::Upload(Precondition::Match { etag: Some("abc".into()), size: 3, modified: Some(1000), version: None })
        );
        // a failed upload tries again on the next save
        assert!(matches!(decide(Rule::IfUnchanged, Phase::Error, &old, &new, &known), Next::Upload(_)));
    }

    #[test]
    fn a_waiting_conflict_holds_further_saves() {
        let (old, new) = (md5(b"old"), md5(b"new"));
        assert_eq!(decide(Rule::IfUnchanged, Phase::Conflict, &old, &new, &meta("a", 3)), Next::Hold);
        assert_eq!(decide(Rule::Auto, Phase::Conflict, &old, &new, &meta("a", 3)), Next::Hold);
    }

    #[test]
    fn upload_outcomes() {
        assert_eq!(outcome(Ok(meta("x", 1))), Outcome::Uploaded(meta("x", 1)));
        let now = meta("theirs", 9);
        let e = format!("CONFLICT\n\n{}", serde_json::to_string(&Some(&now)).unwrap());
        assert_eq!(outcome(Err(e)), Outcome::Conflict(Some(now)));
        assert_eq!(outcome(Err("CONFLICT\n\nnull".into())), Outcome::Conflict(None));
        assert_eq!(outcome(Err("Access denied".into())), Outcome::Failed("Access denied".into()));
    }

    #[test]
    fn edited_copy_names() {
        assert_eq!(edited_key("site/index.php", 1), "site/index (edited).php");
        assert_eq!(edited_key("site/index.php", 2), "site/index (edited 2).php");
        assert_eq!(edited_key("Makefile", 1), "Makefile (edited)");
        assert_eq!(edited_key(".env", 1), ".env (edited)");
        assert_eq!(edited_key("a/b.tar.gz", 1), "a/b.tar (edited).gz");
    }

    #[test]
    fn segments_are_safe() {
        assert_eq!(safe_segment("../etc/passwd", "f"), "_etc_passwd");
        assert_eq!(safe_segment("a:b*c?.txt", "f"), "a_b_c_.txt");
        assert_eq!(safe_segment("", "file"), "file");
        assert_eq!(safe_segment("..", "file"), "file");
        assert_eq!(safe_segment("notes.md", "f"), "notes.md");
    }

    /// The copy keeps the type of the remote name, so the open guard's verdict holds for it.
    #[test]
    fn segments_keep_the_extension() {
        // a long name is shortened before its extension, not through it
        let long = format!("{}.exe.txt", "A".repeat(116));
        let got = safe_segment(&long, "f");
        assert!(got.ends_with(".txt"), "{got}");
        assert_eq!(got.chars().count(), SEGMENT_MAX);
        let long = format!("{}.terminal.txt", "A".repeat(111));
        assert!(safe_segment(&long, "f").ends_with(".txt"));
        let long = format!("{}.sh", "é".repeat(300));
        let got = safe_segment(&long, "f");
        assert!(got.ends_with(".sh") && got.chars().count() == SEGMENT_MAX, "{got}");
        // a "extension" too long to be one is cut like the rest
        let long = format!("x.{}", "b".repeat(200));
        assert_eq!(safe_segment(&long, "f").chars().count(), SEGMENT_MAX);
        // separators, dots and spaces at the end can't change the type
        assert_eq!(safe_segment("payload.exe\\", "f"), "payload.exe_");
        assert_eq!(safe_segment("x.exe\\..", "f"), "x.exe_");
        assert_eq!(safe_segment("setup.exe. . ", "f"), "setup.exe");
        assert_eq!(safe_segment("invoice\u{202E}txt.exe", "f"), "invoice\u{202E}txt.exe");
        assert_eq!(safe_segment("Run.EXE", "f"), "Run.EXE");
    }

    /// Long non-ASCII names fit Linux file systems (255 bytes), the extension kept (B6-2).
    #[test]
    fn segments_fit_in_255_bytes() {
        for long in [format!("{}.txt", "漢".repeat(100)), format!("{}.md", "😀".repeat(70)), "漢".repeat(119)] {
            let got = safe_segment(&long, "f");
            assert!(got.len() <= SEGMENT_MAX_BYTES && got.chars().count() <= SEGMENT_MAX, "{} bytes", got.len());
            assert!(long.starts_with(got.trim_end_matches(".txt").trim_end_matches(".md")));
            if long.contains('.') {
                assert_eq!(got.rsplit('.').next(), long.rsplit('.').next());
            }
        }
        // a short one is left alone
        assert_eq!(safe_segment("漢字.txt", "f"), "漢字.txt");
    }

    /// Windows device names get a `_` in front there, any case and extension (B6-4).
    #[test]
    fn device_names_are_renamed_on_windows() {
        for dev in ["CON", "nul", "aux.txt", "Com1.log", "LPT9", "prn.tar.gz", "CONIN$"] {
            assert_eq!(safe_segment_for(dev, "f", true), format!("_{dev}"), "{dev}");
            assert_eq!(safe_segment_for(dev, "f", false), dev, "{dev}");
        }
        for ok in ["console.txt", "auxiliary", "com10", "nul_x"] {
            assert_eq!(safe_segment_for(ok, "f", true), ok, "{ok}");
        }
    }

    #[test]
    fn temp_folders_live_and_die_with_the_session() {
        let root = std::env::temp_dir().join(format!("kybl-edit-test-{}", uuid::Uuid::new_v4()));
        let a = make_session_dir(&root, "conn/1", "s1", "index.php").unwrap();
        let b = make_session_dir(&root, "conn/1", "s2", "style.css").unwrap();
        std::fs::write(&a, b"<?php").unwrap();
        std::fs::write(&b, b"body{}").unwrap();
        assert!(a.starts_with(root.join("conn_1").join("s1")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
        }
        // stopping one keeps the other (and their connection's folder)
        remove_session_dir(a.parent().unwrap());
        assert!(!a.exists());
        assert!(b.exists());
        // the last one takes the connection's folder with it
        remove_session_dir(b.parent().unwrap());
        assert!(!root.join("conn_1").exists());
        // next start: whatever is left goes
        let c = make_session_dir(&root, "other", "s3", "x.txt").unwrap();
        std::fs::write(&c, b"x").unwrap();
        sweep(&root);
        assert!(!root.exists());
    }

    #[test]
    fn rules_read_from_the_page() {
        assert_eq!(serde_json::from_str::<Rule>("\"auto\"").unwrap(), Rule::Auto);
        assert_eq!(serde_json::from_str::<Rule>("\"ifUnchanged\"").unwrap(), Rule::IfUnchanged);
        assert_eq!(serde_json::to_string(&Phase::Conflict).unwrap(), "\"conflict\"");
    }

    /// Saves in place and the "write a temp file, rename it over" way both wake the session.
    #[test]
    fn the_watcher_sees_in_place_and_atomic_saves() {
        let root = std::env::temp_dir().join(format!("kybl-edit-watch-{}", uuid::Uuid::new_v4()));
        let file = make_session_dir(&root, "c", "s", "a.txt").unwrap();
        std::fs::write(&file, b"one").unwrap();
        let s = Arc::new(Session {
            inner: Mutex::new(Inner {
                info: EditInfo {
                    id: "s".into(),
                    profile_id: "c".into(),
                    root: String::new(),
                    key: "a.txt".into(),
                    name: "a.txt".into(),
                    local: file.to_string_lossy().into_owned(),
                    rule: Rule::IfUnchanged,
                    phase: Phase::Watching,
                    error: None,
                    server: None,
                    last_upload: None,
                    upload_id: None,
                    upload_size: 0,
                    pending: false,
                },
                known: meta("a", 3),
                synced: md5(b"one"),
            }),
            busy: tokio::sync::Mutex::new(()),
            wake: Notify::new(),
            stop: AtomicBool::new(false),
            watcher: Mutex::new(None),
            dir: file.parent().unwrap().to_path_buf(),
        });
        *s.watcher.lock().unwrap() = Some(watch(&s).unwrap());
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        let woke = |s: &Arc<Session>| rt.block_on(async { tokio::time::timeout(Duration::from_secs(10), s.wake.notified()).await.is_ok() });
        // FSEvents needs a moment to start delivering
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(&file, b"two").unwrap();
        assert!(woke(&s), "in-place save");
        let tmp = file.with_file_name(".a.txt.swp");
        std::fs::write(&tmp, b"three").unwrap();
        std::fs::rename(&tmp, &file).unwrap();
        assert!(woke(&s), "atomic replace");
        assert_eq!(std::fs::read(&file).unwrap(), b"three");
        s.watcher.lock().unwrap().take();
        sweep(&root);
    }

    /// An upload that finishes after the person stopped editing doesn't bring the row back.
    #[test]
    fn an_upload_ending_after_stop_leaves_the_page_alone() {
        use tauri::{
            test::{mock_builder, mock_context, noop_assets},
            Listener,
        };
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let ev = events.clone();
        app.listen_any("edit", move |e| ev.lock().unwrap().push(serde_json::from_str(e.payload()).unwrap()));
        let id = format!("ghost-{}", uuid::Uuid::new_v4());
        let s = Arc::new(Session {
            inner: Mutex::new(Inner {
                info: EditInfo {
                    id: id.clone(),
                    profile_id: "c".into(),
                    root: String::new(),
                    key: "a.txt".into(),
                    name: "a.txt".into(),
                    local: "/nonexistent/a.txt".into(),
                    rule: Rule::Auto,
                    phase: Phase::Uploading,
                    error: None,
                    server: None,
                    last_upload: None,
                    upload_id: None,
                    upload_size: 0,
                    pending: true,
                },
                known: meta("a", 3),
                synced: md5(b"one"),
            }),
            busy: tokio::sync::Mutex::new(()),
            wake: Notify::new(),
            stop: AtomicBool::new(false),
            watcher: Mutex::new(None),
            dir: PathBuf::from("/nonexistent"),
        });
        SESSIONS.lock().unwrap().insert(id.clone(), s.clone());
        // the person stops editing while the upload (holding its own `Arc`) is still running
        assert!(end(app.handle(), &id).is_some());
        settle(app.handle(), &s, Outcome::Uploaded(meta("b", 3)), md5(b"two"), None);
        settle(app.handle(), &s, Outcome::Conflict(None), md5(b"two"), None);
        let got = events.lock().unwrap().clone();
        assert_eq!(got.len(), 1, "{got:?}");
        assert!(got[0]["session"].is_null(), "only the end was sent: {got:?}");
        assert_eq!(s.inner.lock().unwrap().info.phase, Phase::Uploading);
    }
}
