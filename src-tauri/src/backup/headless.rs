//! The entry points the native backup workers call: JNI for Android (`BackupNative.kt`) and a C
//! ABI for iOS (`KyblBackup`). They need no `AppHandle`, block the calling (worker) thread until
//! done, take and return JSON strings, and are safe to call while the Tauri app is also running
//! in the process: both share one engine (`backup::core`).
//!
//! Everything but uploads goes through one dispatcher, [`call`], whose answer is
//! `{"ok": <value>}` or `{"error": "<message>"}`:
//!
//! | method     | arguments                          | ok                          |
//! |------------|------------------------------------|-----------------------------|
//! | `sets`     | `{}`                               | `[BackupSet]`               |
//! | `runStart` | `{setId}`                          | `{run: bool}`               |
//! | `offer`    | `{setId, items: [Item]}`           | `[Offer]` to upload         |
//! | `pending`  | `{setId, limit?}`                  | `[Offer]` still to upload   |
//! | `fail`     | `{setId, sourceId, error}`         | `null`                      |
//! | `gone`     | `{setId, sourceId}`                | `null`                      |
//! | `runEnd`   | `{setId, error?}`                  | `null`                      |
//! | `cancel`   | `{setId?}`                         | `null`                      |
//! | `status`   | `{setId}`                          | `SetStatus`                 |
//! | `device`   | `{name}`                           | `null`                      |
//!
//! Uploads answer an [`UploadResult`](super::types::UploadResult) (`{status, remotePath?,
//! error?}`): the worker goes on to the next item after done / adopted / skipped / failed, and
//! stops the run on cancelled / waitingWifi / retryLater / needsAuth.

use serde::Deserialize;
use serde_json::{json, Value};

use super::{core, engine::Source, types::*};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Args {
    set_id: String,
    source_id: String,
    items: Vec<Item>,
    limit: Option<usize>,
    error: Option<String>,
    name: String,
}

/// Runs one method (see the module table).
pub fn call(method: &str, args: &str) -> String {
    let out = (|| -> Result<Value, String> {
        let a: Args = if args.trim().is_empty() { Args::default() } else { serde_json::from_str(args).map_err(|e| format!("Bad arguments for {method}: {e}"))? };
        let core = core()?;
        let v = match method {
            "sets" => serde_json::to_value(core.sets()?),
            "runStart" => Ok(json!({ "run": core.run_start(&a.set_id)? })),
            "offer" => serde_json::to_value(core.offer(&a.set_id, &a.items)?),
            "pending" => serde_json::to_value(core.pending(&a.set_id, a.limit.unwrap_or(super::engine::PENDING_BATCH))?),
            "fail" => {
                core.fail(&a.set_id, &a.source_id, a.error.as_deref().unwrap_or("Couldn't read this file."))?;
                Ok(Value::Null)
            }
            "gone" => {
                core.gone(&a.set_id, &a.source_id)?;
                Ok(Value::Null)
            }
            "runEnd" => {
                core.run_end(&a.set_id, a.error.filter(|e| !e.is_empty()))?;
                Ok(Value::Null)
            }
            "cancel" => {
                core.cancel(Some(a.set_id.as_str()).filter(|s| !s.is_empty()));
                Ok(Value::Null)
            }
            "status" => serde_json::to_value(core.status(&a.set_id)?),
            "device" => {
                core.set_device(&a.name);
                Ok(Value::Null)
            }
            other => return Err(format!("Unknown backup call {other}")),
        };
        v.map_err(|e| e.to_string())
    })();
    match out {
        Ok(v) => json!({ "ok": v }).to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

/// The `offer` call on its own (the spec's entry point): `[Offer]`, or `{"error"}`.
pub fn offer(set_id: &str, items_json: &str) -> String {
    let r = serde_json::from_str::<Vec<Item>>(items_json).map_err(|e| e.to_string()).and_then(|items| core()?.offer(set_id, &items));
    match r {
        Ok(v) => serde_json::to_string(&v).unwrap_or_else(|_| "[]".into()),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

/// Uploads one item; blocks until it is done.
pub fn upload(set_id: &str, source_id: &str, src: Source, size: i64, mtime_ms: i64) -> String {
    let r = match core() {
        Ok(core) => {
            let mtime = Some(mtime_ms).filter(|&t| t > 0);
            tauri::async_runtime::block_on(async move { core.upload(set_id, source_id, src, size, mtime).await })
        }
        Err(e) => UploadResult::err("retryLater", e),
    };
    serde_json::to_string(&r).unwrap_or_else(|_| r#"{"status":"failed"}"#.into())
}

/// Stops every run.
pub fn cancel_all() {
    if let Ok(core) = core() {
        core.cancel(None);
    }
}

/// A worker found the process without the app: opens the engine on the app's folders and the
/// transfer settings the app saved (bandwidth cap, parts at once).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn init_without_app(config: std::path::PathBuf, data: std::path::PathBuf) -> Result<(), String> {
    if crate::platform::app().is_none()
        && let Some(prefs) = std::fs::read(config.join("app.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
            .and_then(|v| v.get("transfers").cloned())
            .and_then(|t| serde_json::from_value::<crate::tuning::TransferPrefs>(t).ok())
    {
        crate::tuning::apply(prefs);
    }
    super::core_at(super::live::Paths { config, data }).map(|_| ())
}

// ---------------------------------------------------------------- Android (BackupNative.kt)

#[cfg(target_os = "android")]
mod android {
    use std::os::fd::FromRawFd;

    use jni::{
        objects::{JClass, JObject, JString},
        sys::{jboolean, jint, jlong, jstring, JNI_FALSE, JNI_TRUE},
        JNIEnv,
    };

    use super::*;

    fn text(env: &mut JNIEnv, s: &JString) -> String {
        env.get_string(s).map(String::from).unwrap_or_default()
    }

    fn answer(env: &mut JNIEnv, s: String) -> jstring {
        env.new_string(s).map(|j| j.into_raw()).unwrap_or(std::ptr::null_mut())
    }

    /// Opens the engine for a worker (the application context, and the app's data, config and
    /// cache folders as Tauri resolves them: `dataDir`, `dataDir`, `cacheDir`).
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_app_kybl_mobile_BackupNative_init(
        mut env: JNIEnv,
        _: JClass,
        ctx: JObject,
        data: JString,
        config: JString,
        _cache: JString,
    ) -> jboolean {
        if let Err(e) = crate::platform::android::set_worker_context(&mut env, &ctx) {
            eprintln!("backup init: {e}");
            return JNI_FALSE;
        }
        let (data, config) = (text(&mut env, &data), text(&mut env, &config));
        match init_without_app(config.into(), data.into()) {
            Ok(()) => JNI_TRUE,
            Err(e) => {
                eprintln!("backup init: {e}");
                JNI_FALSE
            }
        }
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_app_kybl_mobile_BackupNative_call(mut env: JNIEnv, _: JClass, method: JString, args: JString) -> jstring {
        let (m, a) = (text(&mut env, &method), text(&mut env, &args));
        let out = call(&m, &a);
        answer(&mut env, out)
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_app_kybl_mobile_BackupNative_offer(mut env: JNIEnv, _: JClass, set_id: JString, items: JString) -> jstring {
        let (s, i) = (text(&mut env, &set_id), text(&mut env, &items));
        let out = offer(&s, &i);
        answer(&mut env, out)
    }

    /// Takes ownership of `fd` (from `ParcelFileDescriptor.detachFd()`): it is closed here.
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_app_kybl_mobile_BackupNative_upload(
        mut env: JNIEnv,
        _: JClass,
        set_id: JString,
        source_id: JString,
        _remote_path: JString,
        fd: jint,
        size: jlong,
        mtime: jlong,
    ) -> jstring {
        let (s, src) = (text(&mut env, &set_id), text(&mut env, &source_id));
        let out = if fd < 0 {
            serde_json::to_string(&UploadResult::err("failed", "Couldn't open this file.")).unwrap_or_default()
        } else {
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            upload(&s, &src, Source::File(file), size, mtime)
        };
        answer(&mut env, out)
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_app_kybl_mobile_BackupNative_cancel(_: JNIEnv, _: JClass) {
        cancel_all();
    }
}

// ---------------------------------------------------------------- iOS (KyblBackup, C ABI)

#[cfg(not(target_os = "android"))]
mod c_abi {
    use std::ffi::{c_char, CStr, CString};

    use super::*;

    unsafe fn text(p: *const c_char) -> String {
        if p.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }

    fn answer(s: String) -> *mut c_char {
        CString::new(s.replace('\0', "")).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
    }

    /// See the module table. Free the answer with `kybl_string_free`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn kybl_backup_call(method: *const c_char, args_json: *const c_char) -> *mut c_char {
        let (m, a) = unsafe { (text(method), text(args_json)) };
        answer(call(&m, &a))
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn kybl_backup_offer(set_id: *const c_char, items_json: *const c_char) -> *mut c_char {
        let (s, i) = unsafe { (text(set_id), text(items_json)) };
        answer(offer(&s, &i))
    }

    /// Uploads the exported file at `file_path` (the caller deletes it afterwards).
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn kybl_backup_upload(
        set_id: *const c_char,
        source_id: *const c_char,
        _remote_path: *const c_char,
        file_path: *const c_char,
        mtime_ms: i64,
    ) -> *mut c_char {
        let (s, src, path) = unsafe { (text(set_id), text(source_id), text(file_path)) };
        let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
        answer(upload(&s, &src, Source::Path(path.into()), size, mtime_ms))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn kybl_backup_cancel() {
        cancel_all();
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn kybl_string_free(s: *mut c_char) {
        if !s.is_null() {
            drop(unsafe { CString::from_raw(s) });
        }
    }
}
