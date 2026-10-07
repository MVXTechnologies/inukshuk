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

# Stop the app and wait until WindowManager has removed its windows before
# the next flow launches it. Maestro's launchApp force-stops and restarts in
# one go; when the old window was still EXITING, the new task's
# "starting_reveal" transition never completed on the CI emulator (runs
# 37616199722 and 37671698583: "Timed out waiting for animations to complete
# ... starting_reveal" every 5 s, UiAutomator "Could not detect idle state" ~200
# times), so every Maestro step waited for an idle that never came and
# store.yaml timed out twice. Event-driven: poll until no window of the app is
# left, bounded; a timeout is reported, not hidden.
app_stop_settled() {
  adb shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  local waited=0
  while adb shell dumpsys window windows 2>/dev/null | grep -qE "Window\{[^}]* $APP_ID"; do
    if [ "$waited" -ge 30 ]; then
      echo "::warning title=E2E ($SHARD): app windows still present 30 s after force-stop::before $1; the next launch may stall"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# One flow attempt, with the feed on only while Maestro runs it.
run_flow() {
  local flow=$1 own_location=$2
  geo_pause
  app_stop_settled "$flow"
  [ "$own_location" = 1 ] || touch "$GEO_RUN"
  maestro test "$flow"
  local rc=$?
  geo_pause
  return $rc
}

RC=0
SYSTEM_BROKE=0
SUMMARY="| Flow | Result | Time |"$'\n'"| --- | --- | --- |"
# Screenshots taken from here on are this run's; anything older is stale.
SHOT_MARK=$(mktemp)
RAN_PDF_OVERLAYS=0
for entry in "${FLOWS[@]}"; do
  flow=${entry% *}
  own_location=${entry##* }
  name=$(basename "$flow" .yaml)
  [ "$name" = pdf-overlays ] && RAN_PDF_OVERLAYS=1
  if [ "$SYSTEM_BROKE" = 1 ]; then
    # Nothing that runs on a rebooted emulator counts.
    SUMMARY+=$'\n'"| $name | NOT RUN (emulator system_server restarted) | |"
    continue
  fi
  started=$SECONDS
  adb logcat -c || true
  if run_flow "$flow" "$own_location"; then
    result=PASS
  elif system_server_restarted "$name" "$flow"; then
    result="FAIL (infra: system_server restarted)"
    RC=1
    SYSTEM_BROKE=1
  else
    # One retry: launch races (map-init timing, post-boot churn) pass on a
    # clean second run. Keep the FIRST failure's logcat either way, so a
    # retried-but-green flow still leaves evidence it flaked — and say so in
    # an annotation, so a flake is visible on a green run too.
    adb logcat -d > "logcat-failure-$name.txt" || true
    adb logcat -c || true
    if run_flow "$flow" "$own_location"; then
      result="PASS (on retry)"
      echo "::warning title=E2E flake ($SHARD)::$flow failed once and passed on retry; see logcat-failure-$name.txt in the shard's artifact"
    elif system_server_restarted "$name-retry" "$flow (retry)"; then
      result="FAIL (infra: system_server restarted)"
      RC=1
      SYSTEM_BROKE=1
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
rm -f "$GEO_RUN"

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
