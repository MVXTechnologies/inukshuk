#!/usr/bin/env bash
# Run the Convert reference suite through the app's own facade + PROJ on the
# build machine (no simulator). Builds PROJ for the host once.
#
#   modules/inukshuk-proj/tests/run-host.sh GRID_DIR
#
# GRID_DIR holds the PROJ-data grids the suite uses (fetch them with
# scripts/convert-native-suite.sh --fetch-grids DIR). Exit status = the
# Jest result of src/core/convert/nativeSuite.host.test.ts.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GRIDS="${1:?grid directory}"
[ -f "$HERE/prebuilt/host/lib/libproj.a" ] || "$HERE/scripts/build-proj.sh" host
OUT="$HERE/prebuilt/host/host_runner"
SDK=$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)
LIBS=("$HERE/prebuilt/host/lib/libproj.a" "$HERE/prebuilt/host/lib/libtiff.a" -lsqlite3 -lz)
c++ -std=c++17 -O2 ${SDK:+-isysroot "$SDK"} -I"$HERE/prebuilt/host/include" \
  "$HERE/tests/host_runner.cpp" "$HERE/cpp/proj_facade.cpp" "${LIBS[@]}" -o "$OUT"
cd "$ROOT"
INKPROJ_HOST_RUNNER="$OUT" INKPROJ_PROJ_DB="$HERE/prebuilt/host/share/proj/proj.db" \
  INKPROJ_GRIDS="$GRIDS" npx jest src/core/convert/nativeSuite.host.test.ts --verbose=false
