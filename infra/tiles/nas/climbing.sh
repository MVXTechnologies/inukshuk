#!/bin/sh
# Build and publish the climbing-crags extension (Explore → Climbing, Settings →
# Extensions → Climbing crags):
#   - crags.pmtiles (layers `crags`, `route_starts`), served by the Worker's
#     generic archive route as /crags/{z}/{x}/{y}.mvt, TileJSON /crags.json;
#   - one topo (detail document) per crag, packed into
#     climbing-{version}.details.bin + climbing-{version}.offsets.json and
#     served as /climbing/v1/d/{version}/{uid}.json;
#   - the search index climbing-v1.index.json (/climbing/v1/index.json),
#     uploaded LAST: it names the details version, so the switch is atomic.
# Design: the climbing-topos DESIGN.md / SOURCES.md; code: ./climbing/.
#
#   ~/inukshuk-tiles/infra/nas/climbing.sh            # fetch, then build (~1–2 h, mostly Overpass + camptocamp)
#   ~/inukshuk-tiles/infra/nas/climbing.sh fetch      # only the fetchers (one log per source)
#   ~/inukshuk-tiles/infra/nas/climbing.sh build      # only normalize → assemble → tile → upload
#   CLIMBING_SOURCES="ob osm" …                       # a subset (the others keep last run's records)
#   CLIMBING_RESUME=1 …                               # keep the Overpass answers of an interrupted run
#   CLIMBING_UPLOAD=0 …                               # build everything, upload nothing
#
# Sources (all open; SOURCES.md has the licences and verdicts):
#   ob   OpenBeta weekly Parquet export (CC0), from GitHub releases. Facts only:
#        names, grades, styles, positions. Never descriptions or first ascents.
#   osm  OpenStreetMap climbing features (ODbL) through an Overpass MIRROR
#        (OVERPASS_URL; overpass-api.de blocks the NAS). Kept as its own
#        sectors and its own tile layer (route_starts), with its own credit.
#   c2c  camptocamp.org collaborative waypoints (CC BY-SA), 1 request/s,
#        cached by document version. Never personal (NC-ND) content.
# FQME (access status) is a partner slot (climbing/partners.py): nothing is
# read until an agreement is signed. A crag with no status is "unknown",
# never "open".
#
# Gates: a source whose normalized count is below its minimum or > 30 % below
# its last good run keeps its last good records; the assembled crag count must
# clear CLIMBING_MIN_CRAGS and the −30 % rule, or nothing is uploaded.
# Takedowns: climbing/takedowns.json removes records by source id at build.
set -eu

MODE=${1:-all}
WORK=${WORK:-$HOME/inukshuk-tiles/work}
CL=$WORK/climbing
HERE=$(cd "$(dirname "$0")" && pwd)
PMTILES_IMAGE=${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.31.2}
TIPPECANOE_IMAGE=inukshuk-tippecanoe:2.79.0
PY_IMAGE=inukshuk-climbing-py:1
MIN_CRAGS=${CLIMBING_MIN_CRAGS:-30000}
mkdir -p "$CL/raw" "$CL/norm" "$CL/out" "$CL/logs"
# Natural Earth (regions / countries), shared with trails.sh.
NE=$WORK/trails/ne
NE_BASE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
mkdir -p "$NE"
for NAME in ne_50m_admin_0_countries ne_10m_admin_1_states_provinces; do
  [ -s "$NE/$NAME.geojson" ] && continue
  curl -fsSL -o "$NE/$NAME.geojson.tmp" "$NE_BASE/$NAME.geojson"
  mv "$NE/$NAME.geojson.tmp" "$NE/$NAME.geojson"
done

# One run at a time; a lock left by a dead run is cleared after 12 h.
LOCK=$CL/.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +720 2>/dev/null)" ]; then
    rmdir "$LOCK" && mkdir "$LOCK"
  else
    echo "climbing: another run is going ($LOCK); skipping" >&2
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
# Files belong to the owner of $WORK even when the scheduler (root) runs us.
OWNER=$(stat -c %u:%g "$WORK")

docker image inspect "$PY_IMAGE" >/dev/null 2>&1 || docker build -q -t "$PY_IMAGE" "$HERE/climbing"

py() {
  docker run --rm -u "$OWNER" --memory "${PY_MEMORY:-3g}" \
    -e CLIMBING_RESUME -e OVERPASS_URL -e OVERPASS_PAUSE_S -e C2C_PAUSE_S \
    -v "$HERE:/nas:ro" -v "$CL:/work" -v "$NE:/ne:ro" \
    "$PY_IMAGE" python /nas/climbing/build.py "$@"
}

SOURCES=${CLIMBING_SOURCES:-ob osm c2c}

if [ "$MODE" = fetch ] || [ "$MODE" = all ]; then
  # Sources are independent servers: fetch them side by side.
  for SRC in $SOURCES; do
    (
      echo "$(date) $SRC: fetching"
      if PY_MEMORY=1g py fetch "$SRC" /work/raw --pieces /nas/pieces.json; then
        date +%s >"$CL/raw/.$SRC.fetched"
        echo "$(date) $SRC: fetched"
      else
        echo "$(date) $SRC: fetch FAILED; the previous raw copy (if any) stays" >&2
      fi
    ) >>"$CL/logs/fetch-$SRC.log" 2>&1 &
  done
  wait
  echo "$(date) fetch done: $(for S in $SOURCES; do tail -n1 "$CL/logs/fetch-$S.log"; done | tr '\n' ';')"
fi
[ "$MODE" = fetch ] && exit 0

if ! docker image inspect "$TIPPECANOE_IMAGE" >/dev/null 2>&1; then
  echo "climbing: $TIPPECANOE_IMAGE is missing — run peaks.sh once (it builds the image)" >&2
  exit 1
fi

# Normalize each source (gates + last-good fallback inside), then assemble.
for SRC in $SOURCES; do
  py normalize "$SRC" /work/raw /work/norm --takedowns /nas/climbing/takedowns.json \
    || echo "$(date) $SRC: normalize failed; its last good records stay" >&2
done
VERSION=$(date -u +%Y%m%d%H%M)
rm -rf "$CL/out" && mkdir -p "$CL/out"
DESC=$(py assemble /work/norm /work/out --ne /ne --version "$VERSION" \
  --takedowns /nas/climbing/takedowns.json --raw /work/raw | tail -1)
COUNT=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['crags'])" "$DESC")
echo "$(date) $COUNT crags, version $VERSION: $DESC"
PREVIOUS=$(cat "$CL/count" 2>/dev/null || echo 0)
if [ "$COUNT" -lt "$MIN_CRAGS" ]; then
  echo "climbing: $COUNT crags < $MIN_CRAGS expected; not uploading" >&2
  exit 1
fi
if [ "$PREVIOUS" -gt 0 ] && [ $((COUNT * 10)) -lt $((PREVIOUS * 7)) ]; then
  echo "climbing: $COUNT crags is > 30 % below last run's $PREVIOUS; not uploading" >&2
  exit 1
fi

# Tile. Each crag enters at its thinning-ladder minzoom (the `tippecanoe`
# member, ./climbing/publish.py) and nothing is dropped (-r1, no limits).
# -z14: route starts enter at z14 and MapLibre overzooms them for z15–z22.
ATTRIBUTION=$(py attribution)
docker run --rm -u "$OWNER" -v "$CL/out:/data" "$TIPPECANOE_IMAGE" \
  -o /data/crags.new.pmtiles --force -t /data \
  -n 'Inukshuk climbing crags' -A "$ATTRIBUTION" -N "$DESC" \
  -Z4 -z14 -r1 --no-feature-limit --no-tile-size-limit \
  -T r:int -T s:int -T st:int -T a:int -T src:int -T ord:int -T ap:int \
  -T g0:int -T g1:int -T v0:int -T v1:int -T w0:int -T w1:int -T o:int \
  -T i:string -T n:string -T b:string -T v:string -T rg:string -T c:string -T g:string \
  --read-parallel --quiet \
  -L crags:/data/crags.geojsonl -L route_starts:/data/route_starts.geojsonl
docker run --rm -v "$CL/out:/data" "$PMTILES_IMAGE" verify /data/crags.new.pmtiles >/dev/null
mv "$CL/out/crags.new.pmtiles" "$CL/out/crags.pmtiles"
ls -l "$CL/out"

if [ "${CLIMBING_UPLOAD:-1}" = 0 ]; then
  echo "$(date) CLIMBING_UPLOAD=0: built, not uploaded"
  exit 0
fi
# Publish: tiles, then the versioned details, then the index (it names the
# version) LAST.
python3 "$HERE/upload.py" "$CL/out/crags.pmtiles" crags.pmtiles | tail -1
python3 "$HERE/upload.py" "$CL/out/climbing-$VERSION.details.bin" "climbing-$VERSION.details.bin" | tail -1
python3 "$HERE/upload.py" "$CL/out/climbing-$VERSION.offsets.json" "climbing-$VERSION.offsets.json" | tail -1
python3 "$HERE/upload.py" "$CL/out/climbing-v1.index.json" "climbing-v1.index.json" | tail -1
echo "$COUNT" >"$CL/count"
echo "$VERSION" >"$CL/version"
cp "$CL/out/report.json" "$CL/report-$(date +%Y-%m-%d).json"
rm -f "$CL/out/crags.geojsonl" "$CL/out/route_starts.geojsonl"
echo "$(date) climbing done ($VERSION)"
