#!/usr/bin/env bash
# Run one PDF bench plan on an Android device/emulator with the bench APK
# installed. Clears app data first (also drops any downloaded OTA), cold-starts
# the app, sends the plan deep link and waits for the run's /done.
#
#   scripts/pdf-bench/run-android.sh SERIAL PLAN.json CORPUS_DIR OUT_DIR
set -euo pipefail
SERIAL=$1 PLAN=$2 CORPUS=$3 OUT=$4
HERE=$(cd "$(dirname "$0")" && pwd)
RUN_ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runId"])' "$PLAN")
adb -s "$SERIAL" reverse tcp:8765 tcp:8765 >/dev/null
adb -s "$SERIAL" shell am force-stop com.inukshuk.app
adb -s "$SERIAL" shell pm clear com.inukshuk.app >/dev/null
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION POST_NOTIFICATIONS; do
  adb -s "$SERIAL" shell pm grant com.inukshuk.app android.permission.$p || true
done
python3 "$HERE/host.py" --corpus "$CORPUS" --out "$OUT" --plan "$PLAN" --android "$SERIAL" --exit-on-done &
HOST=$!
trap 'kill $HOST 2>/dev/null || true' EXIT
sleep 1
adb -s "$SERIAL" shell am start -W -n com.inukshuk.app/.MainActivity >/dev/null
sleep 10
adb -s "$SERIAL" shell am start -a android.intent.action.VIEW \
  -d "inukshuk://?pbench=http%3A%2F%2F127.0.0.1%3A8765%2Fplan.json" com.inukshuk.app >/dev/null
wait $HOST
echo "run $RUN_ID done: $OUT/$RUN_ID/results.jsonl"
