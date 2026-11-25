//! Android over JNI, on the application context: works with or without the app's screen (the
//! process can outlive it while transfers run, see transfer/notice.rs).
//!
//! Kotlin → Rust: `KyblNative.kt` declares the `external` functions exported at the bottom.
//! Rust → Kotlin: static methods of `Platform.kt` and `SecretBox.kt`.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use jni::{
    objects::{GlobalRef, JByteArray, JClass, JObject, JString},
    JNIEnv,
};
use tauri::AppHandle;

use super::vault::Sealer;
use crate::app::mobile::PickedFile;

/// One of the app's classes, loaded once through the application context and kept (a global
/// reference, so it survives the call that loaded it).
fn app_class(env: &mut JNIEnv, context: &JObject, name: &str) -> jni::errors::Result<GlobalRef> {
    static CLASSES: Mutex<Option<HashMap<String, GlobalRef>>> = Mutex::new(None);
    if let Some(c) = CLASSES.lock().unwrap().as_ref().and_then(|m| m.get(name)) {
        return Ok(c.clone());
    }
    let loader = env.call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?.l()?;
    let jname = env.new_string(name)?;
    let class = env.call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[(&jname).into()])?.l()?;
    let global = env.new_global_ref(class)?;
    CLASSES.lock().unwrap().get_or_insert_with(HashMap::new).insert(name.to_string(), global.clone());
    Ok(global)
}

/// WP-C: the application context handed over by a background backup worker that started the
/// process without the app's screen, so tao never registered one. Kept apart from
/// `ndk_context`, which tao fills in (and asserts it was empty) when a screen opens later.
static WORKER_CONTEXT: std::sync::OnceLock<(usize, GlobalRef)> = std::sync::OnceLock::new();

/// Called by `backup::headless` with the worker's application context.
pub(crate) fn set_worker_context(env: &mut JNIEnv, context: &JObject) -> jni::errors::Result<()> {
    if WORKER_CONTEXT.get().is_none() {
        let vm = env.get_java_vm()?;
        let global = env.new_global_ref(context)?;
        let _ = WORKER_CONTEXT.set((vm.get_java_vm_pointer() as usize, global));
    }
    Ok(())
}

/// The JVM and the application context: a worker's when one was handed over (it is ready
/// before any screen), else the one tao registered.
fn vm_and_context() -> (*mut std::ffi::c_void, *mut std::ffi::c_void) {
    if let Some((vm, ctx)) = WORKER_CONTEXT.get() {
        return (*vm as *mut _, ctx.as_obj().as_raw() as *mut _);
    }
    let ctx = ndk_context::android_context();
    (ctx.vm(), ctx.context())
}

/// Runs `f` with one of the app's classes and the application context (registered by tao at
/// start-up), which lives as long as the process.
///
/// The thread stays attached to the JVM and never returns to Java, so local references made here
/// would pile up for good: everything runs in a local frame, freed when `f` returns. A Java
/// exception comes back as its own text ("java.lang.IllegalStateException: …").
pub(crate) fn with_class<T>(
    name: &str,
    f: impl FnOnce(&mut JNIEnv, &JObject, &JClass) -> jni::errors::Result<T>,
) -> Result<T, String> {
    use jni::JavaVM;
    let (vm_ptr, ctx_ptr) = vm_and_context();
    let vm = unsafe { JavaVM::from_raw(vm_ptr.cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread_permanently().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx_ptr.cast()) };
    let result = env.with_local_frame(16, |env| -> jni::errors::Result<T> {
        let class = app_class(env, &context, name)?;
        f(env, &context, class.as_obj().into())
    });
    result.map_err(|e| java_error(&mut env, e))
}

/// The text of the pending Java exception (cleared here), else of `e`.
fn java_error(env: &mut JNIEnv, e: jni::errors::Error) -> String {
    if !env.exception_check().unwrap_or(false) {
        return e.to_string();
    }
    let Ok(thrown) = env.exception_occurred() else { return e.to_string() };
    let _ = env.exception_clear();
    let text = env.with_local_frame(4, |env| -> jni::errors::Result<String> {
        let s = env.call_method(&thrown, "toString", "()Ljava/lang/String;", &[])?.l()?;
        Ok(env.get_string(&JString::from(s))?.into())
    });
    let _ = env.exception_clear();
    let _ = env.delete_local_ref(thrown);
    text.unwrap_or_else(|_| e.to_string())
}

/// `Platform.<method>(Context): String`
fn platform_string(method: &str) -> Result<String, String> {
    with_class("app.kybl.mobile.Platform", |env, context, class| {
        let s = env.call_static_method(class, method, "(Landroid/content/Context;)Ljava/lang/String;", &[context.into()])?.l()?;
        Ok(env.get_string(&JString::from(s))?.into())
    })
}

/// Mobile data or a metered Wi-Fi. Transfers ask this every part and every few megabytes, so the
/// answer is asked of Android at most every few seconds.
pub fn metered() -> bool {
    static LAST: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    if let Some((at, m)) = *LAST.lock().unwrap()
        && at.elapsed() < Duration::from_secs(3)
    {
        return m;
    }
    let m = with_class("app.kybl.mobile.Platform", |env, context, class| {
        env.call_static_method(class, "isMetered", "(Landroid/content/Context;)Z", &[context.into()])?.z()
    })
    .unwrap_or_else(|e| {
        eprintln!("metered: {e}");
        false
    });
    *LAST.lock().unwrap() = Some((Instant::now(), m));
    m
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Storage {
    sdk: u32,
    /// the shared Download folder of this user (work profiles have their own)
    public_downloads: String,
    /// the app's own downloads folder in shared storage, which needs no permission
    app_downloads: String,
    /// WRITE_EXTERNAL_STORAGE (Android 7–10 only; later versions don't need it)
    can_write: bool,
}

/// Where downloads go, and that place is the one actually used:
/// - Android 11+: `Download/Kybl`, which an app may write to without a permission.
/// - Android 7–10: the same with the storage permission (asked for on the first download),
///   else the app's own folder (`Android/data/app.kybl.mobile/files/Download`), which file
///   managers show too.
///
/// Android 10 counts as "old" here because the manifest asks for the legacy storage model
/// (`requestLegacyExternalStorage`): without it Android 10 only allows MediaStore, not paths.
pub async fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let s: Storage = serde_json::from_str(&platform_string("storage")?).map_err(|e| e.to_string())?;
    let mut allowed = s.sdk >= 30 || s.can_write;
    if !allowed {
        allowed = super::ask_storage(app).await;
    }
    if allowed && !s.public_downloads.is_empty() {
        let shared = PathBuf::from(&s.public_downloads).join("Kybl");
        let probe = shared.join(".kybl-write-test");
        let ok = std::fs::create_dir_all(&shared).is_ok() && std::fs::write(&probe, b"").is_ok();
        let _ = std::fs::remove_file(&probe);
        if ok {
            return Ok(shared);
        }
    }
    if s.app_downloads.is_empty() {
        return Err("There's no storage to save downloads to.".into());
    }
    Ok(PathBuf::from(s.app_downloads))
}

/// The Keystore-backed sealer for the secret keys (`SecretBox.kt`, AES-256-GCM).
pub struct Keystore;

fn secret_box(method: &str, input: &[u8]) -> Result<Vec<u8>, String> {
    with_class("app.kybl.mobile.SecretBox", |env, _, class| {
        let arr = env.byte_array_from_slice(input)?;
        let out = env.call_static_method(class, method, "([B)[B", &[(&arr).into()])?.l()?;
        env.convert_byte_array(JByteArray::from(out))
    })
}

impl Sealer for Keystore {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        secret_box("seal", plain)
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        secret_box("open", sealed)
    }
}

/// Seals bytes with the app's Keystore key.
#[allow(dead_code)]
pub fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Keystore.seal(bytes)
}

/// Opens what `protect` sealed.
#[allow(dead_code)]
pub fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Keystore.open(bytes)
}

// ---- called from Kotlin (KyblNative.kt) -------------------------------------------------------

/// Files shared into Kybl, copied into the cache by `ShareIntake.kt`, as JSON
/// `[{path, name, size}]`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_kybl_mobile_KyblNative_sharedFiles(mut env: JNIEnv, _: JClass, json: JString) {
    let Ok(json) = env.get_string(&json).map(String::from) else { return };
    match serde_json::from_str::<Vec<PickedFile>>(&json) {
        Ok(files) => super::shared_arrived(files),
        Err(e) => eprintln!("shared files: {e}"),
    }
}

/// "Cancel" on the transfer notification.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_kybl_mobile_KyblNative_cancelAllTransfers(_: JNIEnv, _: JClass) {
    if let Some(app) = super::APP.get() {
        crate::transfer::notice::cancel_all(app);
    }
}

/// The transfer notification was tapped.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_kybl_mobile_KyblNative_openTransfers(_: JNIEnv, _: JClass) {
    super::open_transfers();
}
