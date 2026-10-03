#!/bin/sh
# Build and run the C++ terrain engine tests on the host (macOS/Linux, clang++ or g++).
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT HUP INT TERM
"${CXX:-c++}" -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter \
  "$dir/terrain_tests.cpp" "$dir/../cpp/terrain_core.cpp" "$dir/../cpp/png_decode.cpp" \
  "$dir/../cpp/terrain_engine.cpp" -lz -o "$out/terrain_tests"
"$out/terrain_tests" "$dir/fixtures/parity.json"
