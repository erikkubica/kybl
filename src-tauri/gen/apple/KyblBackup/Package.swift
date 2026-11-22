// swift-tools-version:5.3
// Phone backup on iOS (WP-C): Photos access, enumeration and export, Files-app folders and the
// background tasks. Built and linked into the Rust library by build.rs, registered from
// src/backup/mod.rs. `KyblBackupFFI` declares the Rust entry points (src/backup/headless.rs)
// for Swift. `.tauri/tauri-api` is copied by build.rs.

import PackageDescription

let package = Package(
  name: "kybl-backup",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(name: "kybl-backup", type: .static, targets: ["kybl-backup"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(name: "KyblBackupFFI", path: "FFI"),
    .target(
      name: "kybl-backup",
      dependencies: [.byName(name: "Tauri"), "KyblBackupFFI"],
      path: "Sources")
  ]
)
