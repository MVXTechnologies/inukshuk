#!/usr/bin/env bash
# Builds the Hermes + GWP-ASan repro harness (#648, eval_stress.cpp) for
# x86_64 against the APK's own native libraries, plus the control: Meta's
# libhermesvm.so (with fibers) from Maven Central, SHA-256-checked.
#
#   scripts/e2e/hermes-gwp-asan/build.sh <apk> <out-dir>
#
# out-dir/eval_stress, out-dir/ours/*.so (the APK's libhermesvm, libjsi,
# libfbjni, libc++_shared), out-dir/meta/libhermesvm.so. Runs in the E2E build
# job (NDK and the prebuild's android/ present); run.sh uses the result.
set -euo pipefail
APK=${1:?apk}
OUT=${2:?out-dir}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
ABI=x86_64

mkdir -p "$OUT/ours" "$OUT/meta" "$OUT/include"
unzip -q -o -j "$APK" "lib/$ABI/libhermesvm.so" "lib/$ABI/libjsi.so" "lib/$ABI/libfbjni.so" \
  "lib/$ABI/libc++_shared.so" -d "$OUT/ours"

# Hermes's public headers from the AAR the app build used (same version).
VERSION=$(node -p "require('$ROOT/plugins/patched-hermes/build.json').version")
AAR="$ROOT/android/patched-hermes/m2/com/facebook/hermes/hermes-android/$VERSION/hermes-android-$VERSION-release.aar"
unzip -q -o "$AAR" 'prefab/modules/hermesvm/include/*' -d "$OUT/aar"
cp -R "$OUT/aar/prefab/modules/hermesvm/include/." "$OUT/include/"
rm -rf "$OUT/aar"

# Control: Meta's build of the same version, which runs eval on fibers.
url="https://repo1.maven.org/maven2/com/facebook/hermes/hermes-android/$VERSION/hermes-android-$VERSION-release.aar"
curl -fsSL --retry 3 --retry-all-errors -o "$OUT/meta.aar" "$url"
sha=$(curl -fsSL --retry 3 --retry-all-errors "$url.sha256")
echo "$sha  $OUT/meta.aar" | sha256sum -c
unzip -q -o -j "$OUT/meta.aar" "jni/$ABI/libhermesvm.so" -d "$OUT/meta"
rm -f "$OUT/meta.aar"

NDK=$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)
CXX="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/clang++"
# The APK's libc++_shared, not a static libc++: JSI passes std:: types across
# the library boundary.
"$CXX" --target="$ABI-linux-android24" -std=c++20 -O1 -fno-omit-frame-pointer \
  -I "$OUT/include" -I "$ROOT/node_modules/react-native/ReactCommon/jsi" \
  "$HERE/eval_stress.cpp" -o "$OUT/eval_stress" \
  -nostdlib++ -L "$OUT/ours" -lhermesvm -ljsi -lc++_shared
echo "built $OUT/eval_stress with $(basename "$NDK")"
node "$ROOT/plugins/patched-hermes/verify-hermes.js" describe "$OUT/ours" "$OUT/meta"
