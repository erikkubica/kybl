#!/usr/bin/env bash
# Captures every shot in shots.txt (or only the names given) in light and dark into $OUT (PNG, 2x).
# Needs `pnpm dev` on port 1420. Convert with: cwebp -q 82 in.png -o website/assets/shots/name.webp
set -euo pipefail
cd "$(dirname "$0")"
OUT=${OUT:-/tmp/kybl-shots}
mkdir -p "$OUT"
grep -v '^#' shots.txt | while read -r name seed script w h; do
  [ -z "$name" ] && continue
  if [ $# -gt 0 ] && [[ " $* " != *" $name "* ]]; then continue; fi
  for scheme in light dark; do
    suffix=$([ "$scheme" = dark ] && echo "-dark" || true)
    echo "$OUT/$name$suffix.png $scheme $seed.json $script.js ${w:-1200} ${h:-750}"
  done
done | xargs -P 6 -L 1 sh -c 'node cap.mjs "$0" "$1" "$2" "$3" "$4" "$5" >/dev/null 2>"$0.err" || echo "failed $0"; [ -s "$0.err" ] && { echo "$0:"; cat "$0.err"; }; true'
