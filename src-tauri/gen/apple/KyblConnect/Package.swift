// swift-tools-version:5.3
// "Connect Kybl Storage" on iOS: built and linked into the Rust library by build.rs, registered
// from src/kybl_connect.rs. `.tauri/tauri-api` is copied there by build.rs too.

import PackageDescription

let package = Package(
  name: "kybl-connect",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    .library(name: "kybl-connect", type: .static, targets: ["kybl-connect"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "kybl-connect",
      dependencies: [.byName(name: "Tauri")],
      path: "Sources")
  ]
)
