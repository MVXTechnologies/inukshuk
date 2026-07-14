#!/usr/bin/env bash
# Diagnostic: run the Maestro smoke flow N times against a fresh app state,
# capturing full logcat for every failing attempt (uploaded as artifacts).
set -u
RC=0
for i in 1 2 3; do
  adb shell pm clear com.inukshuk.app || true
  adb logcat -c || true
  if maestro test .maestro/smoke.yaml; then
    echo "=== attempt $i PASS ==="
  else
    RC=1
    echo "=== attempt $i FAIL ==="
    adb logcat -d > "logcat-attempt-$i.txt" || true
  fi
done
exit $RC
