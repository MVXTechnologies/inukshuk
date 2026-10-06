#!/bin/sh
# Grid packs for the Convert tool (served by the Worker as /proj-grids/…):
# mirror the PROJ-data grids, crop them per province / state / country,
# gate every pack on the official-tool reference suite, then (only with
# PROJGRIDS_UPLOAD=1) upload through upload.py. Code: ./projgrids/build.py.
#
#   ~/inukshuk-tiles/infra/nas/projgrids.sh            # mirror → build → gate (no upload)
#   PROJGRIDS_UPLOAD=1 ~/inukshuk-tiles/infra/nas/projgrids.sh
#
# The reference suite is the app's own src/core/convert/fixtures/reference.json,
# copied next to this script (projgrids/reference.json) when infra is synced.
# Uploads need the Worker routes /proj-grids/* and its /_upload key pattern
# for proj-grids/… (infra/tiles/worker/src/index.ts, deployed by the owner).
# Cadence: monthly (PROJ-data changes rarely); the mirror is a conditional GET.
set -eu

WORK=${WORK:-$HOME/inukshuk-tiles/work}
PG=$WORK/projgrids
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=inukshuk-projgrids:1
mkdir -p "$PG"
OWNER=$(stat -c %u:%g "$WORK")
LOCK=$PG/.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "projgrids: another run is active ($LOCK)" >&2
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" "$HERE/projgrids"

py() {
  docker run --rm -u "$OWNER" --memory "${PY_MEMORY:-3g}" \
    -v "$HERE:/nas:ro" -v "$PG:/work" "$IMAGE" python3 /nas/projgrids/build.py "$@"
}

py mirror
py build
py gate

if [ "${PROJGRIDS_UPLOAD:-0}" = 1 ]; then
  TOKEN=${UPLOAD_TOKEN_FILE:-$HOME/inukshuk-tiles/.upload-token}
  OUT=$PG/out/proj-grids
  # Files and manifests first, the index last: the app only learns of a pack
  # once every file it lists is in place.
  for d in "$OUT"/*/; do
    pack=$(basename "$d")
    for f in "$d"*.tif "$d"manifest.json; do
      python3 "$HERE/upload.py" "$f" "proj-grids/$pack/$(basename "$f")" --token-file "$TOKEN"
    done
  done
  python3 "$HERE/upload.py" "$OUT/index.json" proj-grids/index.json --token-file "$TOKEN"
fi
echo "projgrids: done"
