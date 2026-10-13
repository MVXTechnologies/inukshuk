#!/usr/bin/env bash
# Runs the Hermes + GWP-ASan repro harness (build.sh) on the connected device,
# GWP-ASan sampling every allocation, RUNS times with each libhermesvm.so:
#   - ours (the APK's): must never crash;
#   - meta (Meta's prebuilt, with fibers): must crash at least once, or the
#     harness cannot see #648 and a clean "ours" proves nothing.
#
#   scripts/e2e/hermes-gwp-asan/run.sh <harness-dir> [runs] [evals]
#
# Exit 0: ours clean and the control reproduced. 1: ours crashed. 3: the
# harness proved nothing (no sampling, or the control did not crash).
set -u
DIR=${1:?harness-dir}
RUNS=${2:-5}
EVALS=${3:-300}
DEV=/data/local/tmp/hermes-gwp-asan

adb root >/dev/null 2>&1 || true
adb wait-for-device
adb shell rm -rf "$DEV"
adb shell mkdir -p "$DEV/ours" "$DEV/meta"
adb push "$DIR/eval_stress" "$DEV/" >/dev/null
adb push "$DIR/ours/." "$DEV/ours/" >/dev/null
# The control differs from ours by libhermesvm.so only.
adb shell "cp $DEV/ours/*.so $DEV/meta/"
adb push "$DIR/meta/libhermesvm.so" "$DEV/meta/libhermesvm.so" >/dev/null
adb shell chmod 755 "$DEV/eval_stress"

# Both the environment (native processes, Android 14+) and the per-program
# properties force sampling; the harness prints its GWP-ASan mappings.
for p in process_sampling sample_rate; do adb shell setprop "libc.debug.gwp_asan.$p.eval_stress" 1; done
adb shell setprop libc.debug.gwp_asan.max_allocs.eval_stress 1024
ENV="GWP_ASAN_SAMPLE_RATE=1 GWP_ASAN_PROCESS_SAMPLING=1 GWP_ASAN_MAX_ALLOCS=1024"

# Sanity first: without GWP-ASan the harness itself must run to the end, or a
# crash below says nothing about GWP-ASan.
sanity=$(adb shell "cd $DEV && LD_LIBRARY_PATH=$DEV/ours ./eval_stress 3; echo rc=\$?" 2>&1 | tr -d '\r')
echo "hermes-gwp-asan sanity (no forced sampling): $(tr '\n' ' ' <<< "$sanity")"
if ! grep -q '^done ' <<< "$sanity"; then
  adb logcat -d | grep -E 'eval_stress|DEBUG' | tail -n 60
  echo "::error title=Hermes GWP-ASan harness::the harness does not run even without forced sampling; it proves nothing"
  exit 3
fi

declare -A crashes=() unsampled=() shown=()
for variant in ours meta; do
  crashes[$variant]=0
  unsampled[$variant]=0
  for i in $(seq "$RUNS"); do
    out=$(adb shell "cd $DEV && $ENV LD_LIBRARY_PATH=$DEV/$variant ./eval_stress $EVALS; echo rc=\$?" 2>&1 | tr -d '\r')
    rc=$(sed -n 's/^rc=//p' <<< "$out" | tail -n 1)
    maps=$(sed -n 's/^gwp-asan mappings: //p' <<< "$out")
    done_line=$(grep -c '^done ' <<< "$out" || true)
    echo "hermes-gwp-asan $variant run $i/$RUNS: rc=${rc:-?} gwp-asan mappings=${maps:-?} completed=$done_line"
    [ "${maps:-0}" -gt 0 ] || unsampled[$variant]=$((unsampled[$variant] + 1))
    if [ "${rc:-1}" != 0 ]; then
      crashes[$variant]=$((crashes[$variant] + 1))
      # The first crash of each variant: its backtrace, to show WHICH crash.
      if [ -z "${shown[$variant]:-}" ]; then
        shown[$variant]=1
        adb logcat -d | grep -E 'F DEBUG' | grep -E 'signal|Abort|#[0-9]{2} pc' | tail -n 30
      fi
    fi
    adb logcat -c || true
  done
done
for p in process_sampling sample_rate max_allocs; do
  adb shell setprop "libc.debug.gwp_asan.$p.eval_stress" "''" >/dev/null 2>&1 || true
done

echo "hermes-gwp-asan result: ours ${crashes[ours]}/$RUNS crashed, meta (control) ${crashes[meta]}/$RUNS crashed"
if [ "${unsampled[ours]}" -gt 0 ] || [ "${unsampled[meta]}" -gt 0 ]; then
  echo "::error title=Hermes GWP-ASan harness::GWP-ASan was not sampling in some runs; the harness proves nothing"
  exit 3
fi
if [ "${crashes[ours]}" -gt 0 ]; then
  echo "::error title=Hermes GWP-ASan harness::the APK's libhermesvm.so crashed ${crashes[ours]}/$RUNS runs under GWP-ASan (#648)"
  exit 1
fi
if [ "${crashes[meta]}" -eq 0 ]; then
  echo "::error title=Hermes GWP-ASan harness::the control (Meta's fiber build) did not crash in $RUNS runs, so the harness cannot see #648 and proves nothing"
  exit 3
fi
exit 0
