//! ThumbHash placeholders: a ~25-byte blurry stand-in for a photo, shown in the grid at once while
//! (or instead of) its thumbnail loads, so a folder of 2000 photos is usable on a slow line.
//!
//! The web view decodes them (src/thumbs/thumbhash.ts). They come from three places, cheapest first:
//!  - **this device's index** (`placeholders.db`): every thumbnail made here leaves its hash, and so
//!    does every photo uploaded from here. Kept apart from the thumbnail cache, so trimming that
//!    cache doesn't lose them; Settings → Clear cache empties both.
//!  - **a folder's shared index** (`<folder>/.kybl/thumbhash.json`), opt-in per connection: one small
//!    file per photo folder, so another device gets every placeholder with one request.
//!  - **the photo itself**: uploads to S3 from Kybl carry `x-amz-meta-thumbhash`, read with a HEAD
//!    for tiles on screen whose hash isn't known otherwise. Old photos are never rewritten to add it
//!    (a server-side copy would be needed, and copies are unreliable on some providers).
//!
//! Every hash belongs to one version of a file (its etag and size): a changed photo isn't shown
//! with the old one's placeholder.

use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex, OnceLock},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bytes::Bytes;
use image::DynamicImage;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::state::{err, AppState};
use crate::storage::{self, registry, Conn, FolderMode, WriteOpts, WriteSource};
use crate::files::thumbs;

/// The thumbhash format works on images up to 100 x 100.
const HASH_PX: u32 = 100;
/// The shared index of a folder, next to its photos. Hidden from listings by the app (src/thumbs/thumbhash.ts).
pub const INDEX_NAME: &str = ".kybl/thumbhash.json";
const INDEX_VERSION: u32 = 1;
/// A folder index bigger than this is not read (it would cost more than it saves).
const MAX_INDEX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_INDEX_ENTRIES: usize = 50_000;
/// Placeholders made from cached thumbnails in one lookup (each is a small JPEG decode).
const MAX_FROM_CACHE: usize = 64;
/// What the thumbnail engine can decode; uploads of these carry a placeholder.
const HASHABLE: [&str; 8] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"];

// ---------------------------------------------------------------- encoding

/// The ThumbHash of an image, base64 (about 30–40 characters).
pub fn hash_image(img: &DynamicImage) -> String {
    let small = if img.width() > HASH_PX || img.height() > HASH_PX { img.thumbnail(HASH_PX, HASH_PX) } else { img.clone() };
    let rgba = small.to_rgba8();
    B64.encode(thumbhash::rgba_to_thumb_hash(rgba.width() as usize, rgba.height() as usize, rgba.as_raw()))
}

fn hash_jpeg(jpeg: &[u8]) -> Option<String> {
    let img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).ok()?;
    Some(hash_image(&img))
}

/// A hash read from somewhere else (object metadata, a shared index): plausible, or ignored.
fn valid(hash: &str) -> bool {
    (8..=64).contains(&hash.len()) && B64.decode(hash).is_ok_and(|b| b.len() >= 5)
}

fn bare(etag: &str) -> &str {
    etag.trim_matches('"')
}

// ---------------------------------------------------------------- this device's index

/// Placeholders by file: one row per file (its latest version), so the index stays small.
pub struct Store(Mutex<Connection>);

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE hashes(
    profile TEXT NOT NULL,
    root TEXT NOT NULL,
    key TEXT NOT NULL,
    etag TEXT NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY(profile, root, key)
) WITHOUT ROWID;
"#];

impl Store {
    fn new(conn: Connection) -> Self {
        Self(Mutex::new(conn))
    }

    /// The placeholder of this version of the file, if known.
    pub fn get(&self, profile: &str, root: &str, key: &str, etag: &str, size: i64) -> Option<String> {
        let c = self.0.lock().unwrap();
        c.query_row(
            "SELECT hash FROM hashes WHERE profile = ?1 AND root = ?2 AND key = ?3 AND etag = ?4 AND size = ?5",
            params![profile, root, key, bare(etag), size],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn put(&self, profile: &str, root: &str, key: &str, etag: &str, size: i64, hash: &str) {
        let c = self.0.lock().unwrap();
        let _ = c.execute(
            "INSERT OR REPLACE INTO hashes(profile, root, key, etag, size, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![profile, root, key, bare(etag), size, hash],
        );
    }

    /// The files of `profile` the index knows: (root, key, etag, size).
    fn files_of(&self, profile: &str) -> Vec<(String, String, String, i64)> {
        let c = self.0.lock().unwrap();
        let Ok(mut q) = c.prepare("SELECT root, key, etag, size FROM hashes WHERE profile = ?1") else { return vec![] };
        q.query_map(params![profile], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    fn forget_profile(&self, profile: &str) {
        let _ = self.0.lock().unwrap().execute("DELETE FROM hashes WHERE profile = ?1", params![profile]);
    }

    fn clear(&self) {
        let c = self.0.lock().unwrap();
        let _ = c.execute_batch("DELETE FROM hashes; VACUUM;");
    }
}

static STORE: OnceLock<(Store, PathBuf)> = OnceLock::new();

fn store() -> Option<&'static Store> {
    STORE.get().map(|s| &s.0)
}

/// Opens `placeholders.db` in the app's data folder (not the cache folder: the OS may empty that).
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let path = dir.join("placeholders.db");
    match crate::db::open(&path, MIGRATIONS) {
        Ok(conn) => {
            let _ = STORE.set((Store::new(conn), path));
        }
        Err(e) => eprintln!("placeholders: {e}"),
    }
}

/// Bytes the index takes (Settings counts it with the thumbnails).
pub fn usage() -> u64 {
    let Some((_, path)) = STORE.get() else { return 0 };
    ["", "-wal"].iter().filter_map(|s| std::fs::metadata(format!("{}{s}", path.display())).ok()).map(|m| m.len()).sum()
}

/// Empties the index (Settings → Clear cache); answers the bytes freed.
pub async fn clear() -> u64 {
    let before = usage();
    if let Some(s) = store() {
        let _ = tokio::task::spawn_blocking(move || s.clear()).await;
    }
    before.saturating_sub(usage())
}

/// The files of connection `profile` with a placeholder: (root, key, etag without quotes, size).
pub fn files_of(profile: &str) -> Vec<(String, String, String, i64)> {
    store().map(|s| s.files_of(profile)).unwrap_or_default()
}

/// A connection was deleted: its placeholders go too.
pub fn forget_profile(profile: &str) {
    if let Some(s) = store() {
        s.forget_profile(profile);
    }
}

/// A thumbnail was made (or served from the cache): its placeholder is kept, once per version.
pub async fn note_thumbnail(profile: &str, root: &str, key: &str, etag: &str, size: i64, jpeg: &[u8]) {
    let Some(s) = store() else { return };
    if s.get(profile, root, key, etag, size).is_some() {
        return;
    }
    let jpeg = jpeg.to_vec();
    if let Ok(Some(hash)) = tokio::task::spawn_blocking(move || hash_jpeg(&jpeg)).await {
        s.put(profile, root, key, etag, size, &hash);
    }
}

// ---------------------------------------------------------------- uploads

/// What a photo about to be uploaded brings along: its placeholder, and a grid thumbnail when the
/// photo had to be decoded anyway (or carries a sharp enough one), so neither is ever downloaded.
pub struct Prepared {
    pub hash: String,
    jpeg: Option<Vec<u8>>,
}

/// Works out the placeholder of a local photo, or None for files that aren't photos the
/// thumbnail engine reads (or that are too big for it). JPEG and TIFF try the camera's embedded
/// thumbnail first (only the head of the file is read); others are decoded whole.
pub async fn prepare_upload(path: &str, size: u64) -> Option<Prepared> {
    let ext = std::path::Path::new(path).extension()?.to_str()?.to_lowercase();
    if !HASHABLE.contains(&ext.as_str()) {
        return None;
    }
    if thumbs::may_have_exif(path) {
        let p = path.to_string();
        let found = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut head = Vec::with_capacity(thumbs::HEAD_RANGE);
            std::fs::File::open(&p).ok()?.take(thumbs::HEAD_RANGE as u64).read_to_end(&mut head).ok()?;
            let img = thumbs::exif_image(&head)?;
            let hash = hash_image(&img);
            let jpeg = if thumbs::sharp_enough(&img) { thumbs::encode(img).ok() } else { None };
            Some(Prepared { hash, jpeg })
        })
        .await
        .ok()
        .flatten();
        if found.is_some() {
            return found;
        }
    }
    if size > thumbs::MAX_FULL_DOWNLOAD as u64 {
        return None;
    }
    let _slot = thumbs::decode_slots().acquire_owned().await.ok()?;
    let p = path.to_string();
    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&p).ok()?;
        let img = thumbs::decode_image(&bytes).ok()?;
        drop(bytes);
        let hash = hash_image(&img);
        Some(Prepared { hash, jpeg: thumbs::encode(img).ok() })
    })
    .await
    .ok()
    .flatten()
}

/// The photo arrived as this version: its placeholder and thumbnail are known here from now on.
pub async fn uploaded(profile: &str, root: &str, key: &str, etag: Option<&str>, size: u64, prepared: &Prepared) {
    let Some(etag) = etag.map(bare).filter(|e| !e.is_empty()) else { return };
    if let Some(s) = store() {
        s.put(profile, root, key, etag, size as i64, &prepared.hash);
    }
    if let Some(jpeg) = &prepared.jpeg {
        thumbs::seed(profile, root, key, etag, size as i64, jpeg).await;
    }
}

// ---------------------------------------------------------------- folder index

/// The etag and size a hash belongs to, then the hash: `["etag", 1234, "hash"]` in the file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stamp(String, i64, String);

/// `<folder>/.kybl/thumbhash.json`: `{"v":1,"files":{"IMG_0001.jpg":["etag",1234,"hash"],…}}`,
/// names relative to the folder.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FolderIndex {
    v: u32,
    files: BTreeMap<String, Stamp>,
}

impl FolderIndex {
    /// The index in a file; Err when a newer Kybl wrote it (it is then left alone). Anything
    /// unreadable counts as empty, so a broken file is replaced by a good one.
    fn parse(bytes: &[u8]) -> Result<Self, ()> {
        #[derive(Deserialize)]
        struct Version {
            v: u32,
        }
        match serde_json::from_slice::<Version>(bytes) {
            Ok(Version { v }) if v > INDEX_VERSION => Err(()),
            _ => {
                let mut ix: FolderIndex = serde_json::from_slice(bytes).unwrap_or_default();
                ix.files.retain(|_, s| valid(&s.2));
                ix.v = INDEX_VERSION;
                Ok(ix)
            }
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&FolderIndex { v: INDEX_VERSION, files: self.files.clone() }).unwrap_or_default()
    }

    /// The hash of `name` if it was made for this version of it (the app matches the same way,
    /// in thumbhash.ts).
    #[cfg(test)]
    fn hash_of(&self, name: &str, etag: &str, size: i64) -> Option<&str> {
        self.files.get(name).filter(|s| s.0 == bare(etag) && s.1 == size).map(|s| s.2.as_str())
    }

    /// What another device wrote, plus ours (ours win for the same name). With `present` (the
    /// folder's whole listing), names no longer in the folder are dropped. Two devices writing at
    /// once: the last write wins, each having merged what was there when it read.
    fn merge(&mut self, ours: impl IntoIterator<Item = (String, Stamp)>, present: Option<&HashSet<String>>) {
        for (name, stamp) in ours {
            if valid(&stamp.2) {
                self.files.insert(name, stamp);
            }
        }
        if let Some(p) = present {
            self.files.retain(|name, _| p.contains(name));
        }
        while self.files.len() > MAX_INDEX_ENTRIES {
            let Some(k) = self.files.keys().next().cloned() else { break };
            self.files.remove(&k);
        }
    }
}

fn index_path(prefix: &str) -> String {
    format!("{prefix}{INDEX_NAME}")
}

/// The folder's index; an empty one when there is none (the usual case) or it can't be read.
async fn read_index(s: &dyn storage::Storage, root: &str, prefix: &str) -> Result<FolderIndex, ()> {
    let Ok(r) = s.read(root, &index_path(prefix), None, None).await else { return Ok(FolderIndex::default()) };
    match r.collect(MAX_INDEX_BYTES).await {
        Ok(bytes) => FolderIndex::parse(&bytes),
        Err(_) => Ok(FolderIndex::default()),
    }
}

// ---------------------------------------------------------------- commands

/// One listed file version.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    key: String,
    etag: Option<String>,
    size: i64,
}

/// A listed file version and its placeholder.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Known {
    key: String,
    etag: Option<String>,
    size: i64,
    hash: String,
}

/// The placeholders this device knows for these files (None where it knows none). Files whose
/// thumbnail was cached before placeholders existed get theirs made from it now.
#[tauri::command]
pub async fn placeholders_lookup(app: AppHandle, profile_id: String, root: String, items: Vec<Item>) -> Result<Vec<Option<String>>, String> {
    let Some(s) = store() else { return Ok(vec![None; items.len()]) };
    tokio::task::spawn_blocking(move || {
        let mut from_cache = 0;
        items
            .iter()
            .map(|it| {
                let etag = it.etag.as_deref().unwrap_or("");
                if let Some(h) = s.get(&profile_id, &root, &it.key, etag, it.size) {
                    return Some(h);
                }
                if from_cache >= MAX_FROM_CACHE {
                    return None;
                }
                let path = thumbs::cached_path(&app, &profile_id, &root, &it.key, etag, it.size)?;
                from_cache += 1;
                let hash = hash_jpeg(&std::fs::read(path).ok()?)?;
                s.put(&profile_id, &root, &it.key, etag, it.size, &hash);
                Some(hash)
            })
            .collect()
    })
    .await
    .map_err(err)
}

/// The start of a JPEG to read for its camera thumbnail: the EXIF block (APP1) can't be larger
/// than 64 KB, plus a little for a JFIF block before it. A few dozen KB per photo instead of the
/// photo, so slow lines get placeholders for whole folders.
const EXIF_RANGE: usize = 72 * 1024;

/// The placeholder of a photo nobody here has one for yet, with one small request:
///  - S3: a ranged GET. Its headers carry what an upload from Kybl stored on the object
///    (`x-amz-meta-thumbhash`); otherwise a JPEG's first bytes hold the camera's thumbnail, which
///    makes the placeholder (and, when sharp enough, the grid thumbnail too: switching to
///    thumbnails later downloads nothing). Other formats ask for one byte: just the headers.
///  - Other connections: a JPEG's first bytes, the same way. Never this device's own files.
///
/// None when there is none or the file is no longer the listed version.
#[tauri::command]
pub async fn placeholder_head(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    root: String,
    key: String,
    etag: Option<String>,
    size: i64,
) -> Result<Option<String>, String> {
    let exif = thumbs::may_have_exif(&key);
    let conn = storage::connect(&app, &state, &profile_id).await?;
    let (head, now) = match &conn {
        Conn::S3(client) => {
            let range = if exif { format!("bytes=0-{}", EXIF_RANGE - 1) } else { "bytes=0-0".to_string() };
            let mut out = client.get_object().bucket(&root).key(&key).range(range).send().await.map_err(crate::state::sdk_err)?;
            let now = out.e_tag().map(bare).unwrap_or("").to_string();
            // "bytes 0-65535/1234567": the part after the slash is the whole file
            let total = out.content_range().and_then(|r| r.rsplit('/').next()).and_then(|t| t.parse::<i64>().ok());
            if etag.as_deref().is_some_and(|e| bare(e) != now) || total.is_some_and(|n| n != size) {
                return Ok(None);
            }
            if let Some(hash) = out.metadata().and_then(|m| m.get("thumbhash")).filter(|v| valid(v)).cloned() {
                if let Some(s) = store() {
                    s.put(&profile_id, &root, &key, &now, size, &hash);
                }
                return Ok(Some(hash));
            }
            if !exif {
                return Ok(None);
            }
            let mut head: Vec<u8> = Vec::with_capacity(EXIF_RANGE);
            while let Some(chunk) = out.body.try_next().await.map_err(err)? {
                head.extend_from_slice(&chunk);
                if head.len() >= EXIF_RANGE {
                    break;
                }
            }
            (head, now)
        }
        Conn::Other(s) => {
            if !exif || s.caps().local_paths {
                return Ok(None);
            }
            let (head, tag) = thumbs::read_first(&**s, &root, &key, EXIF_RANGE).await?;
            let now = tag.as_deref().map(bare).unwrap_or("").to_string();
            if etag.as_deref().is_some_and(|e| !now.is_empty() && bare(e) != now) {
                return Ok(None);
            }
            (head, etag.as_deref().map(bare).unwrap_or(&now).to_string())
        }
    };
    let s3 = matches!(conn, Conn::S3(_));
    let made = tokio::task::spawn_blocking(move || {
        let img = thumbs::exif_image(&head)?;
        let hash = hash_image(&img);
        let jpeg = (s3 && thumbs::sharp_enough(&img)).then(|| thumbs::encode_thumb(img)).flatten();
        Some((hash, jpeg))
    })
    .await
    .map_err(err)?;
    let Some((hash, jpeg)) = made else { return Ok(None) };
    if !now.is_empty() {
        if let Some(s) = store() {
            s.put(&profile_id, &root, &key, &now, size, &hash);
        }
        if let Some(jpeg) = jpeg {
            thumbs::seed(&profile_id, &root, &key, &now, size, &jpeg).await;
        }
    }
    Ok(Some(hash))
}

/// The folder's shared index, by name: `[etag, size, hash]` each (one request; a missing index
/// is normal and answers an empty one). The app uses the entries whose etag and size still match.
/// Never for this device's own files.
#[tauri::command]
pub async fn placeholders_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    root: String,
    prefix: String,
) -> Result<BTreeMap<String, Stamp>, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    if s.caps().local_paths {
        return Ok(BTreeMap::new());
    }
    Ok(read_index(&*s, &root, &prefix).await.map(|ix| ix.files).unwrap_or_default())
}

/// Adds these placeholders to the folder's shared index: read what is there now, merge, write it
/// back if anything changed. `present` (the whole listing, when it was all loaded) drops entries
/// of files that are gone.
#[tauri::command]
pub async fn placeholders_folder_save(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    root: String,
    prefix: String,
    known: Vec<Known>,
    present: Option<Vec<String>>,
) -> Result<(), String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    if s.caps().local_paths {
        return Ok(());
    }
    // a newer Kybl's format is left alone
    let Ok(mut ix) = read_index(&*s, &root, &prefix).await else { return Ok(()) };
    let before = ix.files.clone();
    let ours = known.into_iter().filter_map(|k| {
        let name = k.key.strip_prefix(&prefix)?.to_string();
        (!name.is_empty() && !name.contains('/')).then(|| (name, Stamp(bare(k.etag.as_deref().unwrap_or("")).to_string(), k.size, k.hash)))
    });
    let present: Option<HashSet<String>> = present.map(|p| p.into_iter().filter_map(|k| k.strip_prefix(&prefix).map(str::to_string)).collect());
    ix.merge(ours, present.as_ref());
    if ix.files == before {
        return Ok(());
    }
    if s.caps().folders == FolderMode::Real {
        // ".kybl/" may not exist yet on stores with real folders
        let _ = s.mkdir(&root, &format!("{prefix}.kybl/")).await;
    }
    let opts = WriteOpts { content_type: Some("application/json".into()), ..Default::default() };
    let never = Arc::new(AtomicBool::new(false));
    s.write(&root, &index_path(&prefix), WriteSource::Bytes(Bytes::from(ix.to_bytes())), opts, &|_, _| {}, &never)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The placeholder of a thumbnail made in the web view (HEIC photos, which only WebKit decodes):
/// worked out from that small JPEG and kept like any other.
#[tauri::command]
pub async fn placeholder_from_thumbnail(profile_id: String, root: String, key: String, etag: Option<String>, size: i64, jpeg: Vec<u8>) -> Option<String> {
    let hash = tokio::task::spawn_blocking(move || hash_jpeg(&jpeg)).await.ok().flatten()?;
    if let Some(s) = store() {
        s.put(&profile_id, &root, &key, etag.as_deref().unwrap_or(""), size, &hash);
    }
    Some(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn photo(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, 120])))
    }

    #[test]
    fn hashes_are_short_and_decode_with_the_photos_shape() {
        let h = hash_image(&photo(1600, 900));
        assert!(valid(&h), "{h}");
        assert!(h.len() <= 40, "{} chars", h.len());
        let bytes = B64.decode(&h).unwrap();
        let (w, hh, _) = thumbhash::thumb_hash_to_rgba(&bytes).unwrap();
        assert!(w > hh, "landscape stays landscape ({w}x{hh})");
        assert!(!valid("not base64!"));
        assert!(!valid("QUJD"));
    }

    fn mem_store() -> Store {
        Store::new(crate::db::open_in_memory(MIGRATIONS).unwrap())
    }

    #[test]
    fn the_local_index_answers_only_for_the_same_version() {
        let s = mem_store();
        s.put("p", "b", "a.jpg", "\"e1\"", 10, "hash1");
        assert_eq!(s.get("p", "b", "a.jpg", "e1", 10).as_deref(), Some("hash1"));
        assert_eq!(s.get("p", "b", "a.jpg", "\"e1\"", 10).as_deref(), Some("hash1"), "quotes don't matter");
        assert_eq!(s.get("p", "b", "a.jpg", "e2", 10), None, "another etag");
        assert_eq!(s.get("p", "b", "a.jpg", "e1", 11), None, "another size");
        assert_eq!(s.get("q", "b", "a.jpg", "e1", 10), None, "another connection");
        // a new version replaces the old row rather than adding one
        s.put("p", "b", "a.jpg", "e2", 12, "hash2");
        assert_eq!(s.get("p", "b", "a.jpg", "e1", 10), None);
        assert_eq!(s.get("p", "b", "a.jpg", "e2", 12).as_deref(), Some("hash2"));
        let n: i64 = s.0.lock().unwrap().query_row("SELECT COUNT(*) FROM hashes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        s.put("q", "b", "a.jpg", "e", 1, "hash3");
        s.forget_profile("p");
        assert_eq!(s.get("p", "b", "a.jpg", "e2", 12), None);
        assert!(s.get("q", "b", "a.jpg", "e", 1).is_some());
        s.clear();
        assert!(s.get("q", "b", "a.jpg", "e", 1).is_none());
    }

    #[test]
    fn the_folder_index_round_trips_compactly() {
        let h = hash_image(&photo(300, 400));
        let mut ix = FolderIndex::default();
        ix.merge([("IMG_1.jpg".to_string(), Stamp("e1".into(), 10, h.clone()))], None);
        let bytes = ix.to_bytes();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert_eq!(text, format!(r#"{{"v":1,"files":{{"IMG_1.jpg":["e1",10,"{h}"]}}}}"#));
        let back = FolderIndex::parse(&bytes).unwrap();
        assert_eq!(back.hash_of("IMG_1.jpg", "\"e1\"", 10), Some(h.as_str()));
        assert_eq!(back.hash_of("IMG_1.jpg", "e1", 11), None, "the file changed size");
        assert_eq!(back.hash_of("IMG_1.jpg", "e9", 10), None, "the file changed");
        assert_eq!(back.hash_of("IMG_2.jpg", "e1", 10), None);
    }

    #[test]
    fn broken_or_newer_indexes() {
        assert_eq!(FolderIndex::parse(b"not json").unwrap().files.len(), 0, "broken: replaced");
        assert!(FolderIndex::parse(br#"{"v":2,"files":{}}"#).is_err(), "newer: left alone");
        // entries with a bad hash are dropped, good ones kept
        let h = hash_image(&photo(50, 50));
        let raw = format!(r#"{{"v":1,"files":{{"a.jpg":["e",1,"{h}"],"b.jpg":["e",1,"!!"]}}}}"#);
        let ix = FolderIndex::parse(raw.as_bytes()).unwrap();
        assert_eq!(ix.files.keys().collect::<Vec<_>>(), ["a.jpg"]);
    }

    #[test]
    fn merging_keeps_the_other_devices_entries_and_drops_gone_files() {
        let (h1, h2, h3) = (hash_image(&photo(10, 20)), hash_image(&photo(20, 10)), hash_image(&photo(30, 30)));
        // another device wrote a.jpg and b.jpg
        let mut ix = FolderIndex::default();
        ix.merge([("a.jpg".to_string(), Stamp("ea".into(), 1, h1.clone())), ("b.jpg".to_string(), Stamp("eb".into(), 2, h2.clone()))], None);
        // we add c.jpg and have a newer a.jpg
        ix.merge([("c.jpg".to_string(), Stamp("ec".into(), 3, h3.clone())), ("a.jpg".to_string(), Stamp("ea2".into(), 5, h2.clone()))], None);
        assert_eq!(ix.files.len(), 3);
        assert_eq!(ix.hash_of("a.jpg", "ea2", 5), Some(h2.as_str()), "ours win");
        assert_eq!(ix.hash_of("b.jpg", "eb", 2), Some(h2.as_str()), "theirs kept");
        // with the whole listing: b.jpg was deleted
        let present: HashSet<String> = ["a.jpg", "c.jpg"].iter().map(|s| s.to_string()).collect();
        ix.merge([], Some(&present));
        assert_eq!(ix.files.keys().collect::<Vec<_>>(), ["a.jpg", "c.jpg"]);
        // invalid hashes never get in
        ix.merge([("d.jpg".to_string(), Stamp("e".into(), 1, "x".into()))], None);
        assert!(!ix.files.contains_key("d.jpg"));
    }

    #[test]
    fn uploads_get_a_placeholder_and_a_thumbnail() {
        let dir = std::env::temp_dir().join(format!("kybl-ph-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("pic.png");
        photo(1200, 800).save(&png).unwrap();
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, b"hello").unwrap();
        tauri::async_runtime::block_on(async {
            let p = prepare_upload(png.to_str().unwrap(), 1000).await.unwrap();
            assert!(valid(&p.hash));
            let jpeg = p.jpeg.unwrap();
            let t = image::load_from_memory(&jpeg).unwrap();
            assert_eq!((t.width(), t.height()), (360, 240));
            assert!(prepare_upload(txt.to_str().unwrap(), 5).await.is_none());
            // too big to decode: no placeholder rather than a memory spike
            assert!(prepare_upload(png.to_str().unwrap(), thumbs::MAX_FULL_DOWNLOAD as u64 + 1).await.is_none());
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
