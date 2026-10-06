#!/usr/bin/env bash
# Run one PDF bench plan on an iOS simulator with the bench .app.
# Reinstalls the app (fresh data), launches it, and hands it the plan link
# through <Documents>/qa/command.txt (simctl openurl prompts every time).
#
#   scripts/pdf-bench/run-ios.sh UDID APP PLAN.json CORPUS_DIR OUT_DIR
set -euo pipefail
UDID=$1 APP=$2 PLAN=$3 CORPUS=$4 OUT=$5
PORT=${PORT:-8765}  # the plan's "host" must use the same port
HERE=$(cd "$(dirname "$0")" && pwd)
BUNDLE=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Info.plist")
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl privacy "$UDID" grant location-always "$BUNDLE" 2>/dev/null || true
python3 "$HERE/host.py" --corpus "$CORPUS" --out "$OUT" --plan "$PLAN" --ios "$UDID" --port "$PORT" --exit-on-done &
HOST=$!
trap 'kill $HOST 2>/dev/null || true' EXIT
xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null
sleep 12
DATA=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
mkdir -p "$DATA/Documents/qa"
printf 'inukshuk://?pbench=http%%3A%%2F%%2F127.0.0.1%%3A%s%%2Fplan.json&n=%s' "$PORT" "$RANDOM" > "$DATA/Documents/qa/command.txt"
wait $HOST
