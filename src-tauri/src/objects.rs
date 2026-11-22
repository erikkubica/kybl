//! Single-object chores: which names are already taken (for name-clash prompts), editing an
//! object's headers in place, and its tags.

use std::{collections::HashMap, sync::Arc};

use aws_sdk_s3::{
    error::SdkError,
    types::{Tag, Tagging},
    Client,
};
use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, State};
use tokio::{sync::Semaphore, task::JoinSet};

use crate::{
    commands::{copy_object, details, Headers, ObjectDetails},
    state::{client_for, err, sdk_err, AppState},
};

/// Requests in flight at once when checking many names.
const CHECKS_AT_ONCE: usize = 16;

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Existing {
    keys: Vec<String>,
    prefixes: Vec<String>,
}

/// Which of `keys` exist (HEAD each), and which `prefixes` have at least one object under them
/// (a one-key listing each). Missing is not an error; anything else the server says is.
/// Answers in the order asked.
#[tauri::command]
pub async fn existing_keys(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    keys: Vec<String>,
    prefixes: Vec<String>,
) -> Result<Existing, String> {
    let client = client_for(&app, &state, &profile_id).await?;
    check_existing(&client, &bucket, keys, prefixes).await
}

fn is_missing<E>(e: &SdkError<E, aws_sdk_s3::config::http::HttpResponse>) -> bool {
    e.raw_response().is_some_and(|r| r.status().as_u16() == 404)
}

pub(crate) async fn check_existing(client: &Client, bucket: &str, keys: Vec<String>, prefixes: Vec<String>) -> Result<Existing, String> {
    let gate = Arc::new(Semaphore::new(CHECKS_AT_ONCE));
    let mut set = JoinSet::new();
    for (i, key) in keys.into_iter().enumerate() {
        let (client, bucket, gate) = (client.clone(), bucket.to_string(), gate.clone());
        set.spawn(async move {
            let _p = gate.acquire_owned().await;
            let r = match client.head_object().bucket(&bucket).key(&key).send().await {
                Ok(_) => Ok(true),
                Err(e) if is_missing(&e) => Ok(false),
                Err(e) => Err(sdk_err(e)),
            };
            (false, i, key, r)
        });
    }
    for (i, prefix) in prefixes.into_iter().enumerate() {
        let (client, bucket, gate) = (client.clone(), bucket.to_string(), gate.clone());
        set.spawn(async move {
            let _p = gate.acquire_owned().await;
            let r = client
                .list_objects_v2()
                .bucket(&bucket)
                .prefix(&prefix)
                .max_keys(1)
                .send()
                .await
                .map(|out| !out.contents().is_empty() || out.key_count().unwrap_or(0) > 0)
                .map_err(sdk_err);
            (true, i, prefix, r)
        });
    }
    let (mut keys, mut prefixes) = (Vec::new(), Vec::new());
    while let Some(joined) = set.join_next().await {
        let (is_prefix, i, name, r) = joined.map_err(err)?;
        match r {
            Ok(true) if is_prefix => prefixes.push((i, name)),
            Ok(true) => keys.push((i, name)),
            Ok(false) => {}
            Err(e) => {
                set.abort_all();
                return Err(e);
            }
        }
    }
    keys.sort();
    prefixes.sort();
    Ok(Existing {
        keys: keys.into_iter().map(|k| k.1).collect(),
        prefixes: prefixes.into_iter().map(|p| p.1).collect(),
    })
}

/// A field the page may leave out (keep the current value) or send as null / "" (remove it).
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// Header edits from the details panel; see `api.updateObjectProps`.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ObjectProps {
    #[serde(default, deserialize_with = "present")]
    content_type: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    cache_control: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    content_disposition: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    content_encoding: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    storage_class: Option<Option<String>>,
    #[serde(default)]
    metadata: Option<HashMap<String, String>>,
}

fn edit(current: Option<String>, change: Option<Option<String>>) -> Option<String> {
    match change {
        None => current,
        Some(v) => v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    }
}

/// The headers after applying `props` to `current` (as read by `Headers::of`, which leaves out
/// STANDARD storage class). Refuses metadata HTTP can't carry.
fn merged(current: Headers, props: ObjectProps) -> Result<Headers, String> {
    let metadata = match props.metadata {
        None => current.metadata,
        Some(m) => {
            let mut out = HashMap::new();
            for (k, v) in m {
                let k = k.trim().to_ascii_lowercase();
                let k = k.strip_prefix("x-amz-meta-").unwrap_or(&k).to_string();
                if k.is_empty() {
                    continue;
                }
                if !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') {
                    return Err(format!("\"{k}\" can't be a metadata name: use letters, digits, - and _ only."));
                }
                if !v.bytes().all(|b| (0x20..0x7f).contains(&b) || b == b'\t') {
                    return Err(format!("The value of \"{k}\" can only use plain letters, digits and punctuation (no accents or emoji)."));
                }
                out.insert(k, v.trim().to_string());
            }
            out
        }
    };
    let had_class = current.storage_class.clone();
    let storage_class = match props.storage_class {
        None => had_class,
        Some(c) => match c.map(|c| c.trim().to_ascii_uppercase()).filter(|c| !c.is_empty()) {
            // asking for the default only needs saying when leaving another class
            None => had_class.map(|_| "STANDARD".to_string()),
            Some(c) if c == "STANDARD" => had_class.map(|_| c),
            Some(c) => Some(c),
        },
    };
    Ok(Headers {
        content_type: edit(current.content_type, props.content_type),
        cache_control: edit(current.cache_control, props.cache_control),
        content_disposition: edit(current.content_disposition, props.content_disposition),
        content_encoding: edit(current.content_encoding, props.content_encoding),
        content_language: current.content_language,
        metadata,
        storage_class,
    })
}

/// Rewrites an object's headers by copying it onto itself with the new ones (S3 can't edit an
/// object in place). Fields left out keep their value; tags stay as they are. Big objects take the
/// multipart copy path, which sets the same headers.
#[tauri::command]
pub async fn update_object_props(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
    props: ObjectProps,
) -> Result<ObjectDetails, String> {
    let client = client_for(&app, &state, &profile_id).await?;
    let head = client.head_object().bucket(&bucket).key(&key).send().await.map_err(sdk_err)?;
    let size = head.content_length().unwrap_or(0);
    let next = merged(Headers::of(&head), props)?;
    copy_object(&client, &bucket, &key, &bucket, &key, size, Some(&next)).await?;
    let after = client.head_object().bucket(&bucket).key(&key).send().await.map_err(sdk_err)?;
    Ok(details(key, &after))
}

#[tauri::command]
pub async fn get_object_tags(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
) -> Result<HashMap<String, String>, String> {
    let client = client_for(&app, &state, &profile_id).await?;
    let out = client.get_object_tagging().bucket(&bucket).key(&key).send().await.map_err(sdk_err)?;
    Ok(out.tag_set().iter().map(|t| (t.key().to_string(), t.value().to_string())).collect())
}

/// Replaces all of an object's tags; an empty map removes them.
#[tauri::command]
pub async fn put_object_tags(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
    tags: HashMap<String, String>,
) -> Result<(), String> {
    let client = client_for(&app, &state, &profile_id).await?;
    let mut set = Vec::new();
    for (k, v) in tags {
        let k = k.trim().to_string();
        if k.is_empty() {
            continue;
        }
        set.push(Tag::builder().key(k).value(v.trim()).build().map_err(err)?);
    }
    if set.is_empty() {
        client.delete_object_tagging().bucket(&bucket).key(&key).send().await.map_err(sdk_err)?;
        return Ok(());
    }
    set.sort_by(|a, b| a.key().cmp(b.key()));
    let tagging = Tagging::builder().set_tag_set(Some(set)).build().map_err(err)?;
    client
        .put_object_tagging()
        .bucket(&bucket)
        .key(&key)
        .tagging(tagging)
        .send()
        .await
        .map_err(sdk_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{build_client, Profile};

    fn props(json: &str) -> ObjectProps {
        serde_json::from_str(json).unwrap()
    }

    fn current() -> Headers {
        Headers {
            content_type: Some("image/jpeg".into()),
            cache_control: Some("max-age=60".into()),
            content_language: Some("en".into()),
            metadata: HashMap::from([("owner".into(), "me".into())]),
            ..Default::default()
        }
    }

    #[test]
    fn left_out_fields_keep_their_value_and_null_clears() {
        let h = merged(current(), props(r#"{"cacheControl":null,"contentDisposition":"attachment"}"#)).unwrap();
        assert_eq!(h.content_type.as_deref(), Some("image/jpeg"), "left out: kept");
        assert_eq!(h.cache_control, None, "null: removed");
        assert_eq!(h.content_disposition.as_deref(), Some("attachment"));
        assert_eq!(h.content_language.as_deref(), Some("en"), "not editable, so kept");
        assert_eq!(h.metadata.get("owner").map(String::as_str), Some("me"));
        let h = merged(current(), props(r#"{"contentType":"  ","metadata":{"X-Amz-Meta-Team":"ops"}}"#)).unwrap();
        assert_eq!(h.content_type, None, "blank: removed");
        assert_eq!(h.metadata, HashMap::from([("team".into(), "ops".into())]), "metadata replaced, names normalised");
    }

    #[test]
    fn metadata_http_cant_carry_is_refused() {
        assert!(merged(current(), props(r#"{"metadata":{"a b":"x"}}"#)).is_err());
        assert!(merged(current(), props(r#"{"metadata":{"name":"čaj"}}"#)).is_err());
    }

    #[test]
    fn storage_class_is_only_sent_when_it_matters() {
        // STANDARD on a STANDARD object: nothing to send (some providers refuse the header)
        assert_eq!(merged(current(), props(r#"{"storageClass":"STANDARD"}"#)).unwrap().storage_class, None);
        assert_eq!(merged(current(), props(r#"{"storageClass":"standard_ia"}"#)).unwrap().storage_class.as_deref(), Some("STANDARD_IA"));
        let ia = Headers { storage_class: Some("STANDARD_IA".into()), ..current() };
        // left out: an IA object stays IA (a copy without the header would make it STANDARD)
        assert_eq!(merged(ia.clone(), props("{}")).unwrap().storage_class.as_deref(), Some("STANDARD_IA"));
        assert_eq!(merged(ia, props(r#"{"storageClass":"STANDARD"}"#)).unwrap().storage_class.as_deref(), Some("STANDARD"));
    }

    /// Against a throwaway S3 server (see the sync tests): names that exist are found, missing
    /// ones are not errors.
    #[test]
    fn existing_finds_keys_and_folders() {
        let Ok(endpoint) = std::env::var("KYBL_TEST_ENDPOINT") else { return };
        let p = Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
        };
        let client = build_client(&p, "testsecret");
        tauri::async_runtime::block_on(async move {
            let base = format!("ex-{}/", uuid::Uuid::new_v4());
            for k in ["a.txt", "sub/b.txt"] {
                client
                    .put_object()
                    .bucket("testbucket")
                    .key(format!("{base}{k}"))
                    .body(aws_sdk_s3::primitives::ByteStream::from_static(b"x"))
                    .send()
                    .await
                    .unwrap();
            }
            let keys: Vec<String> = ["a.txt", "nope.txt", "sub/b.txt"].iter().map(|k| format!("{base}{k}")).collect();
            let prefixes = vec![format!("{base}sub/"), format!("{base}empty/")];
            let r = check_existing(&client, "testbucket", keys, prefixes).await.unwrap();
            assert_eq!(r.keys, vec![format!("{base}a.txt"), format!("{base}sub/b.txt")]);
            assert_eq!(r.prefixes, vec![format!("{base}sub/")]);
        });
    }
}
