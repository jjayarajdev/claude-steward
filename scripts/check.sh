#!/usr/bin/env bash
# Steward check (A-0.1): validate + type-check + test, optionally mirror the source.
#   scripts/check.sh [mod-dir] [--mirror]
# mod-dir defaults to the newest ~/.claude/dev-mods/*/steward (D-9 dev location).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR=0; DIR=""
for a in "$@"; do [[ $a == --mirror ]] && MIRROR=1 || DIR=$a; done
if [[ -z $DIR ]]; then
  DIR=$(ls -dt "$HOME"/.claude/dev-mods/*/steward 2>/dev/null | head -1 || true)
fi
[[ -d $DIR ]] || { echo "check: no mod dir found (pass one)"; exit 2; }
echo "▸ mod: $DIR"

TSC=(npx -y -p typescript@5.6.3 tsc)
TMP=""
cleanup() { [[ -n $TMP ]] && rm -rf "$TMP"; }
trap cleanup EXIT

echo "▸ validate"; claude plugin validate "$DIR"

echo "▸ tsc"
if [[ -f $DIR/.claude-plugin/types/tsconfig.json ]]; then
  "${TSC[@]}" -p "$DIR"
else
  # Before first load the engine hasn't laid the types; use the skill's copy.
  T=$(ls -t /private/tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || true)
  [[ -n $T ]] || { echo "check: no engine types yet (load the mod or the plugin-authoring skill)"; exit 2; }
  TMP=$(mktemp -d)
  cat > "$TMP/tsconfig.json" <<JSON
{ "compilerOptions": { "target": "es2023", "lib": ["es2023"], "module": "esnext",
  "moduleResolution": "bundler", "strict": true, "noUncheckedIndexedAccess": true,
  "noEmit": true, "skipLibCheck": true, "jsx": "react", "jsxFactory": "h",
  "jsxFragmentFactory": "Fragment", "types": [] },
  "include": ["$T", "$DIR/hooks", "$DIR/types", "$DIR/tests"] }
JSON
  "${TSC[@]}" -p "$TMP"
fi

echo "▸ test"; claude plugin test "$DIR"

if (( MIRROR )); then
  echo "▸ mirror → $ROOT/steward"
  rsync -a --delete --exclude '.claude-plugin/types/' "$DIR"/ "$ROOT/steward/"
fi
echo "✓ check passed"
