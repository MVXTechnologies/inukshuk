#!/bin/sh
# Build and publish the long-distance trails for Explore (#467): the index
# the app downloads once, and one detail document per trail, packed into one
# object (served by the Worker as /trails/v1/index.json and
# /trails/v1/d/{version}/{id}.json).
#
#   ~/inukshuk-tiles/infra/nas/trails.sh     # ~1–3 h, almost all of it Overpass
#
# 1. Overpass, per pieces.json bbox (split in four when too big): the tags +
#    bounds of every candidate route relation, then the geometry of the ones
#    long enough, then of their stages. OVERPASS_URL picks another endpoint;
#    TRAILS_RESUME=1 keeps the answers of an interrupted run.
# 2. Wikidata sitelink counts for the relations that carry a `wikidata` tag
#    (one request per 50 items) — the fame half of the popularity score.
# 3. trails_build.py build: index + details.bin + offsets.json, countries and
#    regions from Natural Earth (downloaded once into $TRAILS/ne).
# 4. Sanity check, then upload.py: details and offsets under a new version,
#    the index LAST (it names the version, so the switch is atomic).
#
# Refuses to upload when the trail count is below TRAILS_MIN_TRAILS (first
# run) or dropped more than 30 % since the last published run. Needs python3
# and ~2 GB in $WORK (raw Overpass geometry dominates). Not scheduled yet: see
# ../README.md § Long-distance trails for the scheduler.sh line.
set -eu

WORK=${WORK:-$HOME/inukshuk-tiles/work}
TRAILS=$WORK/trails
HERE=$(cd "$(dirname "$0")" && pwd)
# OSM has ~15–25k route relations that pass the filters worldwide (estimate
# from the 2026-09 pilot: Québec + Maritimes + New England + the Alps gave
# the numbers in the README); far below means Overpass answered short.
MIN_TRAILS=${TRAILS_MIN_TRAILS:-8000}
# Natural Earth's GeoJSON mirror (public domain; the NAS has no GDAL to read
# the shapefiles): countries at 1:50m (3 MB), regions at 1:10m (40 MB).
NE_BASE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
mkdir -p "$TRAILS/ne"
for NAME in ne_50m_admin_0_countries ne_10m_admin_1_states_provinces; do
  [ -s "$TRAILS/ne/$NAME.geojson" ] && continue
  echo "$(date) Natural Earth $NAME"
  curl -fsSL -o "$TRAILS/ne/$NAME.geojson.tmp" "$NE_BASE/$NAME.geojson"
  mv "$TRAILS/ne/$NAME.geojson.tmp" "$TRAILS/ne/$NAME.geojson"
done

# 1–2. Fetch (fresh every run unless resuming).
[ "${TRAILS_RESUME:-}" = 1 ] || rm -rf "$TRAILS/raw"
echo "$(date) Overpass: ${OVERPASS_URL:-https://overpass-api.de/api/interpreter}"
python3 "$HERE/trails_build.py" fetch "$HERE/pieces.json" "$TRAILS"
python3 "$HERE/trails_build.py" wikidata "$TRAILS"

# 3. Build.
VERSION=$(date -u +%Y%m%d%H%M)
rm -rf "$TRAILS/out"
COUNT=$(python3 "$HERE/trails_build.py" build "$TRAILS" "$TRAILS/out" --ne "$TRAILS/ne" --version "$VERSION")
echo "$(date) $COUNT trails, version $VERSION"
PREVIOUS=$(cat "$TRAILS/count" 2>/dev/null || echo 0)
if [ "$COUNT" -lt "$MIN_TRAILS" ]; then
  echo "trails: $COUNT trails < $MIN_TRAILS expected; not uploading" >&2
  exit 1
fi
if [ "$PREVIOUS" -gt 0 ] && [ $((COUNT * 10)) -lt $((PREVIOUS * 7)) ]; then
  echo "trails: $COUNT trails is > 30 % below last run's $PREVIOUS; not uploading" >&2
  exit 1
fi
ls -l "$TRAILS/out"

# 4. Publish: the versioned details first, the index (which names the version) last.
python3 "$HERE/upload.py" "$TRAILS/out/trails-$VERSION.details.bin" "trails-$VERSION.details.bin" | tail -1
python3 "$HERE/upload.py" "$TRAILS/out/trails-$VERSION.offsets.json" "trails-$VERSION.offsets.json" | tail -1
python3 "$HERE/upload.py" "$TRAILS/out/trails-v1.index.json" "trails-v1.index.json" | tail -1
echo "$COUNT" >"$TRAILS/count"
echo "$VERSION" >"$TRAILS/version"
echo "$(date) trails done ($VERSION)"
