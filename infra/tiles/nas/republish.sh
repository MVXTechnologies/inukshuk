#!/bin/sh
# Re-upload everything the NAS already built to a (new) Worker's bucket,
# without rebuilding anything: the base-map pieces, summits, parks, geodetic
# points, tides, long-distance trails, Convert grid packs and, when present,
# the climbing data. Written for the move to the company Cloudflare account
# (#731), where the bucket starts empty; reusable for any bucket refill.
#
#   ~/inukshuk-tiles/infra/nas/republish.sh                      # → $TILE_HOST (default: upload.py's)
#   TILE_HOST=https://tiles.mvxtechnologies.com ~/inukshuk-tiles/infra/nas/republish.sh
#   ~/inukshuk-tiles/infra/nas/republish.sh basemap              # one group: small|basemap
#
# Each object is stamped in $WORK/.republish/ once uploaded (host + size +
# mtime), so rerunning after an interruption skips what is done, and
# upload.py resumes a half-sent file part by part. Indexes go up LAST in
# their group (basemap.index.json after every piece, trails-v1.index.json
# after its details), the order the build scripts use, so the app never
# sees an index that names a missing object.
set -eu

WORK=${WORK:-$HOME/inukshuk-tiles/work}
HERE=$(cd "$(dirname "$0")" && pwd)
HOST=${TILE_HOST:-$(python3 -B -c 'import sys; sys.path.insert(0, sys.argv[1]); import upload; print(upload.DEFAULT_HOST)' "$HERE")}
export TILE_HOST="$HOST"
STAMPS=$WORK/.republish/$(echo "$HOST" | sed -E 's#^https?://##; s#[^A-Za-z0-9.-]#_#g')
mkdir -p "$STAMPS"
WHAT=${1:-all}
echo "$(date) republish $WHAT → $HOST"

# put FILE KEY: upload unless this exact file is already stamped for KEY.
put() {
  [ -f "$1" ] || { echo "missing: $1" >&2; exit 1; }
  stamp="$STAMPS/$(echo "$2" | tr '/' '~')"
  sig="$(stat -c '%s %Y' "$1")"
  if [ "$(cat "$stamp" 2>/dev/null)" = "$sig" ]; then
    echo "skip $2 (already uploaded)"
    return 0
  fi
  # Not piped: a pipe would hide upload.py's exit status from `set -e` and
  # stamp a failed upload. Progress goes to the log (tail -f it).
  if ! python3 "$HERE/upload.py" "$1" "$2" --host "$HOST" >"$STAMPS/current.log" 2>&1; then
    tail -5 "$STAMPS/current.log" >&2
    echo "upload of $2 failed; rerun to resume" >&2
    exit 1
  fi
  tail -1 "$STAMPS/current.log"
  echo "$sig" >"$stamp"
}

# The newest file matching a glob (build scripts version their details).
# shellcheck disable=SC2012,SC2086 # the glob must expand; names are ours
newest() { ls -t $1 2>/dev/null | head -1; }

if [ "$WHAT" = all ] || [ "$WHAT" = small ]; then
  # Convert grid packs: files and manifests, then the index (as projgrids.sh).
  PG=$WORK/projgrids/out/proj-grids
  for d in "$PG"/*/; do
    pack=$(basename "$d")
    for f in "$d"*.tif "$d"manifest.json; do
      [ -e "$f" ] && put "$f" "proj-grids/$pack/$(basename "$f")"
    done
  done
  put "$PG/index.json" proj-grids/index.json

  # Long-distance trails: details + offsets of the newest version, index last.
  bin=$(newest "$WORK/trails/out/trails-*.details.bin")
  v=$(basename "$bin" .details.bin)
  put "$bin" "$v.details.bin"
  put "$WORK/trails/out/$v.offsets.json" "$v.offsets.json"
  put "$WORK/trails/out/trails-v1.index.json" trails-v1.index.json

  put "$WORK/tides/out/tides.pmtiles" tides.pmtiles
  put "$WORK/geodetic/out/geodetic.pmtiles" geodetic.pmtiles
  put "$WORK/peaks/peaks.pmtiles" peaks.pmtiles
  put "$WORK/parks/parks.pmtiles" parks.pmtiles

  # Climbing (#576): only when climbing.sh has built it on this NAS.
  if [ -f "$WORK/climbing/out/crags.pmtiles" ]; then
    put "$WORK/climbing/out/crags.pmtiles" crags.pmtiles
    bin=$(newest "$WORK/climbing/out/climbing-*.details.bin")
    v=$(basename "$bin" .details.bin)
    put "$bin" "$v.details.bin"
    put "$WORK/climbing/out/$v.offsets.json" "$v.offsets.json"
    put "$WORK/climbing/out/climbing-v1.index.json" climbing-v1.index.json
  fi
fi

if [ "$WHAT" = all ] || [ "$WHAT" = basemap ]; then
  # Every piece in pieces.json, then the routing index (as refresh.sh).
  for name in $(python3 -c '
import json, sys
print(" ".join(p["name"] for p in json.load(open(sys.argv[1]))["pieces"]))
' "$HERE/pieces.json"); do
    put "$WORK/$name.pmtiles" "$name.pmtiles"
  done
  put "$HERE/pieces.json" basemap.index.json
fi
echo "$(date) republish $WHAT done"
