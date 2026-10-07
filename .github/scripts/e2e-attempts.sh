#!/usr/bin/env bash
# Runs ONE shard of the Maestro flows (.maestro/shards.json) on the connected
# device, capturing full logcat on failure (uploaded as a CI artifact). The
# 2026-07-14 investigation was blind without device logs, and the 2026-07-16
# vc44 crash-loop shipped because no flow ever tapped Record.
#
#   .github/scripts/e2e-attempts.sh <shard>
#
# Each CI shard runs on its own fresh emulator (.github/workflows/e2e.yml), so
# a flow may only depend on flows listed before it in the SAME shard.
set -u
SHARD=${1:?usage: e2e-attempts.sh <shard> (shards: $(node scripts/ci/e2e-shards.mjs names))}
if ! PLAN=$(node scripts/ci/e2e-shards.mjs flows "$SHARD"); then
  exit 2
fi
# Read the plan up front: maestro must not inherit (and drain) a loop's stdin.
mapfile -t FLOWS <<< "$PLAN"

# Continuous GPS fixes so the recording flows exercise real location
# deliveries — including through the foreground service while backgrounded,
# the exact path that killed vc44 (missing RECEIVE_BOOT_COMPLETED).
#
# Paused (GEO_PAUSE exists) while a flow tagged `own-location` runs: those
# flows set the location themselves and then tap by position on a camera that
# follows the user, and this loop alternates the user between two points
# ~86 m apart every 2 s — it dragged heatmap.yaml's camera off its tap target.
GEO_PAUSE=$(mktemp -u)
(
  while true; do
    [ -e "$GEO_PAUSE" ] || adb emu geo fix -71.2082 46.8139 >/dev/null 2>&1 || true
    sleep 2
    [ -e "$GEO_PAUSE" ] || adb emu geo fix -71.2075 46.8145 >/dev/null 2>&1 || true
    sleep 2
  done
) &
GEO_PID=$!

# Map-store fixture catalog (store.yaml, pdf-overlays.yaml): serve
# .maestro/fixtures/catalog on the host and map the device's loopback :8787
# onto it. The e2e APK is built with
# CATALOG_MANIFEST_URL=http://127.0.0.1:8787/index.json (e2e.yml), so the
# Search tab reads this fixture and CI never touches NRCan. The large
# single-JPEG GeoPDF (pdf-overlays.yaml, #331) is generated, not checked in:
# build the fixture set before serving it.
npx tsx scripts/catalog/make-fixture.ts || echo "fixture generation failed" >&2
python3 -m http.server 8787 --bind 127.0.0.1 --directory .maestro/fixtures/catalog \
  >/dev/null 2>&1 &
CATALOG_PID=$!
adb reverse tcp:8787 tcp:8787 || true

trap 'kill $GEO_PID $CATALOG_PID 2>/dev/null; rm -f "$GEO_PAUSE"' EXIT

# Trail photos (#587): the system photo picker shows what MediaStore indexed.
# Put the fixture JPEGs (camera EXIF + GPS next to the fixed location above,
# no capture time) in the device's Pictures and index them now, so
# photos-add.yaml can pick them like a user would.
adb shell mkdir -p /sdcard/Pictures/InukshukE2E || true
for photo in .maestro/fixtures/photos/*.jpg; do
  adb push "$photo" /sdcard/Pictures/InukshukE2E/ >/dev/null || true
done
adb shell content call --uri content://media --method scan_volume --arg external_primary \
  >/dev/null 2>&1 || true

RC=0
SUMMARY="| Flow | Result | Time |"$'\n'"| --- | --- | --- |"
# Screenshots taken from here on are this run's; anything older is stale.
SHOT_MARK=$(mktemp)
RAN_PDF_OVERLAYS=0
for entry in "${FLOWS[@]}"; do
  flow=${entry% *}
  own_location=${entry##* }
  name=$(basename "$flow" .yaml)
  [ "$name" = pdf-overlays ] && RAN_PDF_OVERLAYS=1
  if [ "$own_location" = 1 ]; then touch "$GEO_PAUSE"; else rm -f "$GEO_PAUSE"; fi
  started=$SECONDS
  adb logcat -c || true
  if maestro test "$flow"; then
    result=PASS
  else
    # One retry: launch races (map-init timing, post-boot churn) pass on a
    # clean second run. Keep the FIRST failure's logcat either way, so a
    # retried-but-green flow still leaves evidence it flaked — and say so in
    # an annotation, so a flake is visible on a green run too.
    adb logcat -d > "logcat-failure-$name.txt" || true
    adb logcat -c || true
    if maestro test "$flow"; then
      result="PASS (on retry)"
      echo "::warning title=E2E flake ($SHARD)::$flow failed once and passed on retry; see logcat-failure-$name.txt in the shard's artifact"
    else
      result=FAIL
      RC=1
      adb logcat -d > "logcat-failure-$name-retry.txt" || true
    fi
  fi
  took=$((SECONDS - started))
  echo "=== $flow $result ($((took / 60))m$((took % 60))s) ==="
  SUMMARY+=$'\n'"| $name | $result | $((took / 60))m$((took % 60))s |"
done
rm -f "$GEO_PAUSE"

# pdf-overlays.yaml proves the overlay drew through its map screenshot (#331);
# the flow passing without the pixels is not a pass. Where Maestro writes it
# depends on the CLI version (current ones: the flow's artifact bundle under
# ~/.maestro/tests, not the cwd) — find-screenshot.sh looks everywhere.
if [ "$RAN_PDF_OVERLAYS" = 1 ]; then
  if SHOT=$(bash scripts/e2e/find-screenshot.sh pdf-overlays-map.png .maestro "$SHOT_MARK"); then
    echo "=== pdf-overlays screenshot: $SHOT ==="
    if node scripts/e2e/check-overlay-screenshot.mjs "$SHOT"; then
      SUMMARY+=$'\n'"| pdf-overlays pixels | PASS | |"
    else
      SUMMARY+=$'\n'"| pdf-overlays pixels | FAIL | |"
      RC=1
    fi
  else
    echo "=== pdf-overlays screenshot missing ==="
    SUMMARY+=$'\n'"| pdf-overlays pixels | FAIL (no screenshot) | |"
    RC=1
  fi
fi
rm -f "$SHOT_MARK"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### E2E shard `%s`\n\n%s\n' "$SHARD" "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"
fi
exit $RC
