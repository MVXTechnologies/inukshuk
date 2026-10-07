#!/bin/sh
# Host tests for the Android half of the team mesh (#589): the pure protocol
# (framing, fuzz, buckets, bans, config) and the NIO engine over real
# 127.0.0.1 sockets. Plain JVM: neither file imports Android.
#
#   sh modules/inukshuk-mesh/scripts/test-android.sh [fuzz-rounds]
#
# Needs kotlinc (preinstalled on GitHub's Ubuntu runners) and a JDK 17+.
# Override the compiler with MESH_KOTLINC (same CLI as kotlinc) and the
# runtime classpath with MESH_KOTLIN_STDLIB.
set -eu
module_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
src="$module_dir/android/src/main/java/expo/modules/inukshukmesh"
test="$module_dir/android/src/test/java/expo/modules/inukshukmesh"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT HUP INT TERM

kotlinc=${MESH_KOTLINC:-kotlinc}
if [ -z "${MESH_KOTLIN_STDLIB:-}" ]; then
  bin=$(command -v "$kotlinc")
  # Resolve symlinks portably (no readlink -f on older macOS).
  while [ -L "$bin" ]; do
    link=$(ls -l "$bin" | sed 's/.* -> //')
    case $link in /*) bin=$link ;; *) bin=$(dirname "$bin")/$link ;; esac
  done
  MESH_KOTLIN_STDLIB="$(dirname "$bin")/../lib/kotlin-stdlib.jar"
fi
[ -f "$MESH_KOTLIN_STDLIB" ] || { echo "kotlin-stdlib.jar not found at $MESH_KOTLIN_STDLIB" >&2; exit 1; }

"$kotlinc" -nowarn -d "$out" \
  "$src/MeshProtocol.kt" "$src/MeshEngine.kt" \
  "$test/MeshProtocolTest.kt" "$test/MeshEngineTest.kt"
java -cp "$out:$MESH_KOTLIN_STDLIB" expo.modules.inukshukmesh.MeshProtocolTestKt "$@"
