#!/usr/bin/env bash
# Builds Kybl.app signed with the self-signed certificate from ~/.s3-browser-signing, the same one
# CI uses for releases. Every build then has the same signature, so the macOS keychain remembers
# "Always Allow", and the app shows no company name (unlike the Apple Development certificate).
#
#   scripts/build-local.sh            build only
#   scripts/build-local.sh --install  also put it in /Applications. A running Kybl is left alone
#                                     (its terminals may hold work): the new build starts the next
#                                     time Kybl is opened. When Kybl isn't running it is opened.
#   scripts/build-local.sh --install --restart   also quits a running Kybl and opens the new one
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
  # only the installed app counts: other Kybl bundles on this machine (the one just built, a
  # worktree's) are not ours to touch. A Kybl still running from a bundle an earlier install
  # moved aside (/Applications/.Kybl.app.old*) is the installed app too, and ps comm shows the
  # real path it runs from
  installed_running() {
    local pid
    for pid in $(pgrep -x kybl 2>/dev/null); do
      case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
        /Applications/Kybl*.app/Contents/MacOS/kybl | /Applications/.Kybl.app.old*/Contents/MacOS/kybl) return 0 ;;
      esac
    done
    return 1
  }
  running=0
  installed_running && running=1
  if [ "$running" = 1 ] && [ "${2:-}" = "--restart" ]; then
    # quit through the app, so it asks about what is still running (transfers, unsaved edits, a
    # program in a terminal) and cleans up (drives unmount, edit copies sync); never killed
    osascript -e 'tell application id "app.kybl.desktop" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      installed_running || break
      sleep 0.5
    done
    if installed_running; then
      echo "Kybl is still running (it asked, or you chose Keep running): the new build is installed and starts next time you open it."
    else
      running=0
    fi
  fi
  # swapped in with renames, not deleted in place: a Kybl that is still running keeps the files it
  # has open, and the new bundle is complete before it takes the name
  stage="/Applications/.Kybl.app.new"
  old="/Applications/.Kybl.app.old"
  rm -rf "$stage"
  # an earlier build moved aside is removed only when no running Kybl uses it. The launch command
  # line is no proof: a Kybl started from /Applications keeps that text after its bundle is moved
  # to .old, so the real files each process holds open (lsof) and its real executable (ps comm)
  # are compared; when either cannot be read, the bundle stays (a leftover folder is harmless)
  in_use() {
    local prev="$1" pid seen
    for pid in $(pgrep -x kybl 2>/dev/null); do
      seen=$(lsof -p "$pid" -Fn 2>/dev/null) || return 0
      [ -n "$seen" ] || return 0
      case "$seen" in *"$prev/"*) return 0 ;; esac
      case "$(ps -o comm= -p "$pid" 2>/dev/null)" in *"$prev/"*) return 0 ;; esac
      case "$(ps -o command= -p "$pid" 2>/dev/null)" in *"$prev/"*) return 0 ;; esac
    done
    return 1
  }
  for prev in /Applications/.Kybl.app.old*; do
    [ -e "$prev" ] || continue
    in_use "$prev" || rm -rf "$prev"
  done
  [ -e "$old" ] && old="/Applications/.Kybl.app.old.$$"
  cp -R "$APP" "$stage"
  [ -e /Applications/Kybl.app ] && mv /Applications/Kybl.app "$old"
  mv "$stage" /Applications/Kybl.app
  # the running Kybl still reads from the moved-aside build: it is removed on a later install
  [ "$running" = 1 ] || rm -rf "$old"
  if [ "$running" = 1 ]; then
    echo "Installed. Kybl is still running the old build; the new one starts the next time you open Kybl."
  else
    open /Applications/Kybl.app
    echo "Installed and launched."
  fi
fi
