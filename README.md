<img src="src-tauri/icons/128x128@2x.png" width="112" alt="Kybl icon: a white enamel bucket with red dots">

# Kybl

A fast, native desktop S3 browser (Tauri 2 + React + Rust) for any S3-compatible storage:
Hetzner Object Storage, AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO, Ceph …

## Features
- **Connections** with presets; secret keys are stored in the OS keychain, never in a file.
- **Kybl Storage**: no bucket yet? Sign in with your email and the app connects itself (see below).
- **List and grid view** (thumbnail size slider, sorting, folders first). Thumbnails are generated locally:
  JPEGs use the photo's embedded EXIF thumbnail (only the first 256 KB is read), other images are
  downloaded and resized once. All thumbnails are cached on disk, so revisits are instant.
- **Browse** folders with breadcrumbs, lazy paging for huge folders, recursive search in a folder.
- **Details panel** with previews: images, video, audio, PDF, text. Video and audio stream, no download first.
- **Upload** files or folders (button or drag & drop from Finder) with multipart for big files.
- **Download** files or whole folders, **delete**, **rename** (files and folders), **new folder**.
- **Move and copy** files and folders: drag them onto a folder or a breadcrumb, or pick a destination.
- **Folder sizes** on demand (S3 has none, so Kybl counts them and keeps the result).
- **Share links** (presigned URLs, 1 hour / 1 day / 7 days), copy `s3://` URI.
- **Transfer queue** with speed, ETA, cancel and retry.
- **Folder sync** between a local folder and an S3 prefix, upload or download direction, with ignore
  rules. Runs from the menu bar with the window closed. Deletions are opt-in, local files go to the
  Trash, and sync refuses to mass-delete when one side suddenly looks empty.
- **Settings**: light/dark/system theme, colour schemes and accents, fonts, text size, density,
  date and size formats, launch at login, reopen the last folder, confirm before delete.
- **Phones**: the same app on Android and iPhone, with a touch UI; transfers keep going in the
  background and dropped downloads resume where they stopped (see below).
- Keyboard: `⌘A` select all, `Delete` delete, `⌘R` refresh, `⌘F` search, arrows navigate, `Backspace` up.

## Kybl Storage
S3 storage run by Kybl, for people without a bucket of their own. Choose **Connect Kybl Storage**,
approve the computer or phone in the browser (or with a code on another device) and the app gets
its own access key: nothing to copy or type. The account site, [app.kybl.app](https://app.kybl.app/),
also makes access keys for any other S3 tool, and shows usage, devices and buckets.

- **10 GB free**; bigger plans are coming.
- **Encrypted at rest.** Every file is encrypted with a key of its own bucket (SSE-C, AES-256)
  before it touches the disk. The storage provider, its staff, its backups and anyone holding only
  the storage side see ciphertext; a read without the key fails. File names and sizes stay visible
  there.
- **Not end-to-end.** Kybl's servers do the encrypting, so they see files as they pass through.
  For data only you should ever read, encrypt it before uploading. Clients that send their own
  SSE-C key keep it: Kybl uses theirs and can't read those files either.
- Stored in the EU (Germany).

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
- **In the background**: on Android, uploads and downloads run in a foreground service
  (`TransferService.kt`, driven by `src/transfer_notice.rs`) that keeps the app from being frozen
  and shows the progress as a notification. They keep going when the app is swiped away in the
  app switcher: the process outlives its screen until the last transfer ends, and opening Kybl
  again picks the running transfers back up. A download whose connection drops (backgrounded on iOS,
  network change) picks up where it stopped with a ranged request for the same version of the file.
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
`tauri.android.conf.json`). Signed iOS builds (App Store, TestFlight) would need an Apple team in `bundle.iOS.developmentTeam`;
the release workflow instead turns signing off and zips the archived `Kybl.app` into an unsigned `.ipa`.

## Install
Download the latest build from [Releases](../../releases).

- **macOS**: the app is signed with a self-signed certificate but not notarized, so the first launch
  asks once: open **System Settings → Privacy & Security** and click **Open Anyway**. Updates keep the
  same signature, so the keychain doesn't ask again for your secret keys.
- **Windows**: if SmartScreen warns, click **More info → Run anyway**.
- **Linux**: AppImage, `.deb` or `.rpm`. Secret keys need a Secret Service (GNOME Keyring, KWallet).
- **iPhone / iPad**: `Kybl.ipa` is unsigned (no Apple Developer account), so it is sideloaded:
  in [AltStore](https://altstore.io) or [SideStore](https://sidestore.io) add the source
  `https://github.com/erikkubica/kybl/releases/latest/download/altstore-source.json` and install
  Kybl from it (new releases then show up as updates), or install the `.ipa` with Sideloadly.
  A free Apple ID signs apps for 7 days; AltStore and SideStore renew them on their own.

## Releasing
1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. `git tag v0.3.2 && git push --tags`. The `Release` workflow builds macOS (Apple Silicon and
   Intel), Windows, Linux and an unsigned iOS `.ipa` (plus `altstore-source.json`, made by
   `scripts/altstore-source.mjs`) and attaches everything to a **draft** release. Publish it when it looks right.

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
