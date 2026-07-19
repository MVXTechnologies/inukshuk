#!/usr/bin/env bash
# Runs the Maestro flows, capturing full logcat on failure (uploaded as a CI
# artifact). The 2026-07-14 investigation was blind without device logs, and
# the 2026-07-16 vc44 crash-loop shipped because no flow ever tapped Record.
set -u
# Continuous GPS fixes so the recording flow exercises real location
# deliveries — including through the foreground service while backgrounded,
# the exact path that killed vc44 (missing RECEIVE_BOOT_COMPLETED).
(
  while true; do
    adb emu geo fix -71.2082 46.8139 >/dev/null 2>&1 || true
    sleep 2
    adb emu geo fix -71.2075 46.8145 >/dev/null 2>&1 || true
    sleep 2
  done
) &
GEO_PID=$!
trap 'kill $GEO_PID 2>/dev/null' EXIT

RC=0
# Order matters: category-record creates the saved (Run) trail that
# library-filter and trail-view depend on; record.yaml runs last because its
# save-vs-discard outcome is indeterminate. map-overlays needs no fixtures but
# runs after trail-view since both drive the shared terrain-overlay settings.
for flow in .maestro/smoke.yaml .maestro/waypoint.yaml .maestro/category-record.yaml \
  .maestro/library-filter.yaml .maestro/trail-view.yaml .maestro/map-overlays.yaml \
  .maestro/folders.yaml .maestro/settings.yaml .maestro/record.yaml; do
  adb logcat -c || true
  if maestro test "$flow"; then
    echo "=== $flow PASS ==="
  else
    RC=1
    echo "=== $flow FAIL ==="
    adb logcat -d > "logcat-failure-$(basename "$flow" .yaml).txt" || true
  fi
done
exit $RC
