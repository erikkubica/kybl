#!/usr/bin/env bash
# Builds Kybl.app signed with the self-signed certificate from ~/.s3-browser-signing, the same one
# CI uses for releases. Every build then has the same signature, so the macOS keychain remembers
# "Always Allow", and the app shows no company name (unlike the Apple Development certificate).
#
#   scripts/build-local.sh            build only
#   scripts/build-local.sh --install  also replace /Applications/Kybl.app and relaunch it
set -euo pipefail
cd "$(dirname "$0")/.."

DIR="$HOME/.s3-browser-signing"
KC="$DIR/kybl-signing.keychain-db"
# Sign by SHA-1 hash (the name can match other identities). Kept outside the repo, in $DIR/identity-hash.txt,
# or pass KYBL_SIGNING_HASH.
HASH="${KYBL_SIGNING_HASH:-$(cat "$DIR/identity-hash.txt" 2>/dev/null || true)}"
[ -n "$HASH" ] || { echo "Set KYBL_SIGNING_HASH or put the identity hash in $DIR/identity-hash.txt"; exit 1; }
[ -f "$KC" ] || { echo "Missing $KC. See $DIR/README.txt"; exit 1; }

# The built-in sign-in clients (Google Drive, OneDrive, Dropbox) are compiled in from KYBL_* variables,
# as release.yml does from the repo secrets. Locally they come from $DIR/oauth.env (KEY=value lines),
# kept outside the repo like the signing files.
if [ -f "$DIR/oauth.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/oauth.env"
  set +a
fi

security unlock-keychain -p "$(cat "$DIR/password.txt")" "$KC"
OLD_LIST="$(security list-keychains -d user | tr -d '"')"
restore() { security list-keychains -d user -s $OLD_LIST; }
trap restore EXIT
security list-keychains -d user -s "$KC" $OLD_LIST

APPLE_SIGNING_IDENTITY="$HASH" pnpm tauri build --bundles app
APP="src-tauri/target/release/bundle/macos/Kybl.app"
codesign --verify --strict "$APP"
codesign -dvv "$APP" 2>&1 | grep -E "Identifier=|Authority|TeamIdentifier"

if [ "${1:-}" = "--install" ]; then
  pkill -f "Kybl.app/Contents/MacOS/kybl" || true
  sleep 1
  rm -rf /Applications/Kybl.app
  cp -R "$APP" /Applications/
  open /Applications/Kybl.app
  echo "Installed and launched."
fi
