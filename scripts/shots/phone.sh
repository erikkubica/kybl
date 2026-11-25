#!/usr/bin/env bash
# The phone app's shots (light and dark, 390x844 at 3x) into $OUT. Needs `pnpm dev` on port 1420.
set -euo pipefail
cd "$(dirname "$0")"
OUT=${OUT:-/tmp/kybl-shots}
mkdir -p "$OUT"
for n in phone-home phone-browse phone-view; do
  for scheme in light dark; do
    suffix=""
    if [ "$scheme" = dark ]; then suffix="-dark"; fi
    URL="http://localhost:1420/?shots&mobile" DPR=3 node cap.mjs "$OUT/$n$suffix.png" "$scheme" phone.json "$n.js" 390 844 &
  done
done
wait
