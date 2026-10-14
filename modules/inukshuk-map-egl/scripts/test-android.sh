#!/bin/sh
# Plain-JVM tests of the map EGL guard's pure core (#697): the surface
# teardown order, the view-tree walk and the
# emulator detection that gates the guard. No Android SDK, Gradle or emulator.
#
#   sh modules/inukshuk-map-egl/scripts/test-android.sh
#
# Needs kotlinc (preinstalled on GitHub's Ubuntu runners) and a JDK 17+.
# KOTLIN_STDLIB_JAR overrides the runtime jar found next to kotlinc.
set -eu
module_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
core="$module_dir/android/src/main/java/expo/modules/inukshukmapegl/core"
tests="$module_dir/android/src/test/java/expo/modules/inukshukmapegl/core"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT HUP INT TERM

if ! command -v kotlinc >/dev/null 2>&1; then
  echo "kotlinc not found: cannot run the inukshuk-map-egl Kotlin tests" >&2
  exit 1
fi
if [ -z "${KOTLIN_STDLIB_JAR:-}" ]; then
  bin=$(command -v kotlinc)
  while [ -L "$bin" ]; do
    link=$(ls -l "$bin" | sed 's/.* -> //')
    case $link in /*) bin=$link ;; *) bin=$(dirname "$bin")/$link ;; esac
  done
  KOTLIN_STDLIB_JAR="$(dirname "$bin")/../lib/kotlin-stdlib.jar"
fi
[ -f "$KOTLIN_STDLIB_JAR" ] || { echo "kotlin-stdlib.jar not found at $KOTLIN_STDLIB_JAR" >&2; exit 1; }

kotlinc -nowarn -d "$out" \
  "$core/SurfaceTeardown.kt" "$core/EmulatorDetection.kt" \
  "$tests/SurfaceTeardownTest.kt" "$tests/EmulatorDetectionTest.kt"
java -cp "$out:$KOTLIN_STDLIB_JAR" expo.modules.inukshukmapegl.core.SurfaceTeardownTestKt
java -cp "$out:$KOTLIN_STDLIB_JAR" expo.modules.inukshukmapegl.core.EmulatorDetectionTestKt
