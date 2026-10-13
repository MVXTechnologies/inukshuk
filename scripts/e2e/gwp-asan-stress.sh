#!/usr/bin/env bash
# GWP-ASan stress launches (#648): cold-starts the installed app N times with
# GWP-ASan forced on for its process and sampling EVERY allocation, instead of
# Android's default (enabled in ~1 process in 128, then 1 allocation in
# ~2500). Every free() of a sampled allocation then makes GWP-ASan record a
# frame-pointer backtrace, so a backtrace walk that can fault (#648: the walk
# off a Hermes fiber stack during the start-up eval) faults on nearly every
# launch instead of once in a few hundred, and the crash counter (the caller's
# launch_health) can show a fix works instead of counting lucky runs.
#
#   scripts/e2e/gwp-asan-stress.sh <package> <component> <launches> [hold-seconds]
#
# Needs a debuggable emulator image where `adb root` works (google_apis), and
# sets the per-process libc.debug.gwp_asan.* properties bionic reads at
# process start (Android 14+). It proves sampling was really on: each launch
# must show GWP-ASan's slot mappings in /proc/<pid>/maps, or the script fails.
# Prints one line per launch; the properties are cleared on exit.
set -u
PKG=${1:?package}
COMPONENT=${2:?component}
LAUNCHES=${3:?launches}
HOLD=${4:-8}

adb root >/dev/null 2>&1 || true
adb wait-for-device
for _ in $(seq 30); do
  [ "$(adb shell id -u 2>/dev/null | tr -d '\r')" = 0 ] && break
  sleep 1
done
if [ "$(adb shell id -u 2>/dev/null | tr -d '\r')" != 0 ]; then
  echo "::error title=GWP-ASan stress::adb root is not available on this image; cannot force GWP-ASan sampling"
  exit 2
fi

props=(
  "libc.debug.gwp_asan.process_sampling.$PKG=1"
  "libc.debug.gwp_asan.sample_rate.$PKG=1"
  # Slots alive at once. Each is a page plus guards, and every one splits the
  # pool's mapping: 40000 overran the kernel's map-count limit and GWP-ASan
  # aborted the app at allocation ("Failed to allocate in guarded pool
  # allocator memory", run 38338453153). Slots recycle on free, and every free
  # of a sampled allocation records a backtrace, so 1024 still walks the stack
  # thousands of times per launch.
  "libc.debug.gwp_asan.max_allocs.$PKG=1024"
)
cleanup() {
  for p in "${props[@]}"; do adb shell setprop "${p%%=*}" "''" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT
for p in "${props[@]}"; do adb shell setprop "${p%%=*}" "${p#*=}"; done

unsampled=0
for i in $(seq "$LAUNCHES"); do
  adb shell am start -W -S -n "$COMPONENT" >/dev/null 2>&1 || true
  sleep "$HOLD"
  pid=$(adb shell pidof -s "$PKG" 2>/dev/null | tr -d '\r')
  if [ -n "$pid" ]; then
    slots=$(adb shell "grep -c 'GWP-ASan' /proc/$pid/maps" 2>/dev/null | tr -d '\r')
    echo "gwp-asan stress launch $i/$LAUNCHES: pid $pid alive, ${slots:-0} GWP-ASan mappings"
    [ "${slots:-0}" -gt 0 ] || unsampled=$((unsampled + 1))
  else
    echo "gwp-asan stress launch $i/$LAUNCHES: process gone (crashed?)"
  fi
done
if [ "$unsampled" -gt 0 ]; then
  echo "::error title=GWP-ASan stress::$unsampled launch(es) ran without GWP-ASan mappings: sampling was not forced, so this proves nothing"
  exit 3
fi
exit 0
