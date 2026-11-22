//! Opening and saving documents for the in-app viewers and editor (src/viewers).
//!
//! `doc_open` answers with one framed body, `[u32 BE json_len][json DocMeta][bytes]`, so the
//! metadata and the bytes come from the same GET and can't disagree.
//!
//! `doc_save` takes the new bytes as a raw IPC body (no JSON, no base64) and refuses to overwrite
//! a file that changed since it was opened: the error then starts with `CONFLICT\n\n`, followed by
//! the JSON `DocMeta` of what is there now (or `null` when the file is gone).
//!
//! Storage boundary: everything provider-specific sits in the three `s3_*` functions below
//! (`s3_read`, `s3_stat`, `s3_write`) plus `guard_for`. When the generic `Storage` trait lands
//! (phase 2, WP0), they become `Storage::read`, `Storage::stat` and `Storage::write`, and
//! `guard_for` becomes `caps.conditionalWrite`; the commands, framing and precondition logic
//! stay as they are.

use std::collections::HashMap;

use aws_sdk_s3::{
    error::SdkError,
    primitives::{ByteStream, DateTime},
    types::{ServerSideEncryption, StorageClass},
    Client,
};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use tauri::{ipc::InvokeBody, AppHandle, State};

use crate::state::{client_for, err, load_profiles, sdk_err, AppState};

/// What the frontend needs to know about an opened or saved document.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    /// without quotes
    pub etag: Option<String>,
    pub size: u64,
    /// milliseconds since the epoch
    pub modified: Option<i64>,
    pub content_type: Option<String>,
    /// object version in versioned buckets
    pub version: Option<String>,
}

/// What the editor expects to find when it saves (`x-kybl-expect`).
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Precondition {
    /// The file as it was opened; anything else there is a conflict.
    #[serde(rename_all = "camelCase")]
    Match {
        etag: Option<String>,
        size: u64,
        modified: Option<i64>,
        version: Option<String>,
    },
    /// A new file ("Save as copy"): fails if something already has that name. `headers_from`
    /// names the original, whose content type and other headers the copy takes over.
    #[serde(rename_all = "camelCase")]
    Absent {
        #[serde(default)]
        headers_from: Option<String>,
    },
    /// Overwrite whatever is there (the user picked "Overwrite" after a conflict).
    Any,
}

/// How a provider can make a write conditional. Today it comes from the connection's provider;
/// with the storage core it becomes `caps.conditionalWrite`.
#[derive(Debug, Clone, Copy, PartialEq)]
enum WriteGuard {
    /// `If-Match` / `If-None-Match: *` on the PUT itself: no race at all.
    IfMatch,
    /// HEAD, compare, then PUT. Leaves a window of a few milliseconds between the check and the
    /// write, which is the best these providers allow.
    Compare,
}

/// AWS and R2 honour conditional PUTs. Hetzner (Ceph) only accepts unquoted ETags there and
/// ignores `If-None-Match: <etag>`, Kybl Storage sits behind a proxy, and other S3-compatible
/// services vary, so everyone else gets the compare-then-write path.
fn guard_for(provider: &str) -> WriteGuard {
    match provider {
        "aws" | "r2" => WriteGuard::IfMatch,
        _ => WriteGuard::Compare,
    }
}

/// Headers a PUT would otherwise drop. Saving must keep them: a PUT replaces the object, headers
/// and all.
#[derive(Debug, Clone, Default, PartialEq)]
struct Headers {
    content_type: Option<String>,
    cache_control: Option<String>,
    content_disposition: Option<String>,
    content_encoding: Option<String>,
    content_language: Option<String>,
    metadata: HashMap<String, String>,
    storage_class: Option<String>,
    /// SSE-S3 / SSE-KMS, carried over on AWS only (see `s3_stat`)
    sse: Option<String>,
    sse_kms_key: Option<String>,
    tags: Vec<(String, String)>,
}

// ---------------------------------------------------------------- pure helpers (tested)

/// `"abc"` and `W/"abc"` → `abc`.
fn norm_etag(e: &str) -> &str {
    e.trim().trim_start_matches("W/").trim_matches('"')
}

/// Whether the file is still the one that was opened. With ETags on both sides they decide
/// (plus the size, as a cheap second check); without, size and modification time must both
/// match. Versions, when both sides have one, must match too.
fn unchanged(etag: Option<&str>, size: u64, modified: Option<i64>, version: Option<&str>, now: &DocMeta) -> bool {
    if let (Some(a), Some(b)) = (version, now.version.as_deref()) {
        if a != b {
            return false;
        }
    }
    if size != now.size {
        return false;
    }
    match (etag, now.etag.as_deref()) {
        (Some(a), Some(b)) => norm_etag(a) == norm_etag(b),
        // no ETag to go on: the modification time has to match exactly
        _ => modified.is_some() && modified == now.modified,
    }
}

/// `Ok` when the save may go ahead, otherwise the `CONFLICT` error for the frontend.
fn check(expect: &Precondition, now: Option<&DocMeta>) -> Result<(), String> {
    match (expect, now) {
        (Precondition::Any, _) => Ok(()),
        (Precondition::Absent { .. }, None) => Ok(()),
        (Precondition::Absent { .. }, Some(now)) => Err(conflict(Some(now))),
        (Precondition::Match { .. }, None) => Err(conflict(None)),
        (Precondition::Match { etag, size, modified, version }, Some(now)) => {
            if unchanged(etag.as_deref(), *size, *modified, version.as_deref(), now) {
                Ok(())
            } else {
                Err(conflict(Some(now)))
            }
        }
    }
}

fn conflict(now: Option<&DocMeta>) -> String {
    format!("CONFLICT\n\n{}", serde_json::to_string(&now).unwrap_or_else(|_| "null".into()))
}

/// `[u32 BE json_len][json][bytes]`
fn frame(meta: &DocMeta, bytes: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(meta).unwrap_or_else(|_| b"{}".to_vec());
    let mut out = Vec::with_capacity(4 + json.len() + bytes.len());
    out.extend_from_slice(&(json.len() as u32).to_be_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(bytes);
    out
}

#[cfg(test)]
fn unframe(body: &[u8]) -> Option<(DocMeta, &[u8])> {
    let len = u32::from_be_bytes(body.get(..4)?.try_into().ok()?) as usize;
    let meta = serde_json::from_slice(body.get(4..4 + len)?).ok()?;
    Some((meta, &body[4 + len..]))
}

/// The `x-amz-tagging` value: `k1=v1&k2=v2`, both sides URL-encoded.
fn tagging_query(tags: &[(String, String)]) -> String {
    let enc = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    tags.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

/// A percent-encoded request header (IPC headers must be ASCII; keys and JSON may not be).
fn header(headers: &tauri::http::HeaderMap, name: &str) -> Result<String, String> {
    let raw = headers
        .get(name)
        .ok_or_else(|| format!("Missing {name}"))?
        .to_str()
        .map_err(err)?;
    percent_decode_str(raw).decode_utf8().map(|s| s.into_owned()).map_err(err)
}

fn millis(d: Option<&DateTime>) -> Option<i64> {
    d.map(|d| d.secs() * 1000 + (d.subsec_nanos() / 1_000_000) as i64)
}

fn http_status<E>(e: &SdkError<E, aws_sdk_s3::config::http::HttpResponse>) -> Option<u16> {
    e.raw_response().map(|r| r.status().as_u16())
}

const TOO_LARGE: &str = "This file is too large to open here. Download it to open it in another app.";

// ---------------------------------------------------------------- S3 (becomes `Storage` later)

/// One GET: the bytes and the metadata that belongs to exactly those bytes.
async fn s3_read(client: &Client, bucket: &str, key: &str, max_bytes: u64) -> Result<(DocMeta, Vec<u8>), String> {
    let mut out = client.get_object().bucket(bucket).key(key).send().await.map_err(sdk_err)?;
    let len = out.content_length().unwrap_or(0).max(0) as u64;
    if len > max_bytes {
        return Err(TOO_LARGE.into());
    }
    let meta = DocMeta {
        etag: out.e_tag().map(|e| norm_etag(e).to_string()),
        size: len,
        modified: millis(out.last_modified()),
        content_type: out.content_type().map(str::to_string),
        version: out.version_id().map(str::to_string),
    };
    let mut buf: Vec<u8> = Vec::with_capacity(len as usize);
    while let Some(chunk) = out.body.try_next().await.map_err(err)? {
        buf.extend_from_slice(&chunk);
        if buf.len() as u64 > max_bytes {
            return Err(TOO_LARGE.into());
        }
    }
    let meta = DocMeta { size: buf.len() as u64, ..meta };
    Ok((meta, buf))
}

/// HEAD (and tags) of what is there now; `None` when nothing is.
async fn s3_stat(client: &Client, bucket: &str, key: &str, keep_sse: bool) -> Result<Option<(DocMeta, Headers)>, String> {
    let head = client.head_object().bucket(bucket).key(key).send();
    // tags are best effort: some S3-compatible services don't do tagging at all
    let tags = client.get_object_tagging().bucket(bucket).key(key).send();
    let (head, tags) = tokio::join!(head, tags);
    let h = match head {
        Ok(h) => h,
        Err(e) if e.as_service_error().is_some_and(|s| s.is_not_found()) || http_status(&e) == Some(404) => return Ok(None),
        Err(e) => return Err(sdk_err(e)),
    };
    let meta = DocMeta {
        etag: h.e_tag().map(|e| norm_etag(e).to_string()),
        size: h.content_length().unwrap_or(0).max(0) as u64,
        modified: millis(h.last_modified()),
        content_type: h.content_type().map(str::to_string),
        version: h.version_id().map(str::to_string),
    };
    let (sse, sse_kms_key) = if keep_sse {
        (h.server_side_encryption().map(|s| s.as_str().to_string()), h.ssekms_key_id().map(str::to_string))
    } else {
        (None, None)
    };
    let headers = Headers {
        content_type: meta.content_type.clone(),
        cache_control: h.cache_control().map(str::to_string),
        content_disposition: h.content_disposition().map(str::to_string),
        content_encoding: h.content_encoding().map(str::to_string),
        content_language: h.content_language().map(str::to_string),
        metadata: h.metadata().cloned().unwrap_or_default(),
        storage_class: h.storage_class().map(|s| s.as_str().to_string()),
        sse,
        sse_kms_key,
        tags: tags
            .map(|t| t.tag_set().iter().map(|t| (t.key().to_string(), t.value().to_string())).collect())
            .unwrap_or_default(),
    };
    Ok(Some((meta, headers)))
}

enum Cond {
    IfMatch(String),
    IfNoneMatchAny,
}

enum WriteErr {
    /// the provider refused the condition (412 / 409)
    Precondition,
    /// the provider doesn't understand conditional PUTs (501 / NotImplemented)
    CondUnsupported,
    Other(String),
}

async fn s3_write(client: &Client, bucket: &str, key: &str, bytes: Vec<u8>, h: &Headers, cond: Option<&Cond>) -> Result<(Option<String>, Option<String>), WriteErr> {
    let mut put = client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(bytes))
        .set_content_type(h.content_type.clone())
        .set_cache_control(h.cache_control.clone())
        .set_content_disposition(h.content_disposition.clone())
        .set_content_encoding(h.content_encoding.clone())
        .set_content_language(h.content_language.clone());
    if !h.metadata.is_empty() {
        put = put.set_metadata(Some(h.metadata.clone()));
    }
    if let Some(sc) = &h.storage_class {
        put = put.storage_class(StorageClass::from(sc.as_str()));
    }
    if let Some(sse) = &h.sse {
        put = put.server_side_encryption(ServerSideEncryption::from(sse.as_str())).set_ssekms_key_id(h.sse_kms_key.clone());
    }
    if !h.tags.is_empty() {
        put = put.tagging(tagging_query(&h.tags));
    }
    put = match cond {
        Some(Cond::IfMatch(etag)) => put.if_match(format!("\"{}\"", norm_etag(etag))),
        Some(Cond::IfNoneMatchAny) => put.if_none_match("*"),
        None => put,
    };
    match put.send().await {
        Ok(out) => Ok((out.e_tag().map(|e| norm_etag(e).to_string()), out.version_id().map(str::to_string))),
        Err(e) => {
            let code = e.as_service_error().and_then(|s| aws_sdk_s3::error::ProvideErrorMetadata::code(s)).unwrap_or_default().to_string();
            match http_status(&e) {
                Some(412) | Some(409) if cond.is_some() => Err(WriteErr::Precondition),
                Some(501) if cond.is_some() => Err(WriteErr::CondUnsupported),
                _ if cond.is_some() && code == "NotImplemented" => Err(WriteErr::CondUnsupported),
                _ => Err(WriteErr::Other(sdk_err(e))),
            }
        }
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn doc_open(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    root: String,
    path: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let client = client_for(&app, &state, &profile_id).await?;
    let (meta, bytes) = s3_read(&client, &root, &path, max_bytes).await?;
    Ok(tauri::ipc::Response::new(frame(&meta, &bytes)))
}

/// Raw body = the new contents. Headers: `x-kybl-profile`, `x-kybl-root`, `x-kybl-path` and
/// `x-kybl-expect` (JSON `Precondition`), all percent-encoded.
#[tauri::command]
pub async fn doc_save(app: AppHandle, state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<DocMeta, String> {
    let hs = request.headers();
    let profile_id = header(hs, "x-kybl-profile")?;
    let bucket = header(hs, "x-kybl-root")?;
    let key = header(hs, "x-kybl-path")?;
    let expect: Precondition = serde_json::from_str(&header(hs, "x-kybl-expect")?).map_err(err)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's contents as raw bytes".into());
    };
    let bytes = bytes.clone();

    let provider = load_profiles(&app)?
        .into_iter()
        .find(|p| p.id == profile_id)
        .map(|p| p.provider)
        .unwrap_or_default();
    let guard = guard_for(&provider);
    let keep_sse = provider == "aws";
    let client = client_for(&app, &state, &profile_id).await?;
    save(&client, &bucket, &key, bytes, &expect, guard, keep_sse).await
}

async fn save(client: &Client, bucket: &str, key: &str, bytes: Vec<u8>, expect: &Precondition, guard: WriteGuard, keep_sse: bool) -> Result<DocMeta, String> {
    let now = s3_stat(client, bucket, key, keep_sse).await?;
    check(expect, now.as_ref().map(|n| &n.0))?;

    let headers = match (&now, expect) {
        (Some((_, h)), _) => h.clone(),
        (None, Precondition::Absent { headers_from: Some(from) }) => match s3_stat(client, bucket, from, keep_sse).await {
            Ok(Some((_, h))) => h,
            _ => Headers::default(),
        },
        _ => Headers::default(),
    };
    let headers = Headers {
        content_type: headers
            .content_type
            .clone()
            .or_else(|| mime_guess::from_path(key).first().map(|m| m.essence_str().to_string())),
        ..headers
    };

    let cond = match (guard, expect, &now) {
        (WriteGuard::IfMatch, Precondition::Match { .. }, Some((m, _))) => m.etag.clone().map(Cond::IfMatch),
        (WriteGuard::IfMatch, Precondition::Absent { .. }, _) => Some(Cond::IfNoneMatchAny),
        _ => None,
    };
    let size = bytes.len() as u64;
    let written = match s3_write(client, bucket, key, bytes.clone(), &headers, cond.as_ref()).await {
        Ok(w) => w,
        Err(WriteErr::Precondition) => {
            let now = s3_stat(client, bucket, key, false).await?;
            return Err(conflict(now.as_ref().map(|n| &n.0)));
        }
        // already compared above, so a plain write is as safe as the compare path
        Err(WriteErr::CondUnsupported) => s3_write(client, bucket, key, bytes, &headers, None).await.map_err(|e| match e {
            WriteErr::Other(s) => s,
            _ => "The save didn't go through. Try again.".into(),
        })?,
        Err(WriteErr::Other(e)) => return Err(e),
    };

    // The PUT answer has the ETag but no modification time: read it back. If someone else wrote
    // in between, keep our own ETag so the next save still notices their change.
    let after = s3_stat(client, bucket, key, false).await.ok().flatten().map(|n| n.0);
    Ok(saved_meta(written, size, headers.content_type, after))
}

fn saved_meta(written: (Option<String>, Option<String>), size: u64, content_type: Option<String>, after: Option<DocMeta>) -> DocMeta {
    let (etag, version) = written;
    match after {
        Some(a) if etag.is_none() || a.etag.as_deref().map(norm_etag) == etag.as_deref().map(norm_etag) => DocMeta {
            etag: a.etag.or(etag),
            version: a.version.or(version),
            ..a
        },
        _ => DocMeta { etag, size, modified: None, content_type, version },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(etag: Option<&str>, size: u64, modified: Option<i64>) -> DocMeta {
        DocMeta { etag: etag.map(str::to_string), size, modified, content_type: Some("text/plain".into()), version: None }
    }

    #[test]
    fn frame_round_trips_meta_and_bytes() {
        let m = DocMeta { etag: Some("abc".into()), size: 5, modified: Some(1_700_000_000_123), content_type: Some("text/markdown".into()), version: Some("v1".into()) };
        let body = frame(&m, b"hello");
        assert_eq!(&body[..4], &(body.len() as u32 - 4 - 5).to_be_bytes());
        let (back, bytes) = unframe(&body).unwrap();
        assert_eq!(back, m);
        assert_eq!(bytes, b"hello");
        // the frontend reads camelCase names
        let json = std::str::from_utf8(&body[4..body.len() - 5]).unwrap();
        assert!(json.contains("\"contentType\":\"text/markdown\""), "{json}");
        // empty files frame fine too
        let empty = frame(&DocMeta::default(), b"");
        let (_, none) = unframe(&empty).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn etags_compare_without_quotes_or_weak_marker() {
        assert_eq!(norm_etag("\"abc\""), "abc");
        assert_eq!(norm_etag("W/\"abc\""), "abc");
        assert_eq!(norm_etag("abc"), "abc");
        assert!(unchanged(Some("\"abc\""), 3, None, None, &meta(Some("abc"), 3, Some(1))));
    }

    #[test]
    fn etag_decides_when_both_sides_have_one() {
        let now = meta(Some("abc"), 10, Some(2000));
        // modification time differs (re-upload of the same bytes): still the same file
        assert!(unchanged(Some("abc"), 10, Some(1000), None, &now));
        assert!(!unchanged(Some("xyz"), 10, Some(2000), None, &now));
        // same ETag but another size cannot be the same file
        assert!(!unchanged(Some("abc"), 11, Some(2000), None, &now));
    }

    #[test]
    fn without_etags_size_and_time_must_both_match() {
        let now = meta(None, 10, Some(2000));
        assert!(unchanged(None, 10, Some(2000), None, &now));
        assert!(!unchanged(None, 10, Some(2001), None, &now));
        assert!(!unchanged(None, 9, Some(2000), None, &now));
        // nothing to compare the time with: refuse rather than overwrite blindly
        assert!(!unchanged(None, 10, None, None, &now));
        assert!(!unchanged(Some("abc"), 10, None, None, &now));
    }

    #[test]
    fn versions_must_match_when_both_known() {
        let now = DocMeta { version: Some("v2".into()), ..meta(Some("abc"), 1, None) };
        assert!(!unchanged(Some("abc"), 1, None, Some("v1"), &now));
        assert!(unchanged(Some("abc"), 1, None, Some("v2"), &now));
        assert!(unchanged(Some("abc"), 1, None, None, &now));
    }

    #[test]
    fn preconditions_and_conflict_payload() {
        let now = meta(Some("abc"), 3, Some(5));
        let opened = Precondition::Match { etag: Some("abc".into()), size: 3, modified: Some(5), version: None };
        assert_eq!(check(&opened, Some(&now)), Ok(()));
        assert_eq!(check(&Precondition::Any, Some(&now)), Ok(()));
        assert_eq!(check(&Precondition::Any, None), Ok(()));
        assert_eq!(check(&Precondition::Absent { headers_from: None }, None), Ok(()));

        let e = check(&Precondition::Absent { headers_from: None }, Some(&now)).unwrap_err();
        let (tag, json) = e.split_once("\n\n").unwrap();
        assert_eq!(tag, "CONFLICT");
        assert_eq!(serde_json::from_str::<DocMeta>(json).unwrap(), now);

        let changed = meta(Some("def"), 4, Some(6));
        let e = check(&opened, Some(&changed)).unwrap_err();
        assert_eq!(serde_json::from_str::<DocMeta>(e.split_once("\n\n").unwrap().1).unwrap(), changed);

        // deleted meanwhile: CONFLICT with null
        assert_eq!(check(&opened, None).unwrap_err(), "CONFLICT\n\nnull");
    }

    #[test]
    fn precondition_json_from_the_frontend() {
        let p: Precondition = serde_json::from_str(r#"{"kind":"match","etag":"abc","size":3,"modified":5,"version":null}"#).unwrap();
        assert_eq!(p, Precondition::Match { etag: Some("abc".into()), size: 3, modified: Some(5), version: None });
        let p: Precondition = serde_json::from_str(r#"{"kind":"absent","headersFrom":"docs/a.md"}"#).unwrap();
        assert_eq!(p, Precondition::Absent { headers_from: Some("docs/a.md".into()) });
        let p: Precondition = serde_json::from_str(r#"{"kind":"absent"}"#).unwrap();
        assert_eq!(p, Precondition::Absent { headers_from: None });
        let p: Precondition = serde_json::from_str(r#"{"kind":"any"}"#).unwrap();
        assert_eq!(p, Precondition::Any);
    }

    #[test]
    fn headers_are_percent_decoded() {
        let mut h = tauri::http::HeaderMap::new();
        h.insert("x-kybl-path", "docs%2Fnotes%20%C4%8Dau.md".parse().unwrap());
        assert_eq!(header(&h, "x-kybl-path").unwrap(), "docs/notes čau.md");
        assert!(header(&h, "x-kybl-root").unwrap_err().contains("x-kybl-root"));
    }

    #[test]
    fn tags_encode_as_a_query_string() {
        let t = vec![("team".to_string(), "a b".to_string()), ("k&y".to_string(), "v=1".to_string())];
        assert_eq!(tagging_query(&t), "team=a%20b&k%26y=v%3D1");
        assert_eq!(tagging_query(&[]), "");
    }

    #[test]
    fn guard_per_provider() {
        assert_eq!(guard_for("aws"), WriteGuard::IfMatch);
        assert_eq!(guard_for("r2"), WriteGuard::IfMatch);
        for p in ["hetzner", "kybl", "custom", "b2", "wasabi", "do", ""] {
            assert_eq!(guard_for(p), WriteGuard::Compare, "{p}");
        }
    }

    #[test]
    fn saved_meta_keeps_our_etag_if_someone_wrote_in_between() {
        let after = DocMeta { modified: Some(9), ..meta(Some("abc"), 3, None) };
        let m = saved_meta((Some("\"abc\"".into()), None), 3, None, Some(after.clone()));
        assert_eq!(m.modified, Some(9));
        assert_eq!(m.etag.as_deref().map(norm_etag), Some("abc"));
        let theirs = meta(Some("zzz"), 50, Some(10));
        let m = saved_meta((Some("abc".into()), Some("v3".into())), 3, Some("text/plain".into()), Some(theirs));
        assert_eq!(m, DocMeta { etag: Some("abc".into()), size: 3, modified: None, content_type: Some("text/plain".into()), version: Some("v3".into()) });
    }

    /// End to end against a throwaway S3 server (see sync.rs tests): open, save, conflict,
    /// headers kept, save as copy.
    #[test]
    fn save_round_trip_against_s3() {
        let Ok(endpoint) = std::env::var("KYBL_TEST_ENDPOINT") else { return eprintln!("skipped: KYBL_TEST_ENDPOINT not set") };
        let p = crate::state::Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
        };
        let client = crate::state::build_client(&p, "testsecret");
        let b = "testbucket";
        tauri::async_runtime::block_on(async move {
            let key = format!("doc-{}/notes.md", uuid::Uuid::new_v4());
            let mut md = HashMap::new();
            md.insert("owner".to_string(), "kybl".to_string());
            client
                .put_object()
                .bucket(b)
                .key(&key)
                .body(ByteStream::from_static(b"# Hi\r\n"))
                .content_type("text/markdown; charset=utf-8")
                .cache_control("max-age=60")
                .set_metadata(Some(md))
                .send()
                .await
                .unwrap();

            let (opened, bytes) = s3_read(&client, b, &key, 1 << 20).await.unwrap();
            assert_eq!(bytes, b"# Hi\r\n");
            assert_eq!(opened.size, 6);
            assert!(s3_read(&client, b, &key, 3).await.unwrap_err().contains("too large"));

            let expect = Precondition::Match { etag: opened.etag.clone(), size: opened.size, modified: opened.modified, version: opened.version.clone() };
            let saved = save(&client, b, &key, b"# Hello\r\n".to_vec(), &expect, WriteGuard::Compare, false).await.unwrap();
            assert_eq!(saved.size, 9);
            assert_ne!(saved.etag, opened.etag);

            // headers survived the PUT
            let h = client.head_object().bucket(b).key(&key).send().await.unwrap();
            assert_eq!(h.content_type(), Some("text/markdown; charset=utf-8"));
            assert_eq!(h.cache_control(), Some("max-age=60"));
            assert_eq!(h.metadata().and_then(|m| m.get("owner")).map(String::as_str), Some("kybl"));

            // saving again from the stale copy is a conflict carrying the current meta
            let e = save(&client, b, &key, b"stale".to_vec(), &expect, WriteGuard::Compare, false).await.unwrap_err();
            let (tag, json) = e.split_once("\n\n").unwrap();
            assert_eq!(tag, "CONFLICT");
            let now: DocMeta = serde_json::from_str(json).unwrap();
            assert_eq!(now.etag, saved.etag);

            // ...and works from the saved meta
            let expect2 = Precondition::Match { etag: saved.etag.clone(), size: saved.size, modified: saved.modified, version: saved.version.clone() };
            let third = save(&client, b, &key, b"third".to_vec(), &expect2, WriteGuard::Compare, false).await.unwrap();

            // the If-Match path: honoured, ignored or refused as unsupported, the save goes through
            // (and a stale one is still caught by the compare before it)
            let expect3 = Precondition::Match { etag: third.etag.clone(), size: third.size, modified: third.modified, version: third.version.clone() };
            save(&client, b, &key, b"fourth".to_vec(), &expect3, WriteGuard::IfMatch, false).await.unwrap();
            assert!(save(&client, b, &key, b"stale".to_vec(), &expect3, WriteGuard::IfMatch, false).await.unwrap_err().starts_with("CONFLICT\n\n"));

            // save as copy takes the original's headers and refuses to clobber
            let copy = format!("{key}.copy.md");
            let absent = Precondition::Absent { headers_from: Some(key.clone()) };
            save(&client, b, &copy, b"copy".to_vec(), &absent, WriteGuard::Compare, false).await.unwrap();
            let h = client.head_object().bucket(b).key(&copy).send().await.unwrap();
            assert_eq!(h.content_type(), Some("text/markdown; charset=utf-8"));
            assert!(save(&client, b, &copy, b"again".to_vec(), &absent, WriteGuard::Compare, false).await.unwrap_err().starts_with("CONFLICT\n\n"));

            // a deleted file: CONFLICT null, and Overwrite recreates it
            client.delete_object().bucket(b).key(&key).send().await.unwrap();
            assert_eq!(save(&client, b, &key, b"x".to_vec(), &expect2, WriteGuard::Compare, false).await.unwrap_err(), "CONFLICT\n\nnull");
            save(&client, b, &key, b"x".to_vec(), &Precondition::Any, WriteGuard::Compare, false).await.unwrap();
            for k in [&key, &copy] {
                let _ = client.delete_object().bucket(b).key(k).send().await;
            }
        });
    }
}
