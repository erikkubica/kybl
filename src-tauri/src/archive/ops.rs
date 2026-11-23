//! Compressing and extracting through [`Storage`], so the same code serves this computer, S3,
//! servers and drives: files are read from any connection into a zip, and an archive's files are
//! written to any connection.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt};

use super::backend::stream_item;
use super::index::{parent_of, Index, Item};
use crate::storage::{ErrKind, FolderMode, Precondition, Reopen, SResult, Storage, StorageError, WriteOpts, WriteOutcome, WriteSource};

/// One thing that goes into a zip: `name` is its path inside (folders end with `/`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackItem {
    pub name: String,
    pub key: String,
    pub size: u64,
    pub modified: Option<i64>,
}

/// Everything `items` (keys; folders end with `/`) hold, with names relative to the folder the
/// first one is in. Folders come before what is inside them. Also answers what was left out: links
/// met inside a folder on this computer (never followed out of it, see `local_links`) and names
/// no extractor should be handed (`..`, `.`, empty parts, a backslash: a bucket allows the key
/// `a/../../../.bashrc`, which a careless unzip would write outside its folder).
pub async fn plan_pack(s: &dyn Storage, root: &str, items: &[String]) -> SResult<(Vec<PackItem>, Vec<String>)> {
    let Some(first) = items.first() else { return Ok((vec![], vec![])) };
    let base = parent_of(first).to_string();
    let rel = |k: &str| k.strip_prefix(base.as_str()).unwrap_or(k).to_string();
    let mut out = Vec::new();
    let mut left_out = Vec::new();
    for key in items {
        if key.ends_with('/') {
            out.push(PackItem { name: rel(key), key: key.clone(), size: 0, modified: None });
            let mut walk = s.walk(root, key);
            while let Some(batch) = walk.next().await {
                for e in batch? {
                    if e.key == *key {
                        continue;
                    }
                    if crate::local_links::skip_listed_link(s.caps(), &e) || !zip_name_ok(&rel(&e.key)) {
                        left_out.push(e.key);
                        continue;
                    }
                    out.push(PackItem { name: rel(&e.key), size: if e.is_dir() { 0 } else { e.size.max(0) as u64 }, modified: e.modified, key: e.key });
                }
            }
        } else {
            let e = s.stat(root, key).await?.ok_or_else(StorageError::not_found)?;
            out.push(PackItem { name: rel(key), key: key.clone(), size: e.size.max(0) as u64, modified: e.modified });
        }
    }
    // a store that lists files of a folder before the folder itself (prefix stores): folders first
    let mut seen = BTreeSet::new();
    out.retain(|i| seen.insert(i.name.clone()));
    Ok((out, left_out))
}

/// A name that is safe inside a zip: relative, every part a plain name.
pub fn zip_name_ok(name: &str) -> bool {
    let body = name.strip_suffix('/').unwrap_or(name);
    !body.is_empty() && !name.starts_with('/') && !name.contains(['\\', '\0']) && body.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
}

/// What a finished compress says about the entries it left out.
pub fn left_out_note(keys: &[String]) -> String {
    let n = keys.len();
    let what = if n == 1 { "1 item was".to_string() } else { format!("{n} items were") };
    let first: Vec<&str> = keys.iter().take(3).map(String::as_str).collect();
    let more = if n > 3 { ", …" } else { "" };
    format!("{what} left out of the zip (links, or names that aren't safe in a zip): {}{more}", first.join(", "))
}

/// Kinds of files that are compressed already: stored as they are (deflating them only costs time).
fn precompressed(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "heic" | "mp4" | "mov" | "m4v" | "mkv" | "webm" | "mp3" | "m4a" | "aac" | "ogg" | "opus" | "flac"
            | "zip" | "gz" | "tgz" | "bz2" | "xz" | "zst" | "7z" | "rar" | "docx" | "xlsx" | "pptx" | "pdf" | "woff2"
    )
}

/// A zip time from milliseconds since 1970 (zips keep local wall time; this writes UTC).
fn zip_time(ms: Option<i64>) -> zip::DateTime {
    let Some(ms) = ms else { return zip::DateTime::default() };
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    zip::DateTime::from_date_and_time(y.clamp(1980, 2107) as u16, m as u8, d as u8, (rem / 3600) as u8, (rem % 3600 / 60) as u8, (rem % 60) as u8)
        .unwrap_or_default()
}

enum Msg {
    Dir(String, Option<i64>),
    File(String, Option<i64>, u64),
    Data(Bytes),
}

fn zip_err(e: zip::result::ZipError) -> StorageError {
    StorageError::other(format!("Couldn't write the zip. {e}"))
}

/// Writes `items` read from `s` into a new zip at `out`. `progress` gets the bytes read so far.
pub async fn pack_to_file(
    s: Arc<dyn Storage>,
    root: &str,
    items: &[PackItem],
    out: &Path,
    progress: &(dyn Fn(u64) + Send + Sync),
    cancel: &AtomicBool,
) -> SResult<()> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Msg>(8);
    let path = out.to_path_buf();
    let writer = tokio::task::spawn_blocking(move || -> SResult<()> {
        let f = std::fs::File::create(&path)?;
        let mut z = zip::ZipWriter::new(io::BufWriter::new(f));
        while let Some(m) = rx.blocking_recv() {
            match m {
                Msg::Dir(name, t) => {
                    let o = zip::write::SimpleFileOptions::default().last_modified_time(zip_time(t)).unix_permissions(0o755);
                    z.add_directory(name, o).map_err(zip_err)?;
                }
                Msg::File(name, t, size) => {
                    let method = if precompressed(&name) { zip::CompressionMethod::Stored } else { zip::CompressionMethod::Deflated };
                    let o = zip::write::SimpleFileOptions::default()
                        .compression_method(method)
                        .last_modified_time(zip_time(t))
                        .unix_permissions(0o644)
                        .large_file(size >= u32::MAX as u64);
                    z.start_file(name, o).map_err(zip_err)?;
                }
                Msg::Data(b) => z.write_all(&b)?,
            }
        }
        z.finish().map_err(zip_err)?.flush()?;
        Ok(())
    });
    let feed = async {
        let mut done = 0u64;
        for it in items {
            if cancel.load(Ordering::Relaxed) {
                return Err(StorageError::cancelled());
            }
            if it.name.ends_with('/') {
                if tx.send(Msg::Dir(it.name.clone(), it.modified)).await.is_err() {
                    return Ok(());
                }
                continue;
            }
            if tx.send(Msg::File(it.name.clone(), it.modified, it.size)).await.is_err() {
                return Ok(());
            }
            let mut body = s.read(root, &it.key, None, None).await?.body;
            while let Some(chunk) = body.next().await {
                if cancel.load(Ordering::Relaxed) {
                    return Err(StorageError::cancelled());
                }
                let chunk = chunk?;
                done += chunk.len() as u64;
                progress(done);
                if tx.send(Msg::Data(chunk)).await.is_err() {
                    return Ok(());
                }
            }
        }
        Ok(())
    };
    let fed = feed.await;
    drop(tx);
    let wrote = writer.await.map_err(|e| StorageError::other(e.to_string()))?;
    let res = fed.and(wrote);
    if res.is_err() {
        let _ = tokio::fs::remove_file(out).await;
    }
    res
}

/// What an extraction writes: each file with the key it gets at the destination, and folders.
#[derive(Debug, Default)]
pub struct ExtractPlan {
    pub files: Vec<(Item, String)>,
    /// the destination folder everything lands under ("" or ending with `/`)
    pub dest_dir: String,
    /// destination folder keys (ending with `/`), parents first
    pub dirs: Vec<String>,
    /// folders with nothing inside (prefix stores need a marker for these only)
    pub empty_dirs: BTreeSet<String>,
    pub bytes: u64,
    /// the archive came from somewhere else (a connection, or it carries the mark itself): files
    /// written on this computer get the downloaded-file mark (`platform::quarantine`)
    pub mark: bool,
}

/// Which files go where. `paths` picks entries (files, or folders ending with `/`; empty: all),
/// `base` is the archive folder they are relative to, `dest_dir` the destination folder ("" or
/// ending with `/`) and `folder` an optional new folder in it to unpack into; Unpacking everything
/// into a folder named like the archive's only top folder doesn't nest it twice
/// ("site/site/…" becomes "site/…").
/// `renames` gives picked entries another name at the destination ("notes.txt" → "notes (1).txt").
pub fn plan_extract(index: &Index, paths: &[String], base: &str, dest_dir: &str, folder: Option<&str>, renames: &HashMap<String, String>) -> ExtractPlan {
    let mut base = base.to_string();
    if let Some(f) = folder {
        if paths.is_empty() && base.is_empty() && index.top() == [format!("{f}/")] {
            base = format!("{f}/");
        }
    }
    let target = match folder {
        Some(f) => format!("{dest_dir}{f}/"),
        None => dest_dir.to_string(),
    };
    let picked: Vec<String> = if paths.is_empty() { vec![base.clone()] } else { paths.to_vec() };
    let mut plan = ExtractPlan { dest_dir: dest_dir.to_string(), ..Default::default() };
    let mut dirs = BTreeSet::new();
    if folder.is_some() {
        dirs.insert(target.clone());
    }
    let mut seen = BTreeSet::new();
    for p in &picked {
        for it in index.files_under(p) {
            if !seen.insert(it.key.clone()) {
                continue;
            }
            let Some(rel) = it.key.strip_prefix(base.as_str()) else { continue };
            let rel = renamed(rel, p, &base, renames);
            plan.files.push((it.clone(), format!("{target}{rel}")));
            plan.bytes += it.size;
        }
        // folders of the selection (also empty ones)
        for d in index.dirs.iter().filter(|d| p.is_empty() || (p.ends_with('/') && d.starts_with(p.as_str()))) {
            if let Some(rel) = d.strip_prefix(base.as_str()).filter(|r| !r.is_empty()) {
                dirs.insert(format!("{target}{}", renamed(rel, p, &base, renames)));
            }
        }
    }
    // every folder some planned file is in (at any depth), gathered once: checking each folder
    // against every file is files × folders, far too slow for a node_modules zip
    let mut filled: HashSet<&str> = HashSet::new();
    for (_, k) in &plan.files {
        let mut p = parent_of(k);
        while !p.is_empty() && filled.insert(p) {
            p = parent_of(p);
        }
    }
    for d in &dirs {
        if !filled.contains(d.as_str()) {
            plan.empty_dirs.insert(d.clone());
        }
    }
    plan.dirs = dirs.into_iter().collect();
    plan
}

/// `rel` (relative to `base`) with its first part renamed when the picked entry `p` it came from
/// has a new name. Only plain names are taken (no `/`, `..`): a rename can't move anything out.
fn renamed(rel: &str, p: &str, base: &str, renames: &HashMap<String, String>) -> String {
    let Some(new) = renames.get(p).filter(|n| !n.is_empty() && !n.contains(['/', '\\']) && *n != "." && *n != "..") else { return rel.to_string() };
    let Some(own) = p.strip_prefix(base).map(|o| o.trim_end_matches('/')).filter(|o| !o.is_empty() && !o.contains('/')) else { return rel.to_string() };
    match rel.strip_prefix(own) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{new}{rest}"),
        _ => rel.to_string(),
    }
}

/// Writes the plan's files out of `index` into `dst`. Without `overwrite`, files already there are
/// kept (counted as skipped). `progress` gets the bytes written so far. Returns (written, skipped).
pub async fn extract(
    index: Arc<Index>,
    dst: Arc<dyn Storage>,
    root: &str,
    plan: &ExtractPlan,
    overwrite: bool,
    progress: &(dyn Fn(u64) + Send + Sync),
    cancel: &Arc<AtomicBool>,
) -> SResult<(u64, u64)> {
    links_on_the_way(&*dst, root, plan)?;
    let real = dst.caps().folders == FolderMode::Real;
    for d in &plan.dirs {
        if real || plan.empty_dirs.contains(d) {
            dst.mkdir(root, d).await?;
        }
    }
    let done = AtomicU64::new(0);
    let skipped = AtomicU64::new(0);
    let parallel = if dst.local_path(root, "").is_some() { 2 } else { 4 };
    futures_util::stream::iter(plan.files.iter().map(Ok::<_, StorageError>))
        .try_for_each_concurrent(parallel, |(item, key)| {
            let (index, dst, done, skipped) = (index.clone(), dst.clone(), &done, &skipped);
            async move {
                if cancel.load(Ordering::Relaxed) {
                    return Err(StorageError::cancelled());
                }
                let size = item.size;
                let body = stream_item(index.clone(), item.clone(), None);
                let (ri, rit) = (index.clone(), item.clone());
                let reopen: Reopen = Box::new(move |from| {
                    let (i, it) = (ri.clone(), rit.clone());
                    Box::pin(async move { Ok(stream_item(i, it, Some(from..size))) })
                });
                let opts = WriteOpts {
                    precondition: if overwrite { Precondition::None } else { Precondition::IfNoneMatch },
                    modified: item.modified,
                    parts_in_flight: 2,
                    ..Default::default()
                };
                let last = AtomicU64::new(0);
                let tick = |n: u64, _t: u64| {
                    let prev = last.swap(n, Ordering::Relaxed);
                    progress(done.fetch_add(n.saturating_sub(prev), Ordering::Relaxed) + n.saturating_sub(prev));
                };
                let out = dst.write(root, key, WriteSource::Stream { len: Some(size), body, reopen: Some(reopen) }, opts, &tick, cancel).await?;
                // what the write didn't report as progress still counts once it's done
                let rest = size.saturating_sub(last.load(Ordering::Relaxed));
                progress(done.fetch_add(rest, Ordering::Relaxed) + rest);
                match out {
                    WriteOutcome::Done(_) => {
                        crate::platform::quarantine::mark_arrival(plan.mark, &*dst, root, key);
                        Ok(())
                    }
                    WriteOutcome::Conflict(_) => {
                        skipped.fetch_add(1, Ordering::Relaxed);
                        Ok(())
                    }
                    WriteOutcome::Cancelled => Err(StorageError::cancelled()),
                }
            }
        })
        .await?;
    let skipped = skipped.load(Ordering::Relaxed);
    Ok((plan.files.len() as u64 - skipped, skipped))
}

/// On this computer: no folder or file the archive names may be (or be reached through) a link in
/// the destination folder, which would put the archive's files somewhere else (`Documents ->
/// ~/Documents`) or write over what a link points at (`local_links`). Checked for all of them
/// before anything is written.
fn links_on_the_way(dst: &dyn Storage, root: &str, plan: &ExtractPlan) -> SResult<()> {
    let Some(base) = dst.local_path(root, plan.dest_dir.trim_end_matches('/')) else { return Ok(()) };
    for key in plan.dirs.iter().chain(plan.files.iter().map(|(_, k)| k)) {
        if let Some(p) = dst.local_path(root, key.trim_end_matches('/')) {
            crate::local_links::safe_write_target(&base, &p).map_err(|why| StorageError::new(ErrKind::PermissionDenied, format!("Nothing was unpacked. {why}")))?;
        }
    }
    Ok(())
}

/// Copies a file of `s` to `to` on this computer (a remote archive, before it is read).
pub async fn fetch(s: &dyn Storage, root: &str, key: &str, to: &Path, progress: &(dyn Fn(u64, u64) + Send + Sync), cancel: &AtomicBool) -> SResult<PathBuf> {
    use tokio::io::AsyncWriteExt;
    if let Some(dir) = to.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let part = super::index::part_path(to);
    let r = s.read(root, key, None, None).await?;
    let total = r.total.or(r.len).unwrap_or(0);
    let mut body = r.body;
    let mut f = tokio::fs::File::create(&part).await?;
    let mut done = 0u64;
    let res: SResult<()> = async {
        while let Some(chunk) = body.next().await {
            if cancel.load(Ordering::Relaxed) {
                return Err(StorageError::cancelled());
            }
            let chunk = chunk?;
            done += chunk.len() as u64;
            f.write_all(&chunk).await?;
            progress(done, total);
        }
        // a body that ended early is never taken for the whole archive
        if total > 0 && done < total {
            return Err(crate::storage::generic_cmds::short_read(done, total).into());
        }
        f.flush().await?;
        Ok(())
    }
    .await;
    if let Err(e) = res {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e);
    }
    tokio::fs::rename(&part, to).await?;
    Ok(to.to_path_buf())
}
