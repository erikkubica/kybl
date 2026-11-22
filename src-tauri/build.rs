fn main() {
    #[cfg(target_os = "macos")]
    ios_plugins();
    tauri_build::build()
}

/// Builds the Swift packages (`gen/apple/KyblConnect`, `gen/apple/KyblPlatform`) into the iOS
/// library, the way a Tauri plugin crate links its `ios` folder: Tauri's Swift API is copied next
/// to it (`gen/apple/.tauri/tauri-api`, ignored by git) and the package is linked statically.
#[cfg(target_os = "macos")]
fn ios_plugins() {
    use std::path::{Path, PathBuf};
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("ios") {
        return;
    }
    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let name = e.file_name();
            if [".build", "Package.resolved", "Tests"].iter().any(|s| name == *s) {
                continue;
            }
            let (src, dst) = (e.path(), to.join(&name));
            if e.file_type().unwrap().is_dir() {
                copy(&src, &dst);
            } else {
                std::fs::copy(&src, &dst).unwrap();
            }
        }
    }
    let apple = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("gen/apple");
    let api = std::env::var("DEP_TAURI_IOS_LIBRARY_PATH").expect("tauri exports its iOS library path");
    let target = apple.join(".tauri/tauri-api");
    let _ = std::fs::remove_dir_all(&target);
    copy(Path::new(&api), &target);
    println!("cargo:rerun-if-changed=gen/apple/KyblConnect/Package.swift");
    println!("cargo:rerun-if-changed=gen/apple/KyblPlatform/Package.swift");
    println!("cargo:rerun-if-changed=gen/apple/KyblPlatform/Sources");
    println!("cargo:rerun-if-changed=gen/apple/KyblConnect/Sources");
    tauri_utils::build::link_apple_library("kybl-connect", apple.join("KyblConnect"));
    // open / share / Photos / haptics / app lock / background time (src/platform.rs)
    tauri_utils::build::link_apple_library("kybl-platform", apple.join("KyblPlatform"));
}
