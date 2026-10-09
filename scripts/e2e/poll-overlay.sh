#!/usr/bin/env bash
# Poll the pdf-overlays pixel check until the overlay is on the map, or a
# hard deadline passes. Run right after pdf-overlays.yaml, while the app still
# shows the map (not a flow retry: nothing is relaunched or re-tapped), with
# the device held at the flow's location (the caller re-applies it with
# flow-location.sh: Maestro's own mock locations end with the flow).
#
#   poll-overlay.sh <first-screenshot.png|-> [deadline-seconds] [interval-seconds]
#
# Attempt 1 checks the flow's own screenshot (`-`: none, capture one); later
# attempts capture the screen again. The threshold is check-overlay-
# screenshot.mjs's own, unchanged. Every attempt's verdict (sample count) is
# printed; the last line says on which attempt and after how long it passed.
#
# On a busy emulator the raster can land seconds after the flow's screenshot
# (CI 2026-10-08, run 37835288907: frames of 0.5-2.7 s, 7/576 samples at the
# flow's single shot, no error logged), and MapLibre reports no event that a
# flow could wait on (#652): the pixels are the only truth, so poll them.
#
# Overridable for tests: CAPTURE (writes a PNG to "$1"), CHECK (exit 0 = pass).
set -u
FIRST=${1:?usage: poll-overlay.sh <first-screenshot.png|-> [deadline-seconds] [interval-seconds]}
DEADLINE=${2:-60}
INTERVAL=${3:-3}
CAPTURE=${CAPTURE:-'adb exec-out screencap -p > "$1"'}
CHECK=${CHECK:-'node scripts/e2e/check-overlay-screenshot.mjs "$1"'}
SHOTS=$(mktemp -d)

started=$SECONDS
attempt=0
while :; do
  attempt=$((attempt + 1))
  if [ "$attempt" = 1 ] && [ "$FIRST" != - ]; then
    shot=$FIRST
  else
    shot="$SHOTS/attempt-$attempt.png"
    if ! bash -c "$CAPTURE" _ "$shot" || [ ! -s "$shot" ]; then
      echo "attempt $attempt at $((SECONDS - started)) s: screen capture failed"
      shot=""
    fi
  fi
  if [ -n "$shot" ]; then
    verdict=$(bash -c "$CHECK" _ "$shot" 2>&1)
    ok=$?
    echo "attempt $attempt at $((SECONDS - started)) s: $verdict"
    if [ "$ok" = 0 ]; then
      echo "pdf-overlays pixels passed on attempt $attempt at $((SECONDS - started)) s"
      [ "$attempt" -gt 1 ] && cp "$shot" pdf-overlays-map-passed.png 2>/dev/null
      rm -rf "$SHOTS"
      exit 0
    fi
  fi
  if [ $((SECONDS - started + INTERVAL)) -gt "$DEADLINE" ]; then
    echo "pdf-overlays pixels FAILED: $attempt attempt(s) in $((SECONDS - started)) s (deadline $DEADLINE s)"
    [ -n "$shot" ] && cp "$shot" pdf-overlays-map-last.png 2>/dev/null
    rm -rf "$SHOTS"
    exit 1
  fi
  sleep "$INTERVAL"
done
