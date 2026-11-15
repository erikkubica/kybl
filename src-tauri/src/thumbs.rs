//! Thumbnails for the grid view.
//!
//! S3 cannot resize images, so thumbnails are made here:
//!  1. JPEG/TIFF photos: read only the first 256 KB of the object and use the thumbnail the camera
//!     embedded in the EXIF data (tiny download, instant).
//!  2. Otherwise, objects up to `MAX_FULL_DOWNLOAD` are downloaded and resized locally.
//!  Results are stored as small JPEGs in the app cache directory and reused on every later visit.
//!
//! The web view loads them as plain images from the `thumb://` scheme (see [`protocol`]), so the
//! bytes never pass through JavaScript as base64 strings and the web view's own image cache
//! decides what stays in memory.

use std::{
    io::Cursor,
    path::PathBuf,
    sync::{Arc, OnceLock},
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

use crate::state::{client_for, err, sdk_err, AppState};

const THUMB_PX: u32 = 360;
/// Embedded EXIF thumbnails smaller than this look blurry in the grid: fall back to the full image.
const MIN_EXIF_THUMB_PX: u32 = 200;
/// Largest object downloaded whole to make a thumbnail. The web view uses the same limit
/// (`MAX_BYTES` in thumbs.ts), so it never asks for one that is bound to fail.
pub const MAX_FULL_DOWNLOAD: i64 = 40 * 1000 * 1000;
const HEAD_RANGE: usize = 256 * 1024;
/// Most memory one decoded image may take (about 8000 x 8000 RGBA). Bigger ones get no thumbnail
/// instead of a memory spike.
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;
/// Full-size decodes running at once. Each can take up to `MAX_DECODE_ALLOC`.
const DECODE_SLOTS: usize = 2;
/// The disk cache is trimmed back to `CACHE_KEEP` (oldest first) once it grows past `CACHE_MAX`.
const CACHE_MAX: u64 = 400 * 1024 * 1024;
const CACHE_KEEP: u64 = 300 * 1024 * 1024;

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    if let Some(d) = DIR.get() {
        return Ok(d.clone());
    }
    let dir = app.path().app_cache_dir().map_err(err)?.join("thumbs");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(DIR.get_or_init(|| dir).clone())
}

fn decode_slots() -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(DECODE_SLOTS))).clone()
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_alloc = Some(MAX_DECODE_ALLOC);
    l
}

fn encode(img: DynamicImage) -> Result<Vec<u8>, String> {
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
    encode(img)
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
    let (bytes, orientation) = exif_thumbnail(head)?;
    let mut img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).ok()?;
    if img.width().max(img.height()) < MIN_EXIF_THUMB_PX {
        return None;
    }
    if let Some(o) = Orientation::from_exif(orientation) {
        img.apply_orientation(o);
    }
    encode(img).ok()
}

/// The thumbnail JPEG for an object, from the disk cache or freshly made.
async fn thumbnail<R: Runtime>(
    app: &AppHandle<R>,
    profile_id: &str,
    bucket: &str,
    key: &str,
    size: i64,
    etag: &str,
) -> Result<Vec<u8>, String> {
    let name = format!("{:016x}.jpg", fnv1a(&format!("{profile_id}|{bucket}|{key}|{etag}|{size}")));
    let path = cache_dir(app)?.join(&name);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return Ok(bytes);
    }

    let state = app.state::<AppState>();
    let _permit = state.thumb_slots.clone().acquire_owned().await.map_err(err)?;
    // another request may have produced it while we waited
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return Ok(bytes);
    }
    let client = client_for(app, &state, profile_id).await?;
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
    let tmp = path.with_extension("tmp");
    if tokio::fs::write(&tmp, &jpeg).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, &path).await;
    }
    Ok(jpeg)
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
/// until it is back under `CACHE_KEEP`. Runs once at start-up.
pub async fn prune_cache<R: Runtime>(app: AppHandle<R>) {
    let Ok(dir) = cache_dir(&app) else { return };
    let _ = tokio::task::spawn_blocking(move || {
        let Ok(rd) = std::fs::read_dir(&dir) else { return };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                m.is_file().then(|| (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len(), e.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= CACHE_MAX {
            return;
        }
        files.sort_by_key(|f| f.0);
        for (_, len, path) in files {
            if total <= CACHE_KEEP {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total -= len;
            }
        }
    })
    .await;
}

/// Deletes all cached thumbnails. Returns the number of bytes freed.
#[tauri::command]
pub async fn clear_thumbnail_cache(app: AppHandle) -> Result<u64, String> {
    let dir = cache_dir(&app)?;
    let mut freed = 0u64;
    let mut rd = tokio::fs::read_dir(&dir).await.map_err(err)?;
    while let Some(e) = rd.next_entry().await.map_err(err)? {
        if let Ok(m) = e.metadata().await {
            freed += m.len();
        }
        let _ = tokio::fs::remove_file(e.path()).await;
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{build_client, Profile};
    use image::{ImageFormat, RgbImage, RgbaImage};
    use tauri::test::{mock_builder, mock_context, noop_assets};

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
