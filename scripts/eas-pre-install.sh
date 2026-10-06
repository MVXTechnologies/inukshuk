#!/bin/sh
set -eu

# react-native-static-server compiles Lighttpd during the iOS archive, and
# PROJ (below) builds with CMake. EAS macOS workers do not all include CMake;
# Android uses its SDK toolchain (build-proj.sh finds the SDK's CMake).
if [ "${EAS_BUILD_PLATFORM:-}" = "ios" ]; then
  if ! command -v cmake >/dev/null 2>&1; then
    HOMEBREW_NO_AUTO_UPDATE=1 brew install cmake
  fi
  # Fail early if installation failed to make CMake available to Xcode's PATH.
  cmake --version
fi

# Convert's PROJ static libs, proj.db and bundled grids (modules/inukshuk-proj).
# This MUST run before `pod install`: CocoaPods resolves the podspec's
# vendored xcframeworks when it installs, and EAS's post-install hook runs
# after it — in 2.3.0 (build 8766525f) the xcframeworks did not exist yet at
# pod install, so libproj was never linked ("Undefined symbols … _proj_*").
bash modules/inukshuk-proj/scripts/prepare.sh "${EAS_BUILD_PLATFORM:-all}"
