//! Android over JNI, on the application context: works with or without the app's screen (the
//! process can outlive it while transfers run, see transfer_notice.rs).
//!
//! Kotlin → Rust: `KyblNative.kt` declares the `external` functions exported at the bottom.
//! Rust → Kotlin: static methods of `Platform.kt` and `SecretBox.kt`.

use std::path::PathBuf;

use jni::{
    objects::{JByteArray, JClass, JObject, JString},
    JNIEnv,
};
use tauri::AppHandle;

use super::vault::Sealer;
use crate::mobile::PickedFile;

/// Runs `f` with one of the app's classes, loaded through the application context (registered
/// by tao at start-up), which lives as long as the process.
pub(crate) fn with_class<T>(
    name: &str,
    f: impl FnOnce(&mut JNIEnv, &JObject, &JClass) -> jni::errors::Result<T>,
) -> Result<T, String> {
    use jni::JavaVM;
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread_permanently().map_err(|e| e.to_string())?;
    let result = (|| {
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let loader = env.call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?.l()?;
        let name = env.new_string(name)?;
        let class: JClass = env
            .call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[(&name).into()])?
            .l()?
            .into();
        f(&mut env, &context, &class)
    })();
    if result.is_err() && env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    result.map_err(|e| e.to_string())
}

/// `Platform.<method>(Context): String`
fn platform_string(method: &str) -> Result<String, String> {
    with_class("app.kybl.mobile.Platform", |env, context, class| {
        let s = env.call_static_method(class, method, "(Landroid/content/Context;)Ljava/lang/String;", &[context.into()])?.l()?;
        Ok(env.get_string(&JString::from(s))?.into())
    })
}

pub fn metered() -> bool {
    with_class("app.kybl.mobile.Platform", |env, context, class| {
        env.call_static_method(class, "isMetered", "(Landroid/content/Context;)Z", &[context.into()])?.z()
    })
    .unwrap_or_else(|e| {
        eprintln!("metered: {e}");
        false
    })
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
        crate::transfer_notice::cancel_all(app);
    }
}

/// The transfer notification was tapped.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_kybl_mobile_KyblNative_openTransfers(_: JNIEnv, _: JClass) {
    super::open_transfers();
}
