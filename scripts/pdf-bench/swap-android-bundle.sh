#!/usr/bin/env bash
# Build this tree's JS bundle (Hermes bytecode) with the PDF bench compiled in
# and swap it into an existing release APK, then debug-sign it.
#
#   scripts/pdf-bench/swap-android-bundle.sh BASE.apk OUT.apk [EXTRA_ENV=1 ...]
#
# The base APK supplies the native code (pull one off a device with
# `adb shell pm path com.inukshuk.app` + `adb pull`). JS-only changes (an
# OTA's worth) are measured this way; native changes need a real build.
set -euo pipefail
BASE=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
OUT_ABS=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
shift 2
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BT=/opt/homebrew/share/android-commandlinetools/build-tools/36.0.0
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}
export PATH="$JAVA_HOME/bin:$PATH"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT"
# Metro's transform cache is keyed by real paths shared across worktrees.
rm -rf "${TMPDIR:-/tmp}/metro-cache"
env EXPO_PUBLIC_PDF_BENCH=1 "$@" npx expo export:embed --platform android --dev false --minify true \
  --entry-file node_modules/expo-router/entry.js \
  --bundle-output "$WORK/index.android.bundle.js" --assets-dest "$WORK/res" >"$WORK/export.log" 2>&1 \
  || { tail -30 "$WORK/export.log"; exit 1; }
grep -q PDF_BENCH "$WORK/index.android.bundle.js" || { echo "bench not in bundle"; exit 1; }
node_modules/hermes-compiler/hermesc/osx-bin/hermesc -emit-binary -O \
  -out "$WORK/index.android.bundle" "$WORK/index.android.bundle.js" -w
mkdir -p "$WORK/apk/assets"
cp "$BASE" "$WORK/unsigned.apk"
cp "$WORK/index.android.bundle" "$WORK/apk/assets/index.android.bundle"
(cd "$WORK/apk" && zip -q -0 "$WORK/unsigned.apk" assets/index.android.bundle)
zip -q -d "$WORK/unsigned.apk" 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.MF' 'META-INF/*.EC' >/dev/null 2>&1 || true
"$BT/zipalign" -p -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
"$BT/apksigner" sign --ks ~/.android/debug.keystore --ks-pass pass:android --key-pass pass:android \
  --out "$OUT_ABS" "$WORK/aligned.apk"
echo "built $OUT_ABS ($(git rev-parse --short HEAD))"
