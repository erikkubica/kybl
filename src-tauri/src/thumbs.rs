//! Thumbnails for the grid view, for every kind of connection.
//!
//! S3 cannot resize images, so thumbnails are made here:
//!  1. JPEG/TIFF photos: read only the first 256 KB of the object and use the thumbnail the camera
//!     embedded in the EXIF data (tiny download, instant).
//!  2. Otherwise, objects up to `MAX_FULL_DOWNLOAD` are downloaded and resized locally.
//!  Results are stored as small JPEGs in the app cache directory and reused on every later visit.
//!
//! Other connections go through [`Storage`]: a provider's own thumbnail when it makes them
//! (`caps.thumbnails` "remote"), else the same two steps over `Storage::read` (a ranged read for
//! the EXIF head where the store can, else one whole read up to the same limit).
//!
//! The web view loads them as plain images from the `thumb://` scheme (see [`protocol`]), so the
//! bytes never pass through JavaScript as base64 strings and the web view's own image cache
//! decides what stays in memory.

use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::SystemTime,
};

use image::{
    codecs::jpeg::JpegEncoder, metadata::Orientation, DynamicImage, ImageDecoder, ImageReader, Limits,
};
use percent_encoding::percent_decode_str;
use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder,
};
use tokio::sync::Semaphore;

use crate::state::{err, load_profiles, sdk_err, AppState};
use crate::storage::{self, registry::LOCAL_ID, Conn, ConnKind, Entry, Loc, Storage, ThumbMode};

const THUMB_PX: u32 = 360;
/// Embedded EXIF thumbnails smaller than this look blurry in the grid: fall back to the full image.
const MIN_EXIF_THUMB_PX: u32 = 200;
/// The largest embedded thumbnail taken in, per side, and the memory its decode may use.
const MAX_EXIF_THUMB_PX: u32 = 2048;
const MAX_EXIF_THUMB_ALLOC: u64 = 32 << 20;
/// Largest object downloaded whole to make a thumbnail. The web view uses the same limit
/// (`MAX_BYTES` in thumbs.ts), so it never asks for one that is bound to fail.
pub const MAX_FULL_DOWNLOAD: i64 = 40 * 1000 * 1000;
pub(crate) const HEAD_RANGE: usize = 256 * 1024;
/// Most memory one decoded image may take (about 8000 x 8000 RGBA). Bigger ones get no thumbnail
/// instead of a memory spike.
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;
/// Full-size decodes running at once. Each can take up to `MAX_DECODE_ALLOC`.
const DECODE_SLOTS: usize = 2;
/// The disk cache is trimmed back to `CACHE_KEEP` (oldest first) once it grows past `CACHE_MAX`.
const CACHE_MAX: u64 = 400 * 1024 * 1024;
const CACHE_KEEP: u64 = 300 * 1024 * 1024;
/// Kybl can run for weeks (in the tray): the cache is checked again after this many bytes of
/// new thumbnails, not only at start-up.
const TRIM_AFTER: u64 = 32 * 1024 * 1024;
/// Bytes of thumbnails written since the cache was last checked.
static WRITTEN: AtomicU64 = AtomicU64::new(0);
/// A check is running.
static TRIMMING: AtomicBool = AtomicBool::new(false);

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

static DIR: OnceLock<PathBuf> = OnceLock::new();

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(d) = DIR.get() {
        return Ok(d.clone());
    }
    let dir = app.path().app_cache_dir().map_err(err)?.join("thumbs");
    // thumbnails of private pictures: this account only
    crate::filecache::private_dir(&dir).map_err(err)?;
    Ok(DIR.get_or_init(|| dir).clone())
}

pub(crate) fn decode_slots() -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(DECODE_SLOTS))).clone()
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_alloc = Some(MAX_DECODE_ALLOC);
    l
}

pub(crate) fn encode(img: DynamicImage) -> Result<Vec<u8>, String> {
    // `thumbnail` averages pixels in one pass: far faster than a filtered resize on big photos
    let img = if img.width() > THUMB_PX || img.height() > THUMB_PX {
        img.thumbnail(THUMB_PX, THUMB_PX)
    } else {
        img
    };
    // JPEG has no alpha: flatten transparent images onto white
    let rgb = if img.color().has_alpha() {
        let mut rgba = img.into_rgba8();
        for p in rgba.pixels_mut() {
            let a = p[3] as u32;
            for c in &mut p.0[..3] {
                *c = ((*c as u32 * a + 255 * (255 - a)) / 255) as u8;
            }
        }
        DynamicImage::ImageRgba8(rgba).into_rgb8()
    } else {
        img.into_rgb8()
    };
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, 82)
        .encode_image(&rgb)
        .map_err(err)?;
    Ok(buf)
}

fn thumb_from_image_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    encode(decode_image(bytes)?)
}

/// Decodes a whole image (within the memory cap), turned upright.
pub(crate) fn decode_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(err)?;
    reader.limits(limits());
    let mut decoder = reader.into_decoder().map_err(err)?;
    // `into_decoder` only checks dimensions against the limits; the allocation is checked here
    if decoder.total_bytes() > MAX_DECODE_ALLOC {
        return Err("Image too large for a thumbnail".into());
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(err)?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// The JPEG thumbnail a camera embeds in the EXIF block, plus the photo's orientation.
fn exif_thumbnail(head: &[u8]) -> Option<(Vec<u8>, u8)> {
    let exif = exif::Reader::new()
        .read_from_container(&mut Cursor::new(head))
        .ok()?;
    let off = exif
        .get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let len = exif
        .get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let buf = exif.buf();
    if len == 0 || off.checked_add(len)? > buf.len() {
        return None;
    }
    let orientation = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .unwrap_or(1) as u8;
    Some((buf[off..off + len].to_vec(), orientation))
}

fn thumb_from_exif(head: &[u8]) -> Option<Vec<u8>> {
    exif_image(head).filter(sharp_enough).and_then(|img| encode(img).ok())
}

/// The camera's embedded thumbnail, decoded and turned upright, however small.
pub(crate) fn exif_image(head: &[u8]) -> Option<DynamicImage> {
    let (bytes, orientation) = exif_thumbnail(head)?;
    // camera thumbnails are small (1920 px at most): a bigger "thumbnail" is a crafted file, and
    // is refused by its header before anything is allocated
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Jpeg);
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_EXIF_THUMB_PX);
    l.max_image_height = Some(MAX_EXIF_THUMB_PX);
    l.max_alloc = Some(MAX_EXIF_THUMB_ALLOC);
    reader.limits(l);
    let decoder = reader.into_decoder().ok()?;
    if decoder.total_bytes() > MAX_EXIF_THUMB_ALLOC {
        return None;
    }
    let mut img = DynamicImage::from_decoder(decoder).ok()?;
    if let Some(o) = Orientation::from_exif(orientation) {
        img.apply_orientation(o);
    }
    Some(img)
}

/// Big enough to stand in for the photo in the grid (see `MIN_EXIF_THUMB_PX`).
pub(crate) fn sharp_enough(img: &DynamicImage) -> bool {
    img.width().max(img.height()) >= MIN_EXIF_THUMB_PX
}

/// What kind of connection a profile is, without opening it (the cache is looked at first).
fn kind_of<R: Runtime>(app: &AppHandle<R>, profile_id: &str) -> ConnKind {
    static KINDS: OnceLock<Mutex<HashMap<String, ConnKind>>> = OnceLock::new();
    if profile_id == LOCAL_ID {
        return ConnKind::Local;
    }
    let kinds = KINDS.get_or_init(Default::default);
    if let Some(k) = kinds.lock().unwrap().get(profile_id) {
        return *k;
    }
    let found = load_profiles(app).ok().and_then(|ps| ps.into_iter().find(|p| p.id == profile_id)).map(|p| p.kind);
    match found {
        Some(k) => {
            kinds.lock().unwrap().insert(profile_id.to_string(), k);
            k
        }
        None => ConnKind::S3,
    }
}

/// The cache file of one file version. S3 keeps the name it always had, so thumbnails made
/// before other kinds existed stay valid; other kinds add theirs.
fn cache_name(kind: ConnKind, profile_id: &str, bucket: &str, key: &str, etag: &str, size: i64) -> String {
    let id = match kind {
        ConnKind::S3 => format!("{profile_id}|{bucket}|{key}|{etag}|{size}"),
        k => format!("{k:?}|{profile_id}|{bucket}|{key}|{etag}|{size}"),
    };
    format!("{:016x}.jpg", fnv1a(&id))
}

/// One connection's folder in the cache (`<cache>/thumbs/<hash of its id>`), so a deleted
/// connection's thumbnails can go with it (B5-6).
fn profile_dir(dir: &Path, profile_id: &str) -> PathBuf {
    dir.join(format!("{:016x}", fnv1a(profile_id)))
}

/// Where the thumbnail of one file version is kept, if it is there. One an older Kybl kept at
/// the top of the cache moves into its connection's folder, so it stays valid.
fn find_cached(dir: &Path, kind: ConnKind, profile_id: &str, bucket: &str, key: &str, etag: &str, size: i64) -> Option<PathBuf> {
    let name = cache_name(kind, profile_id, bucket, key, etag, size);
    let path = profile_dir(dir, profile_id).join(&name);
    if path.is_file() {
        return Some(path);
    }
    let old = dir.join(&name);
    if !old.is_file() {
        return None;
    }
    let moved = path.parent().is_some_and(|p| crate::filecache::private_dir(p).is_ok()) && std::fs::rename(&old, &path).is_ok();
    Some(if moved { path } else { old })
}

/// Where a new thumbnail of one file version goes.
fn new_path(dir: &Path, kind: ConnKind, profile_id: &str, bucket: &str, key: &str, etag: &str, size: i64) -> PathBuf {
    profile_dir(dir, profile_id).join(cache_name(kind, profile_id, bucket, key, etag, size))
}

/// A connection was deleted: its thumbnails go. `kind`: what it was (older thumbnails at the top
/// of the cache are found through the placeholder index, which names its files).
pub async fn forget_profile<R: Runtime>(app: &AppHandle<R>, profile_id: &str, kind: Option<ConnKind>) {
    let Ok(dir) = cache_dir(app) else { return };
    let old: Vec<PathBuf> = kind
        .map(|k| {
            crate::placeholders::files_of(profile_id)
                .into_iter()
                .flat_map(|(root, key, etag, size)| {
                    [etag.clone(), format!("\"{etag}\"")].map(|e| dir.join(cache_name(k, profile_id, &root, &key, &e, size)))
                })
                .collect()
        })
        .unwrap_or_default();
    let mine = profile_dir(&dir, profile_id);
    let _ = tokio::task::spawn_blocking(move || {
        let _ = std::fs::remove_dir_all(mine);
        for p in old {
            let _ = std::fs::remove_file(p);
        }
    })
    .await;
}

async fn save(path: &Path, jpeg: &[u8]) {
    // a temporary name of its own: the same thumbnail can be made twice at once
    // (made private to this account)
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let (t, bytes) = (tmp.clone(), jpeg.to_vec());
    let wrote = tokio::task::spawn_blocking(move || {
        crate::filecache::write_private(&t, &bytes).or_else(|e| {
            // its folder isn't there (yet, or any more: a cache cleaner removed the cache while
            // Kybl ran): made again, once (B5-2)
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e);
            }
            crate::filecache::private_dir(t.parent().ok_or(e)?)?;
            crate::filecache::write_private(&t, &bytes)
        })
    })
    .await
    .is_ok_and(|r| r.is_ok());
    if !wrote || tokio::fs::rename(&tmp, path).await.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return;
    }
    let len = jpeg.len() as u64;
    if WRITTEN.fetch_add(len, Ordering::Relaxed) + len >= TRIM_AFTER && !TRIMMING.swap(true, Ordering::SeqCst) {
        WRITTEN.store(0, Ordering::Relaxed);
        if let Some(dir) = DIR.get().cloned().or_else(|| path.parent().map(Path::to_path_buf)) {
            tauri::async_runtime::spawn(async move {
                let _ = tokio::task::spawn_blocking(move || trim(&dir, CACHE_MAX, CACHE_KEEP)).await;
                TRIMMING.store(false, Ordering::SeqCst);
            });
        } else {
            TRIMMING.store(false, Ordering::SeqCst);
        }
    }
}

/// The cached thumbnail of one file version, if it was made before.
pub(crate) fn cached_path<R: Runtime>(app: &AppHandle<R>, profile_id: &str, bucket: &str, key: &str, etag: &str, size: i64) -> Option<PathBuf> {
    find_cached(&cache_dir(app).ok()?, kind_of(app, profile_id), profile_id, bucket, key, etag, size)
}

/// Puts a thumbnail made elsewhere (from a photo just uploaded, see placeholders.rs) into the
/// cache, so the grid shows it without downloading anything. S3 only, like uploads with one.
/// The thumbnail-sized JPEG of an upright camera thumbnail (for `seed`).
pub(crate) fn encode_thumb(img: DynamicImage) -> Option<Vec<u8>> {
    encode(img).ok()
}

pub(crate) async fn seed(profile_id: &str, bucket: &str, key: &str, etag: &str, size: i64, jpeg: &[u8]) {
    // the folder is known once the app has started (start-up pruning opens it)
    if let Some(dir) = DIR.get() {
        save(&new_path(dir, ConnKind::S3, profile_id, bucket, key, etag, size), jpeg).await;
    }
}

/// The thumbnail JPEG for an object, from the disk cache or freshly made. Every thumbnail also
/// leaves its ThumbHash placeholder in the local index (placeholders.rs), including ones cached
/// before placeholders existed.
async fn thumbnail<R: Runtime>(
    app: &AppHandle<R>,
    profile_id: &str,
    bucket: &str,
    key: &str,
    size: i64,
    etag: &str,
) -> Result<Vec<u8>, String> {
    let jpeg = make_thumbnail(app, profile_id, bucket, key, size, etag).await?;
    crate::placeholders::note_thumbnail(profile_id, bucket, key, etag, size, &jpeg).await;
    Ok(jpeg)
}

async fn make_thumbnail<R: Runtime>(
    app: &AppHandle<R>,
    profile_id: &str,
    bucket: &str,
    key: &str,
    size: i64,
    etag: &str,
) -> Result<Vec<u8>, String> {
    let kind = kind_of(app, profile_id);
    let dir = cache_dir(app)?;
    if let Some(cached) = find_cached(&dir, kind, profile_id, bucket, key, etag, size)
        && let Ok(bytes) = tokio::fs::read(&cached).await
    {
        return Ok(bytes);
    }
    let path = new_path(&dir, kind, profile_id, bucket, key, etag, size);

    // the whole photo is already in the file cache (opened in Quick Look or the phone's details screen):
    // made from those bytes, with no request
    if !etag.is_empty()
        && (0..=MAX_FULL_DOWNLOAD).contains(&size)
        && let Some(cache) = crate::filecache::get(app)
        && cache.has_any(profile_id, bucket, key)
    {
        let id = crate::filecache::Ident::new(Some(etag), size as u64, None);
        let (p, b, k) = (profile_id.to_string(), bucket.to_string(), key.to_string());
        // a full decode like any other (a grid of photos opened before asks for all at once):
        // one of the few decode places, taken before the photo is even read into memory
        let _decode = decode_slots().acquire_owned().await.map_err(err)?;
        if let Ok(Some(bytes)) = tokio::task::spawn_blocking(move || cache.read(&p, &b, &k, &id)).await
            && let Ok(Ok(jpeg)) = tokio::task::spawn_blocking(move || thumb_from_image_bytes(&bytes)).await
        {
            save(&path, &jpeg).await;
            return Ok(jpeg);
        }
    }

    // "Wi-Fi only" also covers thumbnails: cached ones still show, new ones wait for Wi-Fi.
    // This device's own files need no network.
    if kind != ConnKind::Local && crate::tuning::wifi_only() && crate::platform::on_metered_network() {
        return Err("Previews wait for Wi-Fi".into());
    }
    let state = app.state::<AppState>();
    let _permit = state.thumb_slots.clone().acquire_owned().await.map_err(err)?;
    // another request may have produced it while we waited
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return Ok(bytes);
    }
    let client = match storage::connect(app, &state, profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => {
            let jpeg = generic_thumbnail(&*s, bucket, key, size, etag).await?;
            save(&path, &jpeg).await;
            return Ok(jpeg);
        }
    };
    let lower = key.to_lowercase();
    let maybe_exif = [".jpg", ".jpeg", ".tif", ".tiff"].iter().any(|e| lower.ends_with(e));

    let mut result: Option<Vec<u8>> = None;
    if maybe_exif {
        let mut out = client
            .get_object()
            .bucket(bucket)
            .key(key)
            .range(format!("bytes=0-{}", HEAD_RANGE - 1))
            .send()
            .await
            .map_err(sdk_err)?;
        let mut head: Vec<u8> = Vec::with_capacity(HEAD_RANGE);
        while let Some(chunk) = out.body.try_next().await.map_err(err)? {
            head.extend_from_slice(&chunk);
            if head.len() >= HEAD_RANGE {
                break;
            }
        }
        result = tokio::task::spawn_blocking(move || thumb_from_exif(&head))
            .await
            .map_err(err)?;
    }

    if result.is_none() {
        if size > MAX_FULL_DOWNLOAD {
            return Err("Image too large for a thumbnail".into());
        }
        let _decode = decode_slots().acquire_owned().await.map_err(err)?;
        let out = client
            .get_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(sdk_err)?;
        if out.content_length().unwrap_or(0) > MAX_FULL_DOWNLOAD {
            return Err("Image too large for a thumbnail".into());
        }
        let bytes = out.body.collect().await.map_err(err)?.into_bytes();
        result = Some(
            tokio::task::spawn_blocking(move || thumb_from_image_bytes(&bytes))
                .await
                .map_err(err)??,
        );
    }

    let jpeg = result.ok_or_else(|| "No thumbnail".to_string())?;
    save(&path, &jpeg).await;
    Ok(jpeg)
}

pub(crate) fn may_have_exif(key: &str) -> bool {
    let lower = key.to_lowercase();
    [".jpg", ".jpeg", ".tif", ".tiff"].iter().any(|e| lower.ends_with(e))
}

/// The first `HEAD_RANGE` bytes. Stores that can't read a range send the whole file; the rest of
/// it is dropped (which stops the read) once the head is in.
async fn read_head(s: &dyn Storage, root: &str, key: &str) -> Result<Vec<u8>, String> {
    read_first(s, root, key, HEAD_RANGE).await.map(|(head, _)| head)
}

/// The first `n` bytes and the version (ETag) they came from; the same rules as `read_head`.
pub(crate) async fn read_first(s: &dyn Storage, root: &str, key: &str, n: usize) -> Result<(Vec<u8>, Option<String>), String> {
    use futures_util::StreamExt;
    let mut r = s.read(root, key, Some(0..n as u64), None).await?;
    let etag = r.etag.clone();
    let mut head: Vec<u8> = Vec::with_capacity(n);
    while let Some(chunk) = r.body.next().await {
        head.extend_from_slice(&chunk.map_err(err)?);
        if head.len() >= n {
            head.truncate(n);
            break;
        }
    }
    Ok((head, etag))
}

async fn read_all(s: &dyn Storage, root: &str, key: &str) -> Result<Vec<u8>, String> {
    let r = s.read(root, key, None, None).await?;
    Ok(r.collect(MAX_FULL_DOWNLOAD as u64).await.map_err(|_| "Image too large for a thumbnail".to_string())?)
}

/// A thumbnail for a file of any connection but S3 (see the module docs).
async fn generic_thumbnail(s: &dyn Storage, root: &str, key: &str, size: i64, etag: &str) -> Result<Vec<u8>, String> {
    let caps = s.caps();
    if matches!(caps.thumbnails, ThumbMode::Remote | ThumbMode::LocalRemote) {
        let e = Entry { key: key.to_string(), size, etag: (!etag.is_empty()).then(|| etag.to_string()), ..Default::default() };
        match s.thumbnail(&Loc::new(root, key), &e).await {
            // the provider's size and format vary: made into the grid's own small JPEG
            Ok(Some(bytes)) => return tokio::task::spawn_blocking(move || thumb_from_image_bytes(&bytes)).await.map_err(err)?,
            _ if caps.thumbnails == ThumbMode::LocalRemote => {}
            Ok(None) => return Err("No thumbnail".into()),
            Err(e) => return Err(e.into()),
        }
    }

    let small = size <= MAX_FULL_DOWNLOAD;
    // read once from a store that would send the whole file for the EXIF head anyway
    let mut whole: Option<Vec<u8>> = None;
    if may_have_exif(key) {
        let head = if !caps.range_read && small {
            let all = read_all(s, root, key).await?;
            let head = all[..all.len().min(HEAD_RANGE)].to_vec();
            whole = Some(all);
            head
        } else {
            read_head(s, root, key).await?
        };
        if let Some(t) = tokio::task::spawn_blocking(move || thumb_from_exif(&head)).await.map_err(err)? {
            return Ok(t);
        }
    }
    if !small {
        return Err("Image too large for a thumbnail".into());
    }
    let _decode = decode_slots().acquire_owned().await.map_err(err)?;
    let bytes = match whole {
        Some(b) => b,
        None => read_all(s, root, key).await?,
    };
    tokio::task::spawn_blocking(move || thumb_from_image_bytes(&bytes)).await.map_err(err)?
}

/// Serves `thumb://localhost/<id>` (`http://thumb.localhost/<id>` on Windows), where `<id>` is the
/// percent-encoded `profileId \n bucket \n size \n etag \n key` built by thumbs.ts. Answers with
/// the JPEG, or 404 when no thumbnail can be made.
pub fn protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let id = percent_decode_str(request.uri().path().trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();
    tauri::async_runtime::spawn(async move {
        let Some((profile_id, bucket, size, etag, key)) = parse_id(&id) else {
            return responder.respond(reply(StatusCode::BAD_REQUEST, Vec::new()));
        };
        match thumbnail(&app, profile_id, bucket, key, size, etag).await {
            Ok(jpeg) => responder.respond(reply(StatusCode::OK, jpeg)),
            Err(e) => responder.respond(reply(StatusCode::NOT_FOUND, e.into_bytes())),
        }
    });
}

/// `profileId \n bucket \n size \n etag \n key`; the key goes last so it may contain anything.
fn parse_id(id: &str) -> Option<(&str, &str, i64, &str, &str)> {
    let mut parts = id.splitn(5, '\n');
    let (profile_id, bucket, size, etag, key) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    Some((profile_id, bucket, size.parse().unwrap_or(0), etag, key))
}

fn reply(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    let ok = status == StatusCode::OK;
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, if ok { "image/jpeg" } else { "text/plain" })
        // the URL names the exact object version (etag + size), so a thumbnail never goes stale
        .header(header::CACHE_CONTROL, if ok { "max-age=31536000, immutable" } else { "no-store" })
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .expect("valid response")
}

/// Keeps the disk cache bounded: once it is over `CACHE_MAX`, the oldest thumbnails are removed
/// until it is back under `CACHE_KEEP`. Runs at start-up, and again as new thumbnails add up
/// (see `save`).
pub async fn prune_cache<R: Runtime>(app: AppHandle<R>) {
    let Ok(dir) = cache_dir(&app) else { return };
    let _ = tokio::task::spawn_blocking(move || trim(&dir, CACHE_MAX, CACHE_KEEP)).await;
}

/// Removes the oldest files in `dir` until it holds `keep` bytes or less, once it holds more than
/// `max`.
fn trim(dir: &Path, max: u64, keep: u64) {
    let mut files = cache_files(dir);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= max {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= keep {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
    // connection folders left empty (only removes empty ones)
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let _ = std::fs::remove_dir(e.path());
        }
    }
}

/// Every file of the cache: at its top (older Kybl) and in the connections' folders, with when
/// it was last written and its size.
fn cache_files(dir: &Path) -> Vec<(SystemTime, u64, PathBuf)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let Ok(m) = e.metadata() else { continue };
        if m.is_dir() {
            if let Ok(sub) = std::fs::read_dir(e.path()) {
                for f in sub.flatten() {
                    if let Ok(fm) = f.metadata()
                        && fm.is_file()
                    {
                        out.push((fm.modified().unwrap_or(SystemTime::UNIX_EPOCH), fm.len(), f.path()));
                    }
                }
            }
        } else if m.is_file() {
            out.push((m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len(), e.path()));
        }
    }
    out
}

/// Deletes all cached thumbnails. Returns the number of bytes freed.
#[tauri::command]
pub async fn clear_thumbnail_cache(app: AppHandle) -> Result<u64, String> {
    clear(&app).await
}

/// Bytes of cached thumbnails (for Settings).
pub async fn usage<R: Runtime>(app: &AppHandle<R>) -> u64 {
    let Ok(dir) = cache_dir(app) else { return 0 };
    tokio::task::spawn_blocking(move || cache_files(&dir).iter().map(|f| f.1).sum()).await.unwrap_or(0)
}

/// Deletes all cached thumbnails. Returns the number of bytes freed.
pub async fn clear<R: Runtime>(app: &AppHandle<R>) -> Result<u64, String> {
    let dir = cache_dir(app)?;
    tokio::task::spawn_blocking(move || {
        let mut freed = 0u64;
        for (_, len, path) in cache_files(&dir) {
            if std::fs::remove_file(&path).is_ok() {
                freed += len;
            }
        }
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let _ = std::fs::remove_dir(e.path());
            }
        }
        freed
    })
    .await
    .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{build_client, Profile};
    use image::{ImageFormat, RgbImage, RgbaImage};
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn trimming_removes_the_oldest_thumbnails_down_to_the_keep_size() {
        let dir = std::env::temp_dir().join(format!("kybl-thumb-trim-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let now = SystemTime::now();
        for i in 0..10u64 {
            let p = dir.join(format!("{i}.jpg"));
            std::fs::write(&p, [0u8; 100]).unwrap();
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(now - std::time::Duration::from_secs(100 - i)).unwrap();
        }
        trim(&dir, 2000, 500);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 10, "under the limit: nothing goes");
        trim(&dir, 900, 500);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["5.jpg", "6.jpg", "7.jpg", "8.jpg", "9.jpg"], "the newest stay");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn saving_a_thumbnail_twice_at_once_leaves_one_file() {
        let dir = std::env::temp_dir().join(format!("kybl-thumb-save-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.jpg");
        tokio::join!(save(&p, b"one"), save(&p, b"two"), save(&p, b"three"));
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["a.jpg"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Thumbnails live in their connection's folder (so a deletion can remove them), older ones
    /// move there when next used, a removed cache folder is made again, and trimming counts
    /// every folder (B5-2, B5-6).
    #[tokio::test]
    async fn thumbnails_are_kept_per_connection_and_survive_a_removed_folder() {
        let dir = std::env::temp_dir().join(format!("kybl-thumb-dirs-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        // an older Kybl's thumbnail, at the top
        let old = dir.join(cache_name(ConnKind::S3, "p1", "b", "a.jpg", "e", 5));
        std::fs::write(&old, b"old").unwrap();
        let found = find_cached(&dir, ConnKind::S3, "p1", "b", "a.jpg", "e", 5).unwrap();
        assert_eq!(found, new_path(&dir, ConnKind::S3, "p1", "b", "a.jpg", "e", 5));
        assert!(!old.exists() && std::fs::read(&found).unwrap() == b"old", "moved into its connection's folder");
        // the whole cache removed while running: the next save makes it again
        std::fs::remove_dir_all(&dir).unwrap();
        let p2 = new_path(&dir, ConnKind::S3, "p2", "b", "c.jpg", "e", 7);
        save(&p2, b"new").await;
        assert_eq!(std::fs::read(&p2).unwrap(), b"new");
        assert!(find_cached(&dir, ConnKind::S3, "p1", "b", "a.jpg", "e", 5).is_none());
        // one connection's folder goes as a whole
        assert_eq!(cache_files(&dir).len(), 1);
        std::fs::remove_dir_all(profile_dir(&dir, "p2")).unwrap();
        assert!(cache_files(&dir).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_unpack_with_any_key() {
        assert_eq!(parse_id("p\nb\n42\ne\nphotos/a\nb.jpg"), Some(("p", "b", 42, "e", "photos/a\nb.jpg")));
        assert_eq!(parse_id("p\nb\n42\ne"), None);
    }

    fn encoded(img: DynamicImage, fmt: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, fmt).unwrap();
        out.into_inner()
    }

    #[test]
    fn s3_cache_names_stay_the_same_and_other_kinds_differ() {
        let s3 = cache_name(ConnKind::S3, "p", "b", "k.jpg", "e", 5);
        assert_eq!(s3, format!("{:016x}.jpg", fnv1a("p|b|k.jpg|e|5")));
        assert_ne!(cache_name(ConnKind::Local, "p", "b", "k.jpg", "e", 5), s3);
        assert_ne!(cache_name(ConnKind::Local, "p", "b", "k.jpg", "e", 6), cache_name(ConnKind::Local, "p", "b", "k.jpg", "e", 5));
        assert_ne!(cache_name(ConnKind::Local, "p", "b", "k.jpg", "f", 5), cache_name(ConnKind::Local, "p", "b", "k.jpg", "e", 5));
    }

    /// A JPEG of `main` with an EXIF block that carries `thumb` as its embedded thumbnail.
    fn jpeg_with_exif(main: DynamicImage, thumb: DynamicImage) -> Vec<u8> {
        let mut t = Cursor::new(Vec::new());
        thumb.write_with_encoder(JpegEncoder::new_with_quality(&mut t, 40)).unwrap();
        let t = t.into_inner();
        // little-endian TIFF: IFD0 (orientation 1) at 8, IFD1 (thumbnail offset + length) at 26
        let mut tiff: Vec<u8> = b"II\x2a\x00".to_vec();
        tiff.extend(8u32.to_le_bytes());
        tiff.extend(1u16.to_le_bytes());
        tiff.extend([0x12, 0x01, 3, 0]);
        tiff.extend(1u32.to_le_bytes());
        tiff.extend([1, 0, 0, 0]);
        tiff.extend(26u32.to_le_bytes());
        tiff.extend(2u16.to_le_bytes());
        for (tag, v) in [(0x0201u16, 56u32), (0x0202, t.len() as u32)] {
            tiff.extend(tag.to_le_bytes());
            tiff.extend(4u16.to_le_bytes());
            tiff.extend(1u32.to_le_bytes());
            tiff.extend(v.to_le_bytes());
        }
        tiff.extend(0u32.to_le_bytes());
        assert_eq!(tiff.len(), 56);
        tiff.extend(&t);
        let main = encoded(main, ImageFormat::Jpeg);
        let mut out = vec![0xff, 0xd8, 0xff, 0xe1];
        out.extend(((tiff.len() + 8) as u16).to_be_bytes());
        out.extend(b"Exif\0\0");
        out.extend(tiff);
        out.extend(&main[2..]);
        out
    }

    fn dims(jpeg: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn other_connections_get_thumbnails_through_storage() {
        use crate::storage::media::test_store::MemStore;
        let portrait = DynamicImage::ImageRgb8(RgbImage::from_fn(900, 1600, |_, y| image::Rgb([y as u8, 20, 90])));
        let landscape = DynamicImage::ImageRgb8(RgbImage::from_fn(320, 240, |x, _| image::Rgb([x as u8, 200, 30])));
        let exif_jpg = jpeg_with_exif(portrait.clone(), landscape);
        let plain_jpg = encoded(portrait, ImageFormat::Jpeg);
        tauri::async_runtime::block_on(async {
            // a store with ranges: only the head of a (huge) photo is read, the EXIF thumbnail used
            let s = MemStore::new(true).with("big.jpg", exif_jpg.clone());
            let t = generic_thumbnail(&s, "", "big.jpg", 100 * MAX_FULL_DOWNLOAD, "e").await.unwrap();
            assert_eq!(dims(&t), (320, 240));
            assert_eq!(s.reads.lock().unwrap().as_slice(), &[Some(0..HEAD_RANGE as u64)]);

            // without ranges: one whole read serves the EXIF try and the full decode
            let s = MemStore::new(false).with("a.jpg", exif_jpg.clone()).with("b.jpg", plain_jpg.clone());
            let t = generic_thumbnail(&s, "", "a.jpg", exif_jpg.len() as i64, "e").await.unwrap();
            assert_eq!(dims(&t), (320, 240));
            let t = generic_thumbnail(&s, "", "b.jpg", plain_jpg.len() as i64, "e").await.unwrap();
            assert_eq!(dims(&t), (203, 360));
            assert_eq!(s.reads.lock().unwrap().as_slice(), &[None, None]);

            // too big without an EXIF thumbnail: refused after the head, nothing more read
            let s = MemStore::new(true).with("huge.jpg", plain_jpg.clone());
            assert!(generic_thumbnail(&s, "", "huge.jpg", MAX_FULL_DOWNLOAD + 1, "e").await.is_err());
            assert_eq!(s.reads.lock().unwrap().len(), 1);
            let s = MemStore::new(true).with("huge.png", plain_jpg.clone());
            assert!(generic_thumbnail(&s, "", "huge.png", MAX_FULL_DOWNLOAD + 1, "e").await.is_err());
            assert!(s.reads.lock().unwrap().is_empty());

            // the provider's own thumbnail, made into the grid's JPEG; nothing downloaded
            let mut s = MemStore::new(true).with("c.png", plain_jpg.clone());
            s.caps.thumbnails = ThumbMode::LocalRemote;
            s.remote_thumb = Some(encoded(DynamicImage::ImageRgba8(RgbaImage::new(800, 400)), ImageFormat::Png));
            let t = generic_thumbnail(&s, "", "c.png", 10, "e").await.unwrap();
            assert_eq!(dims(&t), (360, 180));
            assert!(s.reads.lock().unwrap().is_empty());
            // none offered: made here instead, unless the provider is the only source
            s.remote_thumb = None;
            assert!(generic_thumbnail(&s, "", "c.png", plain_jpg.len() as i64, "e").await.is_ok());
            s.caps.thumbnails = ThumbMode::Remote;
            assert!(generic_thumbnail(&s, "", "c.png", plain_jpg.len() as i64, "e").await.is_err());
        });
    }

    #[test]
    fn local_files_get_thumbnails() {
        use crate::storage::{local::LocalBackend, RootKind};
        let dir = std::env::temp_dir().join(format!("kybl-thumbs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = encoded(DynamicImage::ImageRgba8(RgbaImage::from_fn(1600, 900, |x, _| image::Rgba([x as u8, 80, 160, 128]))), ImageFormat::Png);
        std::fs::write(dir.join("pic.png"), &png).unwrap();
        let b = LocalBackend::with_roots(vec![("T".into(), RootKind::Folder, dir.clone())], false);
        tauri::async_runtime::block_on(async {
            let root = b.roots().await.unwrap()[0].id.clone();
            let t = generic_thumbnail(&b, &root, "pic.png", png.len() as i64, "e").await.unwrap();
            assert_eq!(dims(&t), (360, 203));
            assert!(generic_thumbnail(&b, &root, "missing.png", 10, "e").await.is_err());
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decode_is_capped() {
        // 9000 x 9000 RGBA would need ~324 MB: refused instead of allocated
        let huge = encoded(DynamicImage::ImageRgba8(RgbaImage::new(9000, 9000)), ImageFormat::Png);
        assert!(thumb_from_image_bytes(&huge).is_err());
    }

    /// Needs the throwaway S3 server (see the sync tests).
    #[test]
    fn thumbnails_come_from_s3_small_and_cached() {
        let Ok(endpoint) = std::env::var("KYBL_TEST_ENDPOINT") else { return };
        let app = mock_builder().manage(AppState::default()).build(mock_context(noop_assets())).unwrap();
        let p = Profile {
            id: "thumb-test".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
            ..Default::default()
        };
        let client = build_client(&p, "testsecret");
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            h.state::<AppState>().clients.lock().await.insert(p.id.clone(), client.clone());
            let base = format!("th-{}/", uuid::Uuid::new_v4());
            let png = encoded(DynamicImage::ImageRgba8(RgbaImage::from_fn(1600, 900, |x, _| image::Rgba([x as u8, 80, 160, 128]))), ImageFormat::Png);
            let jpg = encoded(DynamicImage::ImageRgb8(RgbImage::from_fn(900, 1600, |_, y| image::Rgb([y as u8, 20, 90]))), ImageFormat::Jpeg);
            for (name, bytes) in [("a.png", &png), ("b.jpg", &jpg)] {
                client
                    .put_object()
                    .bucket("testbucket")
                    .key(format!("{base}{name}"))
                    .body(aws_sdk_s3::primitives::ByteStream::from(bytes.clone()))
                    .send()
                    .await
                    .unwrap();
                let key = format!("{base}{name}");
                let t = thumbnail(&h, &p.id, "testbucket", &key, bytes.len() as i64, "e1").await.unwrap();
                let img = image::load_from_memory_with_format(&t, ImageFormat::Jpeg).unwrap();
                assert_eq!(img.width().max(img.height()), THUMB_PX, "{name} scaled to fit");
                // a second request is answered from the disk cache, even with the object gone
                client.delete_object().bucket("testbucket").key(&key).send().await.unwrap();
                assert_eq!(thumbnail(&h, &p.id, "testbucket", &key, bytes.len() as i64, "e1").await.unwrap(), t);
            }
            let missing = thumbnail(&h, &p.id, "testbucket", &format!("{base}nope.png"), 10, "x").await;
            assert!(missing.is_err());
        });
    }
}
