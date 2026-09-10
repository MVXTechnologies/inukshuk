#!/usr/bin/env bash
# Run the PDF-overlay rendering e2e (#331) end to end on one device:
#   1. generate the fixture catalog (incl. the large single-JPEG GeoPDF, which
#      is not checked in),
#   2. serve it on 127.0.0.1:8787 (what the e2e build's CATALOG_MANIFEST_URL
#      points at; `adb reverse` maps an emulator's loopback onto it),
#   3. run .maestro/pdf-overlays.yaml,
#   4. verify from its map screenshot that the overlay drew.
#
# Usage:
#   scripts/e2e/pdf-overlays.sh [--device <udid|serial>] [--shots <dir>]
# Needs: maestro on PATH (with a JVM), python3, the e2e app installed on the
# device. Exit status is non-zero when the flow or the pixel check fails.
set -u
REPO=$(cd -- "$(dirname -- "$0")/../.." && pwd)
DEVICE=""
SHOTS="$REPO"
while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --shots) SHOTS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$SHOTS"

echo "== fixtures"
(cd "$REPO" && npx tsx scripts/catalog/make-fixture.ts) || exit 1

echo "== fixture server on 127.0.0.1:8787"
python3 -m http.server 8787 --bind 127.0.0.1 --directory "$REPO/.maestro/fixtures/catalog" \
  >/dev/null 2>&1 &
CATALOG_PID=$!
trap 'kill $CATALOG_PID 2>/dev/null' EXIT
if command -v adb >/dev/null 2>&1; then adb reverse tcp:8787 tcp:8787 >/dev/null 2>&1 || true; fi
sleep 1

echo "== flow"
# Maestro writes takeScreenshot files into its cwd.
cd "$SHOTS" || exit 1
if [ -n "$DEVICE" ]; then
  maestro --device "$DEVICE" test "$REPO/.maestro/pdf-overlays.yaml"
else
  maestro test "$REPO/.maestro/pdf-overlays.yaml"
fi
FLOW_RC=$?
echo "== flow exit $FLOW_RC"
[ "$FLOW_RC" -eq 0 ] || exit "$FLOW_RC"

echo "== pixel check"
node "$REPO/scripts/e2e/check-overlay-screenshot.mjs" "$SHOTS/pdf-overlays-map.png"
