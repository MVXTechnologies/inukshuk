#!/usr/bin/env bash
# Build this tree's JS bundle (Hermes bytecode) with the PDF bench compiled in
# and swap it into a COPY of a simulator .app, then ad-hoc sign it.
#
#   scripts/pdf-bench/swap-ios-bundle.sh BASE.app OUT.app
#
# Install with `xcrun simctl install <udid> OUT.app`. JS-only changes are
# measured this way; native changes need a real build.
set -euo pipefail
BASE=$1
OUT=$2
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT"
rm -rf "${TMPDIR:-/tmp}/metro-cache"
env EXPO_PUBLIC_PDF_BENCH=1 npx expo export:embed --platform ios --dev false --minify true \
  --entry-file node_modules/expo-router/entry.js \
  --bundle-output "$WORK/main.jsbundle.js" --assets-dest "$WORK/assets" >"$WORK/export.log" 2>&1 \
  || { tail -30 "$WORK/export.log"; exit 1; }
grep -q PDF_BENCH "$WORK/main.jsbundle.js" || { echo "bench not in bundle"; exit 1; }
node_modules/hermes-compiler/hermesc/osx-bin/hermesc -emit-binary -O \
  -out "$WORK/main.jsbundle" "$WORK/main.jsbundle.js" -w
rm -rf "$OUT"
cp -R "$BASE" "$OUT"
cp "$WORK/main.jsbundle" "$OUT/main.jsbundle"
codesign --force --deep --sign - "$OUT" >/dev/null 2>&1
echo "built $OUT"
