#!/usr/bin/env bash
# Overlap chooser (#745) on an Android device or emulator, for screenshots:
#   1. push the two crossing GPX (.maestro/fixtures/overlap/) into the app's
#      own external files folder (readable without a storage permission),
#   2. open each with an "Open with" VIEW intent — the same import path a
#      file manager uses (app/+native-intent.tsx),
#   3. run .maestro/overlap-chooser.yaml (draws an area round the crossing,
#      taps it, screenshots the chooser, a picked trail and the area card).
#
# Usage:
#   scripts/e2e/overlap-chooser.sh [--device <serial>] [--seed-only] [--shots <dir>]
# Run it once per theme (switch the device to dark mode between runs, with
# --shots pointing at another folder): the flow deletes the area it drew at
# the end, and a re-import of the same GPX is caught as a duplicate.
# Needs: adb and maestro on PATH, the app installed on the device.
set -u
REPO=$(cd -- "$(dirname -- "$0")/../.." && pwd)
DEVICE=""
SEED_ONLY=0
SHOTS="$REPO"
while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --seed-only) SEED_ONLY=1; shift ;;
    --shots) SHOTS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
ADB=(adb)
[ -n "$DEVICE" ] && ADB=(adb -s "$DEVICE")
APP=com.inukshuk.app
DIR="/sdcard/Android/data/$APP/files/e2e-overlap"

echo "== import the crossing trails"
"${ADB[@]}" shell mkdir -p "$DIR" || exit 1
for gpx in "$REPO"/.maestro/fixtures/overlap/*.gpx; do
  name=$(basename "$gpx")
  "${ADB[@]}" push "$gpx" "$DIR/$name" >/dev/null || exit 1
  "${ADB[@]}" shell am start -W -a android.intent.action.VIEW \
    -d "file://$DIR/$name" -t application/gpx+xml "$APP" >/dev/null || exit 1
  # Let the import land (and its snackbar clear) before the next intent.
  sleep 4
done
[ "$SEED_ONLY" = 1 ] && exit 0

echo "== flow"
mkdir -p "$SHOTS"
cd "$SHOTS" || exit 1
DEV_ARGS=()
[ -n "$DEVICE" ] && DEV_ARGS=(--device "$DEVICE")
maestro "${DEV_ARGS[@]}" test "$REPO/.maestro/overlap-chooser.yaml"
