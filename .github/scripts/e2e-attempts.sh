#!/usr/bin/env bash
# Runs the Maestro smoke flow, capturing full logcat on failure (uploaded as a
# CI artifact). The 2026-07-14 investigation was blind without device logs:
# the app rendered fine and the JS thread was alive, so only logcat showed the
# invisible Portal overlay eating every touch.
set -u
adb logcat -c || true
if maestro test .maestro/smoke.yaml; then
  exit 0
fi
adb logcat -d > logcat-failure.txt || true
exit 1
