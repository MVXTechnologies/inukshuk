#!/usr/bin/env bash
# Make the Convert module's native inputs present before a native build:
# PROJ static libs + proj.db (built from pinned sources by build-proj.sh when
# missing) and the two bundled grids (pinned by sha256).
#
#   modules/inukshuk-proj/scripts/prepare.sh [ios|android|all]
#
# Runs from `npm run proj:prepare`, the `eas-build-post-install` hook and CI.
# Idempotent: does nothing when everything is already there and verified.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WHAT=${1:-all}
GRIDS="$HERE/assets/inukshukproj/grids"
mkdir -p "$GRIDS"

# name sha256 — the bundled grids (CONVERT §3): EGM96 and the NRCan v7 velocity grid.
while read -r name sha; do
  f="$GRIDS/$name"
  if [ ! -f "$f" ] || [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" != "$sha" ]; then
    curl -fsSL "https://cdn.proj.org/$name" -o "$f.part"
    got=$(shasum -a 256 "$f.part" | cut -d' ' -f1)
    if [ "$got" != "$sha" ]; then
      echo "sha256 mismatch for $name: $got" >&2
      rm -f "$f.part"
      exit 1
    fi
    mv "$f.part" "$f"
  fi
done <<'EOF'
us_nga_egm96_15.tif db493027562c9b004d7220fa881f5603adada4e1c5029b933fa7de4547b0e78d
ca_nrc_NAD83v70VG.tif bfa4f958bd8ff287736fd2595bb524d874de88e6fa0670846abdb8394ab7587b
EOF

need_ios=0
need_android=0
[ -f "$HERE/prebuilt/ios/Proj.xcframework/Info.plist" ] || need_ios=1
for abi in ${ANDROID_ABIS:-arm64-v8a armeabi-v7a x86_64 x86}; do
  [ -f "$HERE/prebuilt/android/$abi/lib/libproj.a" ] || need_android=1
done
[ -f "$HERE/assets/inukshukproj/proj.db" ] || { need_ios=1; need_android=1; }
if [ "$WHAT" != android ] && [ $need_ios = 1 ] && [ "$(uname)" = Darwin ]; then
  "$HERE/scripts/build-proj.sh" ios
fi
if [ "$WHAT" != ios ] && [ $need_android = 1 ]; then
  "$HERE/scripts/build-proj.sh" android
fi
echo "inukshuk-proj ready"
