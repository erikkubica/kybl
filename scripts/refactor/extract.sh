#!/usr/bin/env bash
# Extracts AppShell lines <from>-<to> into src/shell/hooks/<hook>.ts, wires late names, tidies imports.
#   scripts/refactor/extract.sh <from> <to> <hook> [hintFile]
set -euo pipefail
from=$1 to=$2 hook=$3 hint=${4:-}
out=src/shell/hooks/$hook.ts
json=$(node scripts/refactor/extract-hook.mjs src/shell/AppShell.tsx AppShell "$from" "$to" "$hook" "$out")
out=$(echo "$json" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).out)')
echo "$json" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("returned:",j.returned.join(", "));console.log("late:",j.late.join(" "))'
lates=()
while IFS= read -r l; do lates+=("$l"); done < <(echo "$json" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8")).late.forEach(l=>console.log(l))')
if [ ${#lates[@]} -gt 0 ]; then node scripts/refactor/add-late.mjs "${lates[@]}"; fi
args=(src/shell/AppShell.tsx "$out" src/shell/lib/late.ts)
[ -n "$hint" ] && args=(--from "$hint" --at src/shell "${args[@]}")
node scripts/refactor/fix-imports.mjs "${args[@]}"
