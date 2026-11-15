<img src="src-tauri/icons/128x128@2x.png" width="112" alt="Kybl icon: a white enamel bucket with red dots">

# Kybl

A fast, native desktop S3 browser (Tauri 2 + React + Rust) for any S3-compatible storage:
Hetzner Object Storage, AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO, Ceph …

## Features
- **Connections** with presets; secret keys are stored in the OS keychain, never in a file.
- **List and grid view** (thumbnail size slider, sorting). Thumbnails are generated locally:
  JPEGs use the photo's embedded EXIF thumbnail (only the first 256 KB is read), other images are
  downloaded and resized once. All thumbnails are cached on disk, so revisits are instant.
- **Browse** folders with breadcrumbs, lazy paging for huge folders, recursive search in a folder.
- **Details panel** with previews: images, video, audio, PDF, text.
- **Upload** files or folders (button or drag & drop from Finder) with multipart for big files.
- **Download** files or whole folders, **delete**, **rename** (files and folders), **new folder**.
- **Share links** (presigned URLs, 1 hour / 1 day / 7 days), copy `s3://` URI.
- **Transfer queue** with speed, ETA, cancel and retry.
- **Folder sync** between a local folder and an S3 prefix, upload or download direction, with ignore
  rules. Runs from the menu bar with the window closed. Deletions are opt-in, local files go to the
  Trash, and sync refuses to mass-delete when one side suddenly looks empty.
- Keyboard: `⌘A` select all, `Delete` delete, `⌘R` refresh, `⌘F` search, arrows navigate, `Backspace` up.

## Develop
```bash
pnpm install
pnpm tauri dev          # run
pnpm tauri build        # release bundle (.app / .dmg)
pnpm dev                # UI only, in a browser, with demo data (src/devMock.ts); handy for design work
```
Requires Rust, Node and pnpm. Local macOS builds are ad-hoc signed; set `APPLE_SIGNING_IDENTITY`
to sign with your own identity.

Icons are generated from one drawing: `python3 scripts/build-icons.py` (needs `rsvg-convert`).

## iOS and Android
The same Rust backend runs on phones (Tauri 2 mobile), with its own touch UI in `src/mobile/`
(picked automatically on iOS/Android; open `pnpm dev` with `?mobile` to work on it in a browser).
Folder sync, the menu-bar icon and launch at login are desktop only.

- **Secret keys**: iOS Keychain on iPhone; on Android a file in the app's private storage,
  excluded from backups (`data_extraction_rules.xml`).
- **Downloads** go to *Files › On My iPhone › Kybl* on iOS and `Download/Kybl` on Android.
- **Uploads** use the system photo or document picker; Android `content://` files are copied to the
  cache first, then uploaded (multipart for big files) and the copy removed.
- **Connect Kybl Storage**: the account site opens in a Custom Tab on Android
  (`KyblConnectPlugin.kt`) or a sign-in sheet on iOS (`ASWebAuthenticationSession`, the Swift
  package in `gen/apple/KyblConnect`, linked by `build.rs`) and comes back to `kybl://connect` with
  the code; the rest is the desktop flow. Debug builds sign in against `127.0.0.1:8080`. The iOS
  simulator shares the Mac's loopback; on the Android emulator run `adb reverse tcp:8080 tcp:8080`
  (and `tcp:9000` for a local S3).

```bash
pnpm tauri ios dev                      # simulator or a connected iPhone (needs Xcode, xcodegen)
pnpm tauri ios build --debug --target aarch64-sim
pnpm tauri android dev                  # emulator or a device (needs Android SDK + NDK, JDK 17/21)
pnpm tauri android build --apk --target aarch64
```
Set `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME` for Android. The native projects live in
`src-tauri/gen/apple` and `src-tauri/gen/android` (the Kotlin `DocInfoPlugin` reads picked files'
names and sizes, `KyblConnectPlugin` handles the Kybl Storage sign-in). Mobile builds use the bundle id `app.kybl.mobile` (`tauri.ios.conf.json`,
`tauri.android.conf.json`). Release iOS builds need your Apple team: set `bundle.iOS.developmentTeam`.

## Install
Download the latest build from [Releases](../../releases).

- **macOS**: the app is signed with a self-signed certificate but not notarized, so the first launch
  asks once: open **System Settings → Privacy & Security** and click **Open Anyway**. Updates keep the
  same signature, so the keychain doesn't ask again for your secret keys.
- **Windows**: if SmartScreen warns, click **More info → Run anyway**.
- **Linux**: AppImage, `.deb` or `.rpm`. Secret keys need a Secret Service (GNOME Keyring, KWallet).

## Releasing
1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. `git tag v0.2.0 && git push --tags`. The `Release` workflow builds macOS (Apple Silicon and
   Intel), Windows and Linux and attaches everything to a **draft** release. Publish it when it looks right.

macOS signing needs two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE` | the self-signed `.p12`, base64-encoded |
| `MACOS_CERTIFICATE_PASSWORD` | its password |

Without them the macOS build is ad-hoc signed, which works but makes the keychain ask again after every update.
To make a certificate: create a key and a self-signed certificate with the `codeSigning` extended key usage
and export both as a `.p12`. Keep a backup: a new certificate means every user gets one more keychain prompt.

## Notes
- S3 has no server-side image resizing, so thumbnails are made in the app. Video thumbnails are not generated yet.
- Folders in S3 are just key prefixes: renaming a folder copies every object and then deletes the originals.

## Folder sync tests

The sync engine has end-to-end tests that run against a throwaway S3 server (skipped unless
`KYBL_TEST_ENDPOINT` is set). With rclone:

```bash
mkdir -p /tmp/s3root/testbucket
rclone serve s3 --auth-key testkey,testsecret --addr 127.0.0.1:9123 /tmp/s3root &
cd src-tauri && KYBL_TEST_ENDPOINT=http://127.0.0.1:9123 cargo test --lib sync::tests
```

rclone's S3 server can't do multipart uploads, so the large-file upload test needs another server,
for example `docker run -d -p 9125:9090 adobe/s3mock` plus `curl -X PUT localhost:9125/testbucket`.
Run `cargo test --lib transfers` with `KYBL_TEST_MULTIPART_ENDPOINT` pointing at it. Setting `KYBL_TEST_SLOW=1`
and putting a rate-limited proxy in front also checks that progress moves inside a single file.

## License

[MIT](LICENSE)
