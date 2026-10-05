#!/usr/bin/env bash
# Cold-launch "open the map" timing: the bench APK must already have SLUG in
# its library (the last map of a previous run-android.sh plan stays there).
# Puts the device at LON,LAT (the map starts at z14 on the user's position),
# force-stops the app and starts it with the bench link, REPS times.
#
#   scripts/pdf-bench/open-android.sh SERIAL PLAN.json CORPUS OUT SLUG LON LAT REPS
set -euo pipefail
SERIAL=$1 PLAN=$2 CORPUS=$3 OUT=$4 SLUG=$5 LON=$6 LAT=$7 REPS=${8:-5}
HERE=$(cd "$(dirname "$0")" && pwd)
adb -s "$SERIAL" reverse tcp:8765 tcp:8765 >/dev/null
adb -s "$SERIAL" emu geo fix "$LON" "$LAT" >/dev/null
for i in $(seq 1 "$REPS"); do
  python3 "$HERE/host.py" --corpus "$CORPUS" --out "$OUT" --plan "$PLAN" --android "$SERIAL" --exit-on-done &
  HOST=$!
  sleep 1
  adb -s "$SERIAL" shell am force-stop com.inukshuk.app
  sleep 2
  NOW=$(adb -s "$SERIAL" shell date +%s%N | tr -d '\r')
  T0=$((NOW / 1000000))
  adb -s "$SERIAL" shell am start -a android.intent.action.VIEW \
    -d "'inukshuk://?pbench=http%3A%2F%2F127.0.0.1%3A8765%2Fplan.json&open=$SLUG&t0=$T0'" \
    -n com.inukshuk.app/.MainActivity >/dev/null
  wait $HOST || true
done
