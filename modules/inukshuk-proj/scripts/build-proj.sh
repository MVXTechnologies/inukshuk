#!/usr/bin/env bash
# Build PROJ 9.8.1 + libtiff (deflate only) (+ the SQLite amalgamation on
# Android) as static libraries for the Convert tool's native module.
#
#   modules/inukshuk-proj/scripts/build-proj.sh [ios|android|all]
#   WORK=/some/dir … (scratch; default $TMPDIR/inukshuk-proj-build)
#   ANDROID_ABIS="arm64-v8a" … (subset)
#
# Output (gitignored, read by InukshukProj.podspec and android/CMakeLists.txt):
#   prebuilt/ios/Proj.xcframework, Tiff.xcframework  (ios-arm64 + ios-arm64_x86_64-simulator)
#   prebuilt/ios/include/                            proj.h …
#   prebuilt/android/<abi>/lib/lib{proj,tiff,sqlite3}.a, prebuilt/android/include/
#   assets/inukshukproj/proj.db                      EPSG database built by this PROJ
#   prebuilt/BUILD-INFO.txt                          versions + sha256 of every output
#
# No curl (PROJ never fetches grids by itself), no apps, no tests. iOS links
# the system libsqlite3 and libz; Android links the NDK's libz. Every source
# is pinned by sha256 (PROJ's also matches the md5 osgeo publishes).
set -euo pipefail

PROJ_VERSION=9.8.1
PROJ_SHA256=af5b731c145c1d13c4e3b4eeb7d167e94e845e440f71e3496b4ed8dae0291960
TIFF_VERSION=4.7.1
TIFF_SHA256=f698d94f3103da8ca7438d84e0344e453fe0ba3b7486e04c5bf7a9a3fabe9b69
SQLITE_NAME=sqlite-amalgamation-3500400
SQLITE_SHA256=1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032
IOS_MIN=16.4
ANDROID_API=26
# React Native's default reactNativeArchitectures: all four.
read -r -a ABIS <<< "${ANDROID_ABIS:-arm64-v8a armeabi-v7a x86_64 x86}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WHAT=${1:-all}
WORK="${WORK:-${TMPDIR:-/tmp}/inukshuk-proj-build}"
JOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc)
OUT="$HERE/prebuilt"
mkdir -p "$WORK/src" "$OUT" "$HERE/assets/inukshukproj"
export PATH="/opt/homebrew/bin:$PATH"
# A Linux EAS worker may have no system CMake: use the Android SDK's.
if ! command -v cmake >/dev/null 2>&1 && [ -n "${ANDROID_HOME:-}" ]; then
  for c in "$ANDROID_HOME"/cmake/*/bin; do [ -x "$c/cmake" ] && export PATH="$c:$PATH"; done
fi

fetch() { # url sha256 dest
  if [ ! -f "$3" ]; then curl -fsSL "$1" -o "$3.part" && mv "$3.part" "$3"; fi
  local got
  got=$(shasum -a 256 "$3" | cut -d' ' -f1)
  if [ "$got" != "$2" ]; then
    echo "sha256 mismatch for $3: $got (expected $2)" >&2
    exit 1
  fi
}

cd "$WORK/src"
fetch "https://download.osgeo.org/proj/proj-$PROJ_VERSION.tar.gz" "$PROJ_SHA256" proj.tgz
fetch "https://download.osgeo.org/libtiff/tiff-$TIFF_VERSION.tar.gz" "$TIFF_SHA256" tiff.tgz
fetch "https://www.sqlite.org/2025/$SQLITE_NAME.zip" "$SQLITE_SHA256" sqlite.zip
[ -d "proj-$PROJ_VERSION" ] || tar xzf proj.tgz
[ -d "tiff-$TIFF_VERSION" ] || tar xzf tiff.tgz
[ -d "$SQLITE_NAME" ] || unzip -q sqlite.zip
# PROJ builds proj.db with the sqlite3 shell; compile one from the pinned
# amalgamation when the machine has none (some Linux build images).
SQLITE3_EXE=$(command -v sqlite3 || true)
if [ -z "$SQLITE3_EXE" ]; then
  mkdir -p "$WORK/hostbin"
  cc -O2 -DSQLITE_THREADSAFE=0 "$WORK/src/$SQLITE_NAME/shell.c" "$WORK/src/$SQLITE_NAME/sqlite3.c" \
    -o "$WORK/hostbin/sqlite3" -lm -ldl
  SQLITE3_EXE="$WORK/hostbin/sqlite3"
fi

# libtiff: only what PROJ's GeoTIFF grids use (deflate + predictors).
TIFF_OPTS=(-DBUILD_SHARED_LIBS=OFF -Dtiff-tools=OFF -Dtiff-tests=OFF -Dtiff-contrib=OFF
  -Dtiff-docs=OFF -Dcxx=OFF -Djpeg=OFF -Dold-jpeg=OFF -Djbig=OFF -Dlzma=OFF -Dzstd=OFF
  -Dwebp=OFF -Dlerc=OFF -Dlibdeflate=OFF -Dpixarlog=OFF -Dzlib=ON
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_BUILD_TYPE=Release)
PROJ_OPTS=(-DBUILD_SHARED_LIBS=OFF -DENABLE_CURL=OFF -DENABLE_TIFF=ON -DBUILD_APPS=OFF
  -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF -DEMBED_RESOURCE_FILES=OFF
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_BUILD_TYPE=Release
  "-DEXE_SQLITE3=$SQLITE3_EXE")

# build_one NAME PREFIX [cmake cross-compile args...]
build_one() {
  local name=$1 prefix=$2
  shift 2
  local b="$WORK/build/$name"
  rm -rf "$b" "$prefix"
  mkdir -p "$b/tiff" "$b/proj" "$prefix"
  local sqlite_args=()
  if [ -n "${SQLITE_LIB:-}" ]; then
    sqlite_args=("-DSQLite3_INCLUDE_DIR=$SQLITE_INC" "-DSQLite3_LIBRARY=$SQLITE_LIB")
  fi
  cmake -S "$WORK/src/tiff-$TIFF_VERSION" -B "$b/tiff" "${TIFF_OPTS[@]}" "$@" \
    "-DCMAKE_INSTALL_PREFIX=$prefix" > "$b/tiff.log"
  cmake --build "$b/tiff" -j "$JOBS" >> "$b/tiff.log"
  cmake --install "$b/tiff" >> "$b/tiff.log"
  # PROJ gets libtiff from TIFF_INCLUDE_DIR/TIFF_LIBRARY; libtiff's own CMake
  # package would drag in a ZLIB::ZLIB target the host build doesn't define.
  rm -rf "$prefix/lib/cmake/tiff" "$prefix/lib/libtiffxx.a"
  cmake -S "$WORK/src/proj-$PROJ_VERSION" -B "$b/proj" "${PROJ_OPTS[@]}" "$@" \
    "-DCMAKE_INSTALL_PREFIX=$prefix" "-DCMAKE_PREFIX_PATH=$prefix" \
    "-DTIFF_INCLUDE_DIR=$prefix/include" "-DTIFF_LIBRARY=$prefix/lib/libtiff.a" \
    ${sqlite_args[@]+"${sqlite_args[@]}"} > "$b/proj.log"
  cmake --build "$b/proj" -j "$JOBS" >> "$b/proj.log"
  cmake --install "$b/proj" >> "$b/proj.log"
  echo "built $name"
}

if [ "$WHAT" = ios ] || [ "$WHAT" = all ]; then
  for sdk in iphoneos iphonesimulator; do
    SDKP=$(xcrun --sdk "$sdk" --show-sdk-path)
    # The simulator slice is fat: a generic-simulator Release build links x86_64 too.
    archs=arm64
    [ "$sdk" = iphonesimulator ] && archs="arm64;x86_64"
    SQLITE_INC="$SDKP/usr/include" SQLITE_LIB="$SDKP/usr/lib/libsqlite3.tbd" \
      build_one "ios-$sdk" "$WORK/install/ios-$sdk" \
      -DCMAKE_SYSTEM_NAME=iOS "-DCMAKE_OSX_SYSROOT=$sdk" "-DCMAKE_OSX_ARCHITECTURES=$archs" \
      "-DCMAKE_OSX_DEPLOYMENT_TARGET=$IOS_MIN" \
      "-DZLIB_INCLUDE_DIR=$SDKP/usr/include" "-DZLIB_LIBRARY=$SDKP/usr/lib/libz.tbd"
  done
  rm -rf "$OUT/ios"
  mkdir -p "$OUT/ios"
  for lib in proj tiff; do
    fw=$(echo "${lib:0:1}" | tr '[:lower:]' '[:upper:]')${lib:1}
    xcodebuild -create-xcframework \
      -library "$WORK/install/ios-iphoneos/lib/lib$lib.a" \
      -library "$WORK/install/ios-iphonesimulator/lib/lib$lib.a" \
      -output "$OUT/ios/$fw.xcframework" > /dev/null
  done
  cp -R "$WORK/install/ios-iphoneos/include" "$OUT/ios/include"
  cp "$WORK/install/ios-iphoneos/share/proj/proj.db" "$HERE/assets/inukshukproj/proj.db"
fi

if [ "$WHAT" = host ]; then
  # The host build (macOS or Linux) for tests/run-host.sh: the same facade and
  # PROJ, run on the reference suite without a simulator. Not shipped.
  MACSDK=$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)
  if [ -n "$MACSDK" ]; then
    build_one host "$OUT/host" "-DZLIB_INCLUDE_DIR=$MACSDK/usr/include" "-DZLIB_LIBRARY=$MACSDK/usr/lib/libz.tbd"
  else
    build_one host "$OUT/host"
  fi
  exit 0
fi

if [ "$WHAT" = android ] || [ "$WHAT" = all ]; then
  ANDROID_HOME=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
  # React Native's own NDK (node_modules/react-native/gradle/libs.versions.toml).
  NDK_VERSION=27.1.12297006
  NDK=${ANDROID_NDK:-$ANDROID_HOME/ndk/$NDK_VERSION}
  TC="$NDK/build/cmake/android.toolchain.cmake"
  if [ ! -f "$TC" ]; then
    # CI / EAS images may not have it yet (Gradle would fetch it later): install it now.
    SDKM=$(command -v sdkmanager || ls "$ANDROID_HOME"/cmdline-tools/*/bin/sdkmanager 2>/dev/null | head -1 || true)
    [ -n "$SDKM" ] || { echo "no NDK at $NDK and no sdkmanager to install it" >&2; exit 1; }
    (yes | "$SDKM" --install "ndk;$NDK_VERSION" > /dev/null) || true # `yes` dies of SIGPIPE
    [ -f "$TC" ] || { echo "NDK $NDK_VERSION install failed" >&2; exit 1; }
  fi
  for abi in "${ABIS[@]}"; do
    pre="$WORK/install/android-$abi"
    rm -rf "$WORK/build/sqlite-$abi"
    mkdir -p "$WORK/build/sqlite-$abi" "$pre/lib" "$pre/include"
    # The SQLite amalgamation, compiled with the NDK clang for this ABI.
    case $abi in
      arm64-v8a) triple=aarch64-linux-android ;;
      armeabi-v7a) triple=armv7a-linux-androideabi ;;
      x86_64) triple=x86_64-linux-android ;;
      x86) triple=i686-linux-android ;;
      *) echo "unknown abi $abi" >&2; exit 1 ;;
    esac
    tcbin="$NDK/toolchains/llvm/prebuilt/$(uname | tr "[:upper:]" "[:lower:]")-x86_64/bin"
    "$tcbin/clang" --target="$triple$ANDROID_API" -O2 -fPIC -DSQLITE_THREADSAFE=1 \
      -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_DEFAULT_MEMSTATUS=0 \
      -c "$WORK/src/$SQLITE_NAME/sqlite3.c" -o "$WORK/build/sqlite-$abi/sqlite3.o"
    "$tcbin/llvm-ar" rcs "$pre/lib/libsqlite3.a" "$WORK/build/sqlite-$abi/sqlite3.o"
    cp "$WORK/src/$SQLITE_NAME/sqlite3.h" "$pre/include/"
    SQLITE_INC="$pre/include" SQLITE_LIB="$pre/lib/libsqlite3.a" \
      build_one "android-$abi-libs" "$WORK/install/android-$abi-libs" \
      "-DCMAKE_TOOLCHAIN_FILE=$TC" "-DANDROID_ABI=$abi" "-DANDROID_PLATFORM=android-$ANDROID_API" \
      -DANDROID_STL=c++_shared
    mkdir -p "$OUT/android/$abi/lib"
    cp "$WORK/install/android-$abi-libs/lib/libproj.a" "$WORK/install/android-$abi-libs/lib/libtiff.a" \
      "$pre/lib/libsqlite3.a" "$OUT/android/$abi/lib/"
    # The NDK toolchain always adds -g; Gradle strips the final .so anyway,
    # so drop the debug sections here (≈ 97 → 12 MB per ABI on disk).
    for a in "$OUT/android/$abi/lib/"*.a; do "$tcbin/llvm-strip" --strip-debug "$a"; done
    rm -rf "$OUT/android/include"
    cp -R "$WORK/install/android-$abi-libs/include" "$OUT/android/include"
    cp "$WORK/install/android-$abi-libs/share/proj/proj.db" "$HERE/assets/inukshukproj/proj.db"
  done
fi

{
  echo "PROJ $PROJ_VERSION ($PROJ_SHA256)"
  echo "libtiff $TIFF_VERSION ($TIFF_SHA256)"
  echo "SQLite $SQLITE_NAME ($SQLITE_SHA256), Android only; iOS uses the system libsqlite3"
  echo "built $(date -u +%Y-%m-%dT%H:%MZ) on $(uname -sm), $(cmake --version | head -1)"
  (cd "$HERE" && find prebuilt assets -type f \( -name '*.a' -o -name proj.db \) -print0 |
    sort -z | xargs -0 shasum -a 256)
} > "$OUT/BUILD-INFO.txt"
echo "done → $OUT"
