// swift-tools-version:5.3
// Open / share / Photos / haptics / app lock / background time on iOS: built and linked into the
// Rust library by build.rs, registered from src/platform.rs. `.tauri/tauri-api` is copied by build.rs.

import PackageDescription

let package = Package(
  name: "kybl-platform",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(name: "kybl-platform", type: .static, targets: ["kybl-platform"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "kybl-platform",
      dependencies: [.byName(name: "Tauri")],
      path: "Sources")
  ]
)
