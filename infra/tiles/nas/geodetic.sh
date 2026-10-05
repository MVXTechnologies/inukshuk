#!/bin/sh
# Build and publish the geodetic-points extension layer, `geodetic.pmtiles`
# (served by the Worker as /geodetic/{z}/{x}/{y}.mvt, TileJSON at
# /geodetic.json; the app's Settings → Extensions → Geodetic points).
# Design: the geodetic-points DESIGN.md / SOURCES.md; code: ./geodetic/.
#
#   ~/inukshuk-tiles/infra/nas/geodetic.sh            # fetch (parallel), then build
#   ~/inukshuk-tiles/infra/nas/geodetic.sh fetch      # only the fetchers (background-safe, logs per source)
#   ~/inukshuk-tiles/infra/nas/geodetic.sh build      # only normalize → tile → upload, with what is on disk
#   (scheduler.sh starts `fetch` and `build` side by side every Monday: each
#   build publishes whatever has landed — new sources, newly harvested Québec
#   datasheets — and slow fetches land in the next week's build)
#   GEODETIC_SOURCES="qc-mrnf us-ngs" …               # a subset (the others keep last run's records)
#   GEODETIC_REFETCH=1 …                              # ignore the per-source fetch cadence
#
# fetch: one job per source — i.e. per agency server — at most GEODETIC_JOBS
#   (6) at a time, each polite towards its own server, each with its own log
#   ($WORK/geodetic/logs/fetch-SRC.log) and resumable state. A source is
#   skipped while its last fetch is younger than its cadence; a failed fetch
#   keeps the previous raw copy. OSM goes through an Overpass MIRROR
#   (OVERPASS_URL; overpass-api.de blocks the NAS).
# build: sequential (RAM: ~7.5 GB on the NAS). Normalize each source (gate:
#   minimum count, −30 % vs last good run → keep last run's records; Québec
#   picks up every datasheet geodetic/harvest_qc.sh has harvested so far),
#   assemble (ID-first dedupe, destroyed / not-found dropped, thinning
#   ladder), tippecanoe (the image peaks.sh builds), verify, gate, upload.py.
#
# Sources: every catalogue source with a module (geodetic/{qc,nrcan,ngs,osm}.py,
# geodetic/src_*.py). Runs in the pinned Python image geodetic/Dockerfile.
set -eu

MODE=${1:-all}
WORK=${WORK:-$HOME/inukshuk-tiles/work}
GEO=$WORK/geodetic
HERE=$(cd "$(dirname "$0")" && pwd)
PMTILES_IMAGE=${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.31.2}
TIPPECANOE_IMAGE=inukshuk-tippecanoe:2.79.0
PY_IMAGE=inukshuk-geodetic-py:1
JOBS=${GEODETIC_JOBS:-6}
MIN_FEATURES=${GEODETIC_MIN_FEATURES:-75000}
mkdir -p "$GEO/raw" "$GEO/norm" "$GEO/out" "$GEO/logs" "$GEO/qc-fiches"
# One build at a time (a fetch-only run may overlap a build: fetchers write
# raw/, builds read it). A lock left by a dead run is cleared after 12 h.
if [ "$MODE" != fetch ]; then
  LOCK=$GEO/.build.lock
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +720 2>/dev/null)" ]; then
      rmdir "$LOCK" && mkdir "$LOCK"
    else
      echo "geodetic: another build is running ($LOCK); skipping" >&2
      exit 0
    fi
  fi
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
fi
# Files belong to the owner of $WORK even when the scheduler (root) runs us.
OWNER=$(stat -c %u:%g "$WORK")

docker image inspect "$PY_IMAGE" >/dev/null 2>&1 || docker build -q -t "$PY_IMAGE" "$HERE/geodetic"

py() {
  docker run --rm -u "$OWNER" --memory "${PY_MEMORY:-3g}" \
    -e GEODETIC_RESUME -e OVERPASS_URL -e OVERPASS_PAUSE_S \
    -v "$HERE:/nas:ro" -v "$GEO:/work" -v "$GEO/qc-fiches:/fiches:ro" \
    "$PY_IMAGE" python /nas/geodetic/build.py "$@"
}

SOURCES=${GEODETIC_SOURCES:-$(docker run --rm -v "$HERE:/nas:ro" "$PY_IMAGE" \
  python /nas/geodetic/build.py sources)}

fetch_every_days() {
  case $1 in
    qc-mrnf) echo 6 ;; # daily upstream; weekly is plenty
    *) echo 27 ;;      # monthly
  esac
}

fetch_one() {
  SRC=$1
  STAMP=$GEO/raw/.$SRC.fetched
  AGE_DAYS=999
  [ -f "$STAMP" ] && AGE_DAYS=$((($(date +%s) - $(cat "$STAMP")) / 86400))
  if [ "${GEODETIC_REFETCH:-}" != 1 ] && [ "$AGE_DAYS" -lt "$(fetch_every_days "$SRC")" ]; then
    echo "$(date) $SRC: fetched $AGE_DAYS days ago; reusing"
    return 0
  fi
  # One fetcher per source at a time, whatever runs overlap (stale after 3 days).
  SLOCK=$GEO/raw/.$SRC.lock
  if ! mkdir "$SLOCK" 2>/dev/null; then
    if [ -n "$(find "$SLOCK" -maxdepth 0 -mmin +4320 2>/dev/null)" ]; then
      rmdir "$SLOCK" && mkdir "$SLOCK"
    else
      echo "$(date) $SRC: a fetch is already running; skipping"
      return 0
    fi
  fi
  echo "$(date) $SRC: fetching"
  # Fetchers stream to disk: little RAM each, so several can run side by side.
  if PY_MEMORY=768m GEODETIC_RESUME=1 py fetch "$SRC" /work/raw --pieces /nas/pieces.json; then
    date +%s >"$STAMP"
    echo "$(date) $SRC: fetched"
  else
    echo "$(date) $SRC: fetch FAILED; the previous raw copy (if any) stays" >&2
  fi
  rmdir "$SLOCK" 2>/dev/null || true
}

if [ "$MODE" = fetch ] || [ "$MODE" = all ]; then
  RUNNING=0
  for SRC in $SOURCES; do
    fetch_one "$SRC" >>"$GEO/logs/fetch-$SRC.log" 2>&1 &
    RUNNING=$((RUNNING + 1))
    if [ "$RUNNING" -ge "$JOBS" ]; then
      wait -n 2>/dev/null || wait
      RUNNING=$((RUNNING - 1))
    fi
  done
  wait
  echo "$(date) fetch done: $(tail -qn1 "$GEO"/logs/fetch-*.log | tr '\n' ';')"
fi
[ "$MODE" = fetch ] && exit 0

if ! docker image inspect "$TIPPECANOE_IMAGE" >/dev/null 2>&1; then
  echo "geodetic: $TIPPECANOE_IMAGE is missing — run peaks.sh once (it builds the image)" >&2
  exit 1
fi

# Normalize, one source at a time.
for SRC in $SOURCES; do
  [ -d "$GEO/raw/$SRC" ] || continue
  py normalize "$SRC" /work/raw /work/norm --fiches /fiches || echo "$(date) $SRC: normalize failed" >&2
done

# Tide stations + tidal benchmarks (tides.sh): its join reads the norm files
# just written, and its tidal_join.json marks the tidal benchmarks below. A
# failed tides run never stops the geodetic build (last join stays).
if [ -x "$HERE/tides.sh" ] && [ "${GEODETIC_SKIP_TIDES:-}" != 1 ]; then
  "$HERE/tides.sh" >>"$GEO/logs/tides.log" 2>&1 || echo "$(date) tides.sh failed (see logs/tides.log)" >&2
fi
TIDAL_JOIN=$WORK/tides/out/tidal_join.json
TIDAL_ARGS=""
if [ -f "$TIDAL_JOIN" ] && grep -q -- "'--tidal'" "$HERE/geodetic/build.py"; then
  cp "$TIDAL_JOIN" "$GEO/out/tidal_join.json"
  TIDAL_ARGS="--tidal /work/out/tidal_join.json"
fi

# Assemble (prints the description the app reads from /geodetic.json).
# shellcheck disable=SC2086
DESC=$(py assemble /work/norm /work/out $TIDAL_ARGS | tail -1)
COUNT=$(python3 -c "import json,sys; print(sum(json.loads(sys.argv[1])['counts'].values()))" "$DESC")
echo "$(date) $COUNT live marks: $DESC"
PREVIOUS=$(cat "$GEO/count" 2>/dev/null || echo 0)
if [ "$COUNT" -lt "$MIN_FEATURES" ]; then
  echo "geodetic: $COUNT marks < $MIN_FEATURES expected; not uploading" >&2
  exit 1
fi
if [ "$PREVIOUS" -gt 0 ] && [ $((COUNT * 10)) -lt $((PREVIOUS * 7)) ]; then
  echo "geodetic: $COUNT marks is > 30 % below last run's $PREVIOUS; not uploading" >&2
  exit 1
fi

# Tile. Every mark enters at its ladder minzoom (the `tippecanoe` member) and
# nothing else is ever dropped (-r1, no feature/size limits). -z13: marks the
# ladder lets in at z14 ride in z13 tiles with `z: 14` (the app's z14 layer);
# MapLibre overzooms, and the exact position is in x/y.
ATTRIBUTION=$(docker run --rm -v "$HERE:/nas:ro" -v "$GEO:/work:ro" "$PY_IMAGE" \
  python /nas/geodetic/build.py attribution /work/out/report.json)
docker run --rm -u "$OWNER" -v "$GEO/out:/data" "$TIPPECANOE_IMAGE" \
  -o /data/geodetic.new.pmtiles --force -t /data \
  -n 'Inukshuk geodetic points' -A "$ATTRIBUTION" -N "$DESC" \
  -Z5 -z13 -r1 --no-feature-limit --no-tile-size-limit \
  -T s:int -T d:int -T c:int -T hd:int -T hd2:int -T l:int -T p:int -T z:int \
  -T H:string -T H2:string -T h:string -T cd:string -T cm:string -T cu:int \
  --read-parallel --quiet \
  -L geodetic:/data/geodetic.geojsonl -L geodetic_osm:/data/geodetic_osm.geojsonl
docker run --rm -v "$GEO/out:/data" "$PMTILES_IMAGE" verify /data/geodetic.new.pmtiles >/dev/null
mv "$GEO/out/geodetic.new.pmtiles" "$GEO/out/geodetic.pmtiles"
echo "$(date) geodetic.pmtiles $(du -h "$GEO/out/geodetic.pmtiles" | cut -f1), uploading"

python3 "$HERE/upload.py" "$GEO/out/geodetic.pmtiles" geodetic.pmtiles | tail -1
echo "$COUNT" >"$GEO/count"
cp "$GEO/out/report.json" "$GEO/report-$(date +%Y-%m-%d).json"
rm -f "$GEO/out/geodetic.geojsonl" "$GEO/out/geodetic_osm.geojsonl"
echo "$(date) geodetic done"
