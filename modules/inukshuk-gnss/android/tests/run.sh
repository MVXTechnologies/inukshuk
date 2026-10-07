#!/bin/sh
# Compiles the module's pure Kotlin (core/) with its tests on a plain JVM and
# runs them. No Android SDK, Gradle or emulator needed. CI runs this in the
# Android native-build job; locally it needs `kotlinc` and `java` on PATH.
#
# KOTLIN_STDLIB_JAR: set it when your kotlinc cannot bundle its runtime
# (-include-runtime needs a full Kotlin distribution); the jar is then put on
# the classpath instead.
set -eu
module_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out_dir=$(mktemp -d)
trap 'rm -rf "$out_dir"' EXIT HUP INT TERM

if ! command -v kotlinc >/dev/null 2>&1; then
  echo "kotlinc not found: cannot run the inukshuk-gnss Kotlin tests" >&2
  exit 1
fi

sources="$module_dir/src/main/java/expo/modules/inukshukgnss/core/LinkCore.kt
$module_dir/src/main/java/expo/modules/inukshukgnss/core/GattProfiles.kt
$module_dir/src/test/java/expo/modules/inukshukgnss/core/LinkCoreTest.kt"

if [ -n "${KOTLIN_STDLIB_JAR:-}" ]; then
  # shellcheck disable=SC2086
  kotlinc $sources -d "$out_dir/tests.jar"
  java -cp "$out_dir/tests.jar:$KOTLIN_STDLIB_JAR" expo.modules.inukshukgnss.core.LinkCoreTestKt
else
  # shellcheck disable=SC2086
  kotlinc $sources -include-runtime -d "$out_dir/tests.jar"
  java -cp "$out_dir/tests.jar" expo.modules.inukshukgnss.core.LinkCoreTestKt
fi
