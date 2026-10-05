#!/usr/bin/env bash
# The Convert regression gate ON A DEVICE (CONVERT §5.5 step 3): the official-
# tool reference suite through the app's real PROJ module.
#
#   scripts/convert-native-suite.sh --fetch-grids DIR             # PROJ-data grids the suite uses (~260 MB)
#   scripts/convert-native-suite.sh ios UDID GRID_DIR [OUT_DIR]   # booted simulator, app installed
#   scripts/convert-native-suite.sh android SERIAL GRID_DIR [OUT_DIR]   # emulator (rootable image), app installed
#
# It copies src/core/convert/fixtures/reference.json and the grids into the
# app's Documents/convert-selftest/, opens inukshuk://convert-selftest (the
# inert-without-data ConvertSelfTestScreen), waits for result.txt, copies it
# and result.json to OUT_DIR, and exits 0 only on "RESULT: PASS".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP=com.inukshuk.app
REF="$ROOT/src/core/convert/fixtures/reference.json"

if [ "${1:-}" = "--fetch-grids" ]; then
  DIR=${2:?dir}
  mkdir -p "$DIR"
  python3 - "$REF" > "$DIR/names.txt" <<'EOF'
import json, re, sys
s = set()
for p in json.load(open(sys.argv[1]))['pairs']:
    s |= set(re.findall(r'grids=([^ ]+)', p['pipeline'] or ''))
print('\n'.join(sorted(s)))
EOF
  while read -r g; do
    [ -f "$DIR/$g" ] || curl -fsSL "https://cdn.proj.org/$g" -o "$DIR/$g"
  done < "$DIR/names.txt"
  rm -f "$DIR/names.txt"
  echo "grids in $DIR"
  exit 0
fi

PLATFORM=${1:?ios|android}
DEVICE=${2:?device id}
GRIDS=${3:?grid dir}
OUT=${4:-$ROOT/convert-suite-results}
mkdir -p "$OUT"

wait_for() { # file-test-command timeout-seconds
  local i=0
  until eval "$1"; do
    i=$((i + 2))
    [ $i -gt "$2" ] && return 1
    sleep 2
  done
}

if [ "$PLATFORM" = ios ]; then
  DATA=$(xcrun simctl get_app_container "$DEVICE" "$APP" data)
  D="$DATA/Documents/convert-selftest"
  rm -rf "$D"
  mkdir -p "$D/grids"
  cp "$REF" "$D/reference.json"
  cp "$GRIDS"/*.tif "$D/grids/"
  xcrun simctl terminate "$DEVICE" "$APP" 2>/dev/null || true
  xcrun simctl launch "$DEVICE" "$APP" >/dev/null
  sleep 6
  # simctl openurl triggers iOS's "Open in Inukshuk?" prompt: Maestro opens and accepts it.
  JH=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
  JAVA_HOME=$JH PATH="$JH/bin:$PATH" maestro --device "$DEVICE" test \
    "$ROOT/scripts/convert-selftest-open.yaml" >"$OUT/maestro.log" 2>&1 || true
  wait_for "[ -f '$D/result.txt' ]" 600 || { echo "no result after 10 min" >&2; exit 2; }
  cp "$D/result.txt" "$D/result.json" "$OUT/"
elif [ "$PLATFORM" = android ]; then
  ADB="adb -s $DEVICE"
  $ADB root >/dev/null 2>&1 || true
  sleep 2
  D=/data/data/$APP/files/convert-selftest
  $ADB shell "rm -rf $D && mkdir -p $D/grids"
  $ADB push "$REF" "$D/reference.json" >/dev/null
  for g in "$GRIDS"/*.tif; do $ADB push "$g" "$D/grids/" >/dev/null; done
  OWNER=$($ADB shell "stat -c %U /data/data/$APP" | tr -d '\r')
  $ADB shell "chown -R $OWNER:$OWNER $D"
  $ADB shell am force-stop "$APP"
  $ADB shell am start -W -n "$APP/.MainActivity" >/dev/null
  sleep 8
  $ADB shell am start -W -a android.intent.action.VIEW -d "inukshuk://convert-selftest" "$APP" >/dev/null
  wait_for "$ADB shell '[ -f $D/result.txt ] && echo y' | grep -q y" 900 || { echo "no result after 15 min" >&2; exit 2; }
  $ADB pull "$D/result.txt" "$OUT/" >/dev/null
  $ADB pull "$D/result.json" "$OUT/" >/dev/null
else
  echo "platform must be ios or android" >&2
  exit 2
fi

head -6 "$OUT/result.txt"
grep -q "RESULT: PASS" "$OUT/result.txt"
