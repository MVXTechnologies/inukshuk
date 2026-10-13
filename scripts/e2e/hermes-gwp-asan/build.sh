#!/usr/bin/env bash
# Builds the Hermes + GWP-ASan repro harness (#648, eval_stress.cpp) for
# x86_64 against the APK's own native libraries, plus the control: Meta's
# libhermesvm.so (with fibers) from Maven Central, SHA-256-checked.
#
#   scripts/e2e/hermes-gwp-asan/build.sh <apk> <out-dir>
#
# out-dir/eval_stress, out-dir/ours/*.so (the APK's libhermesvm, libjsi,
# libfbjni, libc++_shared), out-dir/meta/libhermesvm.so. Needs an NDK under
# $ANDROID_HOME/ndk and node_modules (JSI headers); run.sh uses the result.
set -euo pipefail
APK=${1:?apk}
OUT=${2:?out-dir}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
ABI=x86_64

mkdir -p "$OUT/ours" "$OUT/meta" "$OUT/include"
unzip -q -o -j "$APK" "lib/$ABI/libhermesvm.so" "lib/$ABI/libjsi.so" "lib/$ABI/libfbjni.so" \
  "lib/$ABI/libc++_shared.so" -d "$OUT/ours"

# Control: Meta's build of the same version, which runs eval on fibers. Its
# public headers are the ones the harness compiles against (same version as
# ours: only the build flags differ).
VERSION=$(node -p "require('$ROOT/plugins/patched-hermes/build.json').version")
url="https://repo1.maven.org/maven2/com/facebook/hermes/hermes-android/$VERSION/hermes-android-$VERSION-release.aar"
curl -fsSL --retry 3 --retry-all-errors -o "$OUT/meta.aar" "$url"
sha=$(curl -fsSL --retry 3 --retry-all-errors "$url.sha256")
echo "$sha  $OUT/meta.aar" | sha256sum -c
unzip -q -o -j "$OUT/meta.aar" "jni/$ABI/libhermesvm.so" -d "$OUT/meta"
unzip -q -o "$OUT/meta.aar" 'prefab/modules/hermesvm/include/*' -d "$OUT/aar"
cp -R "$OUT/aar/prefab/modules/hermesvm/include/." "$OUT/include/"
rm -rf "$OUT/aar" "$OUT/meta.aar"

# The NDK the APK's libraries (libc++_shared above all) were built with.
NDK_VERSION=$(node -p "require('$ROOT/plugins/patched-hermes/build.json').toolchain.ndk")
NDK="$ANDROID_HOME/ndk/$NDK_VERSION"
[ -x "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/clang++" ] || {
  echo "::error::NDK $NDK_VERSION is not installed under $ANDROID_HOME/ndk"
  exit 1
}
CXX="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/clang++"
# The APK's libc++_shared, not a static libc++: JSI passes std:: types across
# the library boundary.
"$CXX" --target="$ABI-linux-android24" -std=c++20 -O1 -fno-omit-frame-pointer \
  -I "$OUT/include" -I "$ROOT/node_modules/react-native/ReactCommon/jsi" \
  "$HERE/eval_stress.cpp" -o "$OUT/eval_stress" \
  -nostdlib++ -L "$OUT/ours" -lhermesvm -ljsi -lc++_shared
# libfbjni (needed by libhermesvm) lists libandroid.so as NEEDED but uses none
# of its symbols. The real one drags in most of the platform (libcrypto
# among others), and a plain shell executable crashed loading it before main
# (BoringSSL's HMAC, run 38351876994). An empty stand-in on LD_LIBRARY_PATH
# keeps the harness to Hermes and its own dependencies.
printf '/* empty: see build.sh */\n' > "$OUT/empty.c"
"${CXX%++}" --target="$ABI-linux-android24" -shared -o "$OUT/ours/libandroid.so" \
  -Wl,-soname,libandroid.so "$OUT/empty.c"
rm -f "$OUT/empty.c"
echo "built $OUT/eval_stress with $(basename "$NDK")"
node "$ROOT/plugins/patched-hermes/verify-hermes.js" describe "$OUT/ours" "$OUT/meta"
