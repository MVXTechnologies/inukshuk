#!/bin/sh
# Build and publish the tide-station layer, `tides.pmtiles` (served by the
# Worker as /tides/{z}/{x}/{y}.mvt, TileJSON at /tides.json; the app's
# Overlays → Tide stations), and the tidal-benchmark join the geodetic build
# reads ($WORK/tides/out/tidal_join.json → `cd`/`cs`/… on geodetic marks).
# Design: chart-datum-convert DESIGN.md §2–3 / SOURCES.md; code: ./tides/.
#
#   ~/inukshuk-tiles/infra/nas/tides.sh            # fetch (sources due), normalize, derive, join, tile, upload
#   ~/inukshuk-tiles/infra/nas/tides.sh build      # skip the fetch: use what is on disk
#   TIDES_SOURCES="fr-shom no-kartverket" …         # a subset (the others keep last run's records)
#   TIDES_REFETCH=1 …                               # ignore the monthly fetch cadence
#   TIDES_UPLOAD=0 …                                # build only (uploading is ON since the
#                                                    owner approved shipping, 2026-10-05)
#
# geodetic.sh runs this (GEODETIC_TIDAL_JOIN, on by default) after normalizing the geodetic sources
# (the join reads $WORK/geodetic/norm) and before tiling them.
#
# Sources: NOAA CO-OPS, SHOM RAM, Kartverket, JMA — open, no key. CHS (Canada)
# is NEVER fetched or published here (owner decision, PLAN Q1 = c: CHS stays
# live-only in the app). Fetches are sequential and polite (≥ 1 s/request).
# Every ellipsoidal CD shown has passed an agency oracle (tides/derive.py);
# every tidal benchmark joined has passed the levelled-height check
# (tides/join_geodetic.py). Runs in the geodetic pipeline's Python image.
set -eu

MODE=${1:-all}
WORK=${WORK:-$HOME/inukshuk-tiles/work}
T=$WORK/tides
HERE=$(cd "$(dirname "$0")" && pwd)
PMTILES_IMAGE=${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.31.2}
TIPPECANOE_IMAGE=inukshuk-tippecanoe:2.79.0
PY_IMAGE=inukshuk-geodetic-py:1
MIN_STATIONS=${TIDES_MIN_STATIONS:-2000}
mkdir -p "$T/raw" "$T/norm" "$T/out" "$T/logs" "$T/cache" "$T/proj"
LOCK=$T/.build.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +720 2>/dev/null)" ]; then
    rmdir "$LOCK" && mkdir "$LOCK"
  else
    echo "tides: another build is running ($LOCK); skipping" >&2
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
OWNER=$(stat -c %u:%g "$WORK")

docker image inspect "$PY_IMAGE" >/dev/null 2>&1 || docker build -q -t "$PY_IMAGE" "$HERE/geodetic"

py() {
  docker run --rm -u "$OWNER" --memory "${PY_MEMORY:-1g}" \
    -e TIDES_PAUSE_S -e PROJ_NETWORK=ON -e PROJ_USER_WRITABLE_DIRECTORY=/work/proj \
    -v "$HERE:/nas:ro" -v "$T:/work" -v "$WORK/geodetic/norm:/geonorm:ro" \
    "$PY_IMAGE" python /nas/tides/build.py "$@"
}

SOURCES=${TIDES_SOURCES:-$(py sources)}

if [ "$MODE" = all ]; then
  for SRC in $SOURCES; do
    STAMP=$T/raw/.$SRC.fetched
    AGE_DAYS=999
    [ -f "$STAMP" ] && AGE_DAYS=$((($(date +%s) - $(cat "$STAMP")) / 86400))
    if [ "${TIDES_REFETCH:-}" != 1 ] && [ "$AGE_DAYS" -lt 27 ]; then
      echo "$(date) $SRC: fetched $AGE_DAYS days ago; reusing"
      continue
    fi
    echo "$(date) $SRC: fetching"
    if py fetch "$SRC" /work/raw >>"$T/logs/fetch-$SRC.log" 2>&1; then
      date +%s >"$STAMP"
    else
      echo "$(date) $SRC: fetch FAILED; the previous raw copy (if any) stays" >&2
    fi
  done
fi

for SRC in $SOURCES; do
  [ -d "$T/raw/$SRC" ] || continue
  py normalize "$SRC" /work/raw /work/norm || echo "$(date) $SRC: normalize failed" >&2
done

# Ellipsoidal CD + oracle checks (VDatum answers cached per station in cache/vdatum).
py derive /work/norm /work/out /work/cache
# Tidal benchmarks → geodetic marks (ID first + levelled-height check).
if [ -d "$WORK/geodetic/norm" ]; then
  py join /work/norm /geonorm /work/out
fi
DESC=$(py assemble /work/out | tail -1)
COUNT=$(python3 -c "import json,sys; print(sum(json.loads(sys.argv[1])['counts'].values()))" "$DESC")
echo "$(date) $COUNT tide stations: $DESC"
PREVIOUS=$(cat "$T/count" 2>/dev/null || echo 0)
if [ "$COUNT" -lt "$MIN_STATIONS" ]; then
  echo "tides: $COUNT stations < $MIN_STATIONS expected; not uploading" >&2
  exit 1
fi
if [ "$PREVIOUS" -gt 0 ] && [ $((COUNT * 10)) -lt $((PREVIOUS * 7)) ]; then
  echo "tides: $COUNT stations is > 30 % below last run's $PREVIOUS; not uploading" >&2
  exit 1
fi

if ! docker image inspect "$TIPPECANOE_IMAGE" >/dev/null 2>&1; then
  echo "tides: $TIPPECANOE_IMAGE is missing — run peaks.sh once (it builds the image)" >&2
  exit 1
fi
ATTRIBUTION=$(py attribution /work/out | tail -1)
# A few thousand points: every station in every tile from z3 (-r1, no
# dropping); MapLibre overzooms z10. Strings stay strings (agency digits).
docker run --rm -u "$OWNER" -v "$T/out:/data" "$TIPPECANOE_IMAGE" \
  -o /data/tides.new.pmtiles --force -t /data \
  -n 'Inukshuk tide stations' -A "$ATTRIBUTION" -N "$DESC" \
  -Z3 -z10 -r1 --no-feature-limit --no-tile-size-limit \
  -T s:int -T pa:int -T i:string -T L:string -T D:string -T E:string -T X:string -T rL:string \
  --quiet -L tide_stations:/data/tides.geojsonl
docker run --rm -v "$T/out:/data" "$PMTILES_IMAGE" verify /data/tides.new.pmtiles >/dev/null
mv "$T/out/tides.new.pmtiles" "$T/out/tides.pmtiles"
echo "$(date) tides.pmtiles $(du -h "$T/out/tides.pmtiles" | cut -f1)"
cp "$T/out/tides-report.json" "$T/report-$(date +%Y-%m-%d).json"
if [ "${TIDES_UPLOAD:-1}" = 1 ]; then
  python3 "$HERE/upload.py" "$T/out/tides.pmtiles" tides.pmtiles | tail -1
  echo "$COUNT" >"$T/count"
fi
echo "$(date) tides done"
