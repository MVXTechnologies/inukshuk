#!/bin/sh
# Build and publish the base map's parks layers, `parks.pmtiles` (served by
# the Worker as /parks/{z}/{x}/{y}.mvt; the app's `stone-park-band`,
# `stone-park-line` and `stone-park-label` layers). Protomaps misfiles too
# many national parks to rank them (see parks_geojson.py): this puts every
# OSM boundary=national_park on the map with its boundary and its name.
#
#   ~/inukshuk-tiles/infra/nas/parks.sh     # several hours (estimate; never run in full)
#
# 1. Overpass, two queries per pieces.json bbox, sequentially, a bbox split in
#    four when it is too big: the national tier with its geometry, then the
#    tags + bounds of every other named protected area.
#    OVERPASS_URL picks another endpoint (default overpass-api.de);
#    PARKS_RESUME=1 keeps the answers of an interrupted run.
# 2. parks_geojson.py convert: two GeoJSONSeq files — the national polygons
#    and one label point per protected area — each feature with the minzoom
#    its area earns.
# 3. tippecanoe (the image peaks.sh builds, pinned) → PMTiles with two layers,
#    `parks` (polygons) and `park_labels` (points).
# 4. Sanity check, then upload.py → R2 `parks.pmtiles` (Worker upload token).
#
# Refuses to upload when the national-park count is below PARKS_MIN_FEATURES
# (first run) or dropped more than 30 % since the last published run. Not in
# scheduler.sh yet (see ../README.md § Parks); needs Docker, python3 and
# ~4 GB in $WORK. After the FIRST upload, set PARKS_TILES_PUBLISHED in
# src/data/basemapTiles.ts — until then the app draws Protomaps' parks.
set -eu

WORK=${WORK:-$HOME/inukshuk-tiles/work}
PARKS=$WORK/parks
HERE=$(cd "$(dirname "$0")" && pwd)
PMTILES_IMAGE=${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.31.2}
# The image peaks.sh builds (same pinned felt/tippecanoe release).
TIPPECANOE_VERSION=2.79.0
TIPPECANOE_IMAGE=inukshuk-tippecanoe:$TIPPECANOE_VERSION
# OSM has ~4 600 named boundary=national_park (Overpass count, 2026-10-02),
# plus the IUCN II protected areas; far below means Overpass answered short.
MIN_FEATURES=${PARKS_MIN_FEATURES:-3500}
mkdir -p "$PARKS"

if ! docker image inspect "$TIPPECANOE_IMAGE" >/dev/null 2>&1; then
  echo "parks: $TIPPECANOE_IMAGE is missing — run peaks.sh once (it builds the image)" >&2
  exit 1
fi

# 1. Fetch (fresh every run unless resuming).
[ "${PARKS_RESUME:-}" = 1 ] || rm -rf "$PARKS/raw"
echo "$(date) Overpass: ${OVERPASS_URL:-https://overpass-api.de/api/interpreter}"
python3 "$HERE/parks_geojson.py" fetch "$HERE/pieces.json" "$PARKS/raw"

# 2. Convert: "<national polygons> <labels>".
COUNTS=$(python3 "$HERE/parks_geojson.py" convert "$PARKS/raw" "$PARKS/areas.geojsonl" "$PARKS/labels.geojsonl")
COUNT=${COUNTS% *}
LABELS=${COUNTS#* }
echo "$(date) $COUNT national parks, $LABELS labels"
PREVIOUS=$(cat "$PARKS/count" 2>/dev/null || echo 0)
if [ "$COUNT" -lt "$MIN_FEATURES" ]; then
  echo "parks: $COUNT national parks < $MIN_FEATURES expected; not uploading" >&2
  exit 1
fi
if [ "$PREVIOUS" -gt 0 ] && [ $((COUNT * 10)) -lt $((PREVIOUS * 7)) ]; then
  echo "parks: $COUNT national parks is > 30 % below last run's $PREVIOUS; not uploading" >&2
  exit 1
fi

# 3. Tile. Each feature enters at its own minzoom (the `tippecanoe` member:
# a label at its rank, a polygon two zooms earlier) and nothing is ever
# dropped: -r1 turns off the thinning of points at low zooms, and
# --no-feature-limit / --no-tile-size-limit stop tippecanoe shedding features
# from a crowded tile. Polygons are simplified per zoom as usual, but never
# reduced to a pixel (--no-tiny-polygon-reduction: each is tiled only once it
# is a few pixels wide anyway). -z12: the ladder's last rung, MapLibre
# overzooms past it (4096 units ≈ 2.4 m a unit at z12).
docker run --rm -v "$PARKS:/data" "$TIPPECANOE_IMAGE" \
  -o /data/parks.new.pmtiles --force -t /data \
  -n 'Inukshuk parks' -A '© OpenStreetMap contributors' \
  -Z4 -z12 -r1 --no-feature-limit --no-tile-size-limit --no-tiny-polygon-reduction \
  -T rank:int --read-parallel --quiet \
  -L parks:/data/areas.geojsonl -L park_labels:/data/labels.geojsonl
docker run --rm -v "$PARKS:/data" "$PMTILES_IMAGE" verify /data/parks.new.pmtiles >/dev/null
mv "$PARKS/parks.new.pmtiles" "$PARKS/parks.pmtiles"
echo "$(date) parks.pmtiles $(du -h "$PARKS/parks.pmtiles" | cut -f1), uploading"

# 4. Publish, then remember the count for next run's check.
python3 "$HERE/upload.py" "$PARKS/parks.pmtiles" parks.pmtiles | tail -1
echo "$COUNT" >"$PARKS/count"
rm -f "$PARKS/areas.geojsonl" "$PARKS/labels.geojsonl"
echo "$(date) parks done"
