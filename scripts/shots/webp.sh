#!/usr/bin/env bash
# Turns the PNGs in $OUT (run.sh, phone.sh) into the website's WebP shots, at most 1800px wide.
set -euo pipefail
cd "$(dirname "$0")"
OUT=${OUT:-/tmp/kybl-shots}
DEST=../../website/assets/shots
names="$(grep -v '^#' shots.txt | awk '{print $1}') phone"
for n in $names; do
  for x in "" -dark; do
    src="$OUT/$n$x.png"
    if [ ! -f "$src" ]; then echo "missing $src"; continue; fi
    w=$(magick identify -format %w "$src")
    if [ "$w" -gt 1800 ]; then
      magick "$src" -resize 1800x "$OUT/.resized.png"
      src="$OUT/.resized.png"
    fi
    cwebp -quiet -q 80 -alpha_q 90 "$src" -o "$DEST/$n$x.webp"
  done
done
