#!/bin/sh
set -eu

# react-native-static-server compiles Lighttpd during the iOS archive.
# EAS macOS workers do not all include CMake; Android uses its SDK toolchain.
if [ "${EAS_BUILD_PLATFORM:-}" != "ios" ]; then
  exit 0
fi

if ! command -v cmake >/dev/null 2>&1; then
  HOMEBREW_NO_AUTO_UPDATE=1 brew install cmake
fi

# Fail early if installation failed to make CMake available to Xcode's PATH.
cmake --version
