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

# The catalog shard keeps every passing flow's logcat too (logcat-pass-*.txt,
# its own artifact): PDF pre-render and frame timings are measured from green
# runs, which otherwise leave no logcat. A larger ring so a flow's start is
# not dropped before the dump.
KEEP_PASS_LOGCAT=0
if [ "$SHARD" = catalog ]; then
  KEEP_PASS_LOGCAT=1
  adb logcat -G 16M || true
fi

# Continuous GPS fixes so the recording flows exercise real location
# deliveries — including through the foreground service while backgrounded,
# the exact path that killed vc44 (missing RECEIVE_BOOT_COMPLETED).
#
# The feed is GATED, not free-running (2026-10-07, run 37628988758): the
# emulator's GNSS HAL can deadlock system_server when a fix's status report
# races GnssNative.stop() — the app's location request ending as Maestro
# force-stops/relaunches it at a flow boundary. The Watchdog then killed
# system_server ("Blocked in handler on foreground thread (android.fg) for
# 68s", GnssNative.stop / GnssStatusProvider.onReportStatus) in two shards at
# once, and every later adb/Maestro call broke ("Broken pipe", "Device server
# died"). So a fix is sent only when ALL of these hold:
#
# - GEO_RUN exists: the runner sets it only while a flow is running, never
#   across flow transitions or installs, and never for `own-location` flows
#   (they set the location themselves and tap by position on a camera that
#   follows the user; the oscillation dragged heatmap.yaml off its target);
# - the app process is up and is the SAME process as at the previous tick
#   (event-driven: a launch, a force-stop or a relaunch pauses the feed until
#   the new process has lived a full tick, i.e. its location request is up);
# - one fix per GEO_TICK seconds (5 s, was 2 s): a recording only needs a
#   fresh fix to keep flowing — the flows' own setLocation/travel steps make
#   the movement — and fewer fixes means fewer status reports to race.
#
# The gate alone was not enough (run 37686186144: the same Watchdog kill in
# make-map). The deadlock is inside the emulator's GNSS stack — GMS holds a
# GnssStatus listener, and GnssNative.stop() reports status synchronously
# while that listener's lock is taken by a delivery — so the fixes no longer
# go through the GNSS HAL at all. `adb emu geo fix` fed the emulated GNSS
# chip; the feed now sets the location of a shell-owned TEST provider named
# `gps` (`cmd location providers set-test-provider-location`). While a test
# provider shadows `gps`, the real GnssLocationProvider is never started or
# stopped, so the deadlocking path is never entered. Apps (and GMS's fused
# provider) still receive the fixes as `gps` locations. If Maestro's own mock
# providers replace or remove it between sessions, the next tick re-adds it.
GEO_RUN=$(mktemp -u)
GEO_TICK=5
APP_ID=com.inukshuk.app
adb shell appops set com.android.shell android:mock_location allow || true
geo_send() {
  local where="$1,$2"
  adb shell cmd location providers set-test-provider-location gps --location "$where" >/dev/null 2>&1 && return 0
  adb shell cmd location providers add-test-provider gps --requiresSatellite >/dev/null 2>&1 || true
  adb shell cmd location providers set-test-provider-enabled gps true >/dev/null 2>&1 || true
  adb shell cmd location providers set-test-provider-location gps --location "$where" >/dev/null 2>&1 || true
}
geo_send 46.8139 -71.2082
if adb shell cmd location providers set-test-provider-location gps --location 46.8139,-71.2082; then
  echo "gps test provider active: fixes bypass the emulated GNSS HAL"
else
  echo "::error title=E2E infra ($SHARD)::could not install the gps test provider; the location feed is down"
fi
(
  prev_pid=''
  point=0
  while true; do
    sleep "$GEO_TICK"
    pid=$(adb shell pidof "$APP_ID" 2>/dev/null | tr -d '\r')
    if [ -e "$GEO_RUN" ] && [ -n "$pid" ] && [ "$pid" = "$prev_pid" ]; then
      if [ "$point" = 0 ]; then
        geo_send 46.8139 -71.2082
      else
        geo_send 46.8145 -71.2075
      fi
      point=$((1 - point))
    fi
    prev_pid=$pid
  done
) &
GEO_PID=$!

# Stop feeding and let a fix already on its way land before Maestro touches
# the app (force-stop, clearState, relaunch, driver install).
geo_pause() {
  rm -f "$GEO_RUN"
  sleep 1
}

# system_server's pid, to tell a real flow failure from the emulator's
# system process dying under it (Watchdog kill, soft reboot).
system_server_pid() {
  adb shell pidof system_server 2>/dev/null | tr -d '\r'
}
SYSTEM_SERVER_PID=$(system_server_pid)
echo "system_server pid at start: ${SYSTEM_SERVER_PID:-none}"

# After a failed attempt: if system_server is no longer the process the shard
# started with, the emulator itself broke. That is reported as its own,
# clearly named infrastructure failure with the evidence attached, and the
# flow is NOT retried: a retry on a rebooted system proves nothing.
system_server_restarted() {
  local now
  now=$(system_server_pid)
  [ -n "$SYSTEM_SERVER_PID" ] && [ "$now" = "$SYSTEM_SERVER_PID" ] && return 1
  adb logcat -d > "logcat-system-server-restart-$1.txt" 2>&1 || true
  adb logcat -b crash -d >> "logcat-system-server-restart-$1.txt" 2>&1 || true
  echo "::error title=E2E infra: emulator system_server restarted ($SHARD)::during $2 (pid ${SYSTEM_SERVER_PID:-none} -> ${now:-none}); the flow result is void. Evidence: logcat-system-server-restart-$1.txt in the shard's artifact (look for 'WATCHDOG KILLING SYSTEM PROCESS')."
  return 0
}

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

trap 'kill $GEO_PID $CATALOG_PID 2>/dev/null; rm -f "$GEO_RUN"' EXIT

# One flow attempt, with the feed on only while Maestro runs it.
run_flow() {
  local flow=$1 own_location=$2 clean=${3:-0}
  geo_pause
  if [ "$clean" = 1 ]; then
    # `clean-state` flows (e2eShards.mjs startsClean): every attempt starts
    # from a cleared app, and Android gets time to finish removing the old
    # task before Maestro launches (an immediate launch was killed by the
    # pending removal and only came up 30 s later).
    adb shell pm clear "$APP_ID" >/dev/null 2>&1 || true
    sleep 5
  fi
  [ "$own_location" = 1 ] || touch "$GEO_RUN"
  maestro test "$flow"
  local rc=$?
  geo_pause
  return $rc
}

# Let Google Play services finish its post-boot restart before the first
# flow. On the google_apis image, com.google.android.gms.persistent dies
# and restarts ~1-2 min after boot, and Android kills every process holding
# one of its content providers. The app holds GMS's FontsProvider, so the
# first flow of a shard lost its app mid-flow ("Killing com.inukshuk.app:
# depends on provider com.google.android.gms/.fonts.provider.FontsProvider in
# dying proc", run 37691418391, make-map and convert). Event-driven: wait
# until the GMS persistent process has kept one pid for 60 s, bounded at
# 4 min, and say how it went.
gms_settled() {
  local pid prev='' stable=0 waited=0
  while [ "$waited" -lt 240 ]; do
    pid=$(adb shell pidof com.google.android.gms.persistent 2>/dev/null | tr -d '\r')
    if [ -n "$pid" ] && [ "$pid" = "$prev" ]; then
      stable=$((stable + 5))
      if [ "$stable" -ge 60 ]; then
        echo "GMS settled (gms.persistent pid $pid stable 60 s, after ${waited}s)"
        return 0
      fi
    else
      [ -n "$prev" ] && [ "$pid" != "$prev" ] && echo "GMS restarted (pid ${prev} -> ${pid:-none}) at ${waited}s"
      stable=0
    fi
    prev=$pid
    sleep 5
    waited=$((waited + 5))
  done
  echo "::warning title=E2E ($SHARD): GMS did not settle::gms.persistent pid not stable for 60 s within 4 min; the first flow may lose its app to a GMS restart"
}
gms_settled

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

# Launch-health counters for the logcat of the attempt that just ran (#643):
# - reveal stalls: WindowManager waiting out a window animation that never
#   ends ("Timed out waiting for animations to complete … starting_reveal").
#   Each synced Maestro input then costs 5 s; that was the store.yaml flake.
# - native crashes of the app ("Fatal signal" in com.inukshuk.app).
# - provider kills: Android killing the app because a content provider it
#   holds died ("depends on provider … in dying proc"), e.g. Play services'
#   FontsProvider when com.google.android.gms.persistent restarts.
# A non-zero count is a defect even on a green flow, so it is annotated.
launch_health() {
  local log stalls crashes kills
  HEALTH=
  log=$(adb logcat -d 2>/dev/null || true)
  stalls=$(grep -c 'Timed out waiting for animations to complete' <<< "$log" || true)
  crashes=$(grep -E 'Fatal signal' <<< "$log" | grep -c 'om\.inukshuk\.app' || true)
  kills=$(grep -E 'Killing [0-9]+:com\.inukshuk\.app/' <<< "$log" | grep -c 'depends on provider' || true)
  if [ "${stalls:-0}" -gt 0 ] || [ "${crashes:-0}" -gt 0 ] || [ "${kills:-0}" -gt 0 ]; then
    echo "::warning title=E2E launch health ($SHARD)::$1: $stalls window-animation stall(s), $crashes native crash(es), $kills provider kill(s) in logcat"
  fi
  HEALTH="${stalls:-0}/${crashes:-0}/${kills:-0}"
}

RC=0
SYSTEM_BROKE=0
SUMMARY="| Flow | Result | Time | Stalls/crashes/provider kills |"$'\n'"| --- | --- | --- | --- |"
# Screenshots taken from here on are this run's; anything older is stale.
SHOT_MARK=$(mktemp)
RAN_PDF_OVERLAYS=0
PIXELS="FAIL (not checked)"
for entry in "${FLOWS[@]}"; do
  read -r flow own_location clean <<< "$entry"
  clean=${clean:-0}
  name=$(basename "$flow" .yaml)
  [ "$name" = pdf-overlays ] && RAN_PDF_OVERLAYS=1
  if [ "$SYSTEM_BROKE" = 1 ]; then
    # Nothing that runs on a rebooted emulator counts.
    SUMMARY+=$'\n'"| $name | NOT RUN (emulator system_server restarted) | | |"
    continue
  fi
  started=$SECONDS
  adb logcat -c || true
  health=
  if run_flow "$flow" "$own_location" "$clean"; then
    result=PASS
    launch_health "$name"
    health=$HEALTH
    if [ "$KEEP_PASS_LOGCAT" = 1 ]; then
      adb logcat -d > "logcat-pass-$name.txt" || true
    fi
  elif system_server_restarted "$name" "$flow"; then
    result="FAIL (infra: system_server restarted)"
    RC=1
    SYSTEM_BROKE=1
  else
    # One retry: launch races (map-init timing, post-boot churn) pass on a
    # clean second run. Keep the FIRST failure's logcat either way, so a
    # retried-but-green flow still leaves evidence it flaked — and say so in
    # an annotation, so a flake is visible on a green run too.
    launch_health "$name"
    health=$HEALTH
    adb logcat -d > "logcat-failure-$name.txt" || true
    adb logcat -c || true
    if run_flow "$flow" "$own_location" "$clean"; then
      launch_health "$name (retry)"
      health="$health, retry $HEALTH"
      result="PASS (on retry)"
      echo "::warning title=E2E flake ($SHARD)::$flow failed once and passed on retry; see logcat-failure-$name.txt in the shard's artifact"
    elif system_server_restarted "$name-retry" "$flow (retry)"; then
      result="FAIL (infra: system_server restarted)"
      RC=1
      SYSTEM_BROKE=1
    else
      launch_health "$name (retry)"
      health="$health, retry $HEALTH"
      result=FAIL
      RC=1
      adb logcat -d > "logcat-failure-$name-retry.txt" || true
    fi
  fi
  took=$((SECONDS - started))
  echo "=== $flow $result ($((took / 60))m$((took % 60))s) ==="
  # pdf-overlays.yaml proves the overlay drew through its map screenshot
  # (#331); the flow passing without the pixels is not a pass. Checked NOW,
  # while the app still shows the map: on a busy emulator the raster can land
  # after the flow's single screenshot, so poll-overlay.sh re-checks fresh
  # screen captures until it passes or 60 s run out (no relaunch, no re-tap;
  # every attempt's sample count is logged). Where Maestro writes the flow's
  # own screenshot depends on its CLI version: find-screenshot.sh looks
  # everywhere.
  if [ "$name" = pdf-overlays ]; then
    if [[ "$result" == PASS* ]]; then
      SHOT=$(bash scripts/e2e/find-screenshot.sh pdf-overlays-map.png .maestro "$SHOT_MARK") || SHOT=-
      echo "=== pdf-overlays screenshot: $SHOT ==="
      # Maestro's mock locations end with its session, and the map follows
      # the user: hold the flow's own location through the runner's gps test
      # provider, or the poll photographs the runner's last fix instead (run
      # 37890668976: Québec at every capture after the flow's own shot).
      if LOC=$(bash scripts/e2e/flow-location.sh "$flow"); then
        read -r lat lon <<< "$LOC"
        geo_send "$lat" "$lon"
        echo "=== pdf-overlays poll held at the flow's location $lat,$lon ==="
        sleep 2
      fi
      if bash scripts/e2e/poll-overlay.sh "$SHOT" 60 3; then PIXELS=PASS; else PIXELS=FAIL; fi
    else
      PIXELS="FAIL (flow failed)"
    fi
  fi
  SUMMARY+=$'\n'"| $name | $result | $((took / 60))m$((took % 60))s | $health |"
done
rm -f "$GEO_RUN"

# pdf-overlays pixels: checked right after the flow (see the loop above).
if [ "$RAN_PDF_OVERLAYS" = 1 ]; then
  SUMMARY+=$'\n'"| pdf-overlays pixels | $PIXELS | |"
  [ "$PIXELS" = PASS ] || RC=1
fi
rm -f "$SHOT_MARK"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### E2E shard `%s`\n\n%s\n' "$SHARD" "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"
fi
exit $RC
