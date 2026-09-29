#!/bin/sh
# Build and publish the base map's named-summits layer, `peaks.pmtiles`
# (served by the Worker as /peaks/{z}/{x}/{y}.mvt; the app's `stone-peak`
# layer). Protomaps only has peaks from z13; this puts the big summits on the
# map from z5 (see the elevation → zoom ladder in peaks_geojson.py).
#
#   ~/inukshuk-tiles/infra/nas/peaks.sh     # ~1–2 h, almost all of it Overpass
#
# 1. Overpass: every OSM node natural=peak|volcano with a name, one query per
#    pieces.json bbox, sequentially, split in four when a bbox is too big.
#    OVERPASS_URL picks another endpoint (default overpass-api.de);
#    PEAKS_RESUME=1 keeps the answers of an interrupted run.
# 2. peaks_geojson.py: GeoJSONSeq with a per-feature minzoom from elevation.
# 3. tippecanoe (built once from the pinned felt/tippecanoe release) → PMTiles.
# 4. Sanity check, then upload.py → R2 `peaks.pmtiles` (Worker upload token).
#
# Refuses to upload when the summit count is below PEAKS_MIN_FEATURES (first
# run) or dropped more than 30 % since the last published run. Run monthly by
# scheduler.sh after refresh.sh; needs Docker, python3 and ~1 GB in $WORK.
set -eu

WORK=${WORK:-$HOME/inukshuk-tiles/work}
PEAKS=$WORK/peaks
HERE=$(cd "$(dirname "$0")" && pwd)
PMTILES_IMAGE=${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.31.2}
TIPPECANOE_VERSION=2.79.0
TIPPECANOE_SHA256=b0fd9df49b6efc988288ea48774822c6de19eb48428017f27ee0b3b01d44f05d
TIPPECANOE_IMAGE=inukshuk-tippecanoe:$TIPPECANOE_VERSION
# World has ~700k named summits in OSM (taginfo, 2026-09); a count far below
# means Overpass answered short, not that the mountains left.
MIN_FEATURES=${PEAKS_MIN_FEATURES:-400000}
mkdir -p "$PEAKS"

# felt/tippecanoe publishes no image: build its release once, checksum-pinned
# (upstream's own two-stage Dockerfile, fed the tarball instead of a checkout).
if ! docker image inspect "$TIPPECANOE_IMAGE" >/dev/null 2>&1; then
  echo "$(date) building $TIPPECANOE_IMAGE"
  docker build -t "$TIPPECANOE_IMAGE" - <<DOCKERFILE
FROM ubuntu:22.04 AS build
RUN apt-get update && apt-get -y install make gcc g++ libsqlite3-dev zlib1g-dev curl ca-certificates
RUN curl -fsSL -o /tmp/t.tar.gz https://github.com/felt/tippecanoe/archive/refs/tags/$TIPPECANOE_VERSION.tar.gz \
 && echo "$TIPPECANOE_SHA256  /tmp/t.tar.gz" | sha256sum -c - \
 && tar xzf /tmp/t.tar.gz -C /tmp && make -C /tmp/tippecanoe-$TIPPECANOE_VERSION -j4
FROM ubuntu:22.04
RUN apt-get update && apt-get -y install libsqlite3-0 zlib1g && rm -rf /var/lib/apt/lists/*
COPY --from=build /tmp/tippecanoe-$TIPPECANOE_VERSION/tippecanoe /tmp/tippecanoe-$TIPPECANOE_VERSION/tippecanoe-decode /usr/local/bin/
ENTRYPOINT ["tippecanoe"]
DOCKERFILE
fi

# 1. Fetch (fresh every run unless resuming).
[ "${PEAKS_RESUME:-}" = 1 ] || rm -rf "$PEAKS/raw"
echo "$(date) Overpass: ${OVERPASS_URL:-https://overpass-api.de/api/interpreter}"
python3 "$HERE/peaks_geojson.py" fetch "$HERE/pieces.json" "$PEAKS/raw"

# 2. Convert.
COUNT=$(python3 "$HERE/peaks_geojson.py" convert "$PEAKS/raw" "$PEAKS/peaks.geojsonl")
echo "$(date) $COUNT named summits"
PREVIOUS=$(cat "$PEAKS/count" 2>/dev/null || echo 0)
if [ "$COUNT" -lt "$MIN_FEATURES" ]; then
  echo "peaks: $COUNT summits < $MIN_FEATURES expected; not uploading" >&2
  exit 1
fi
if [ "$PREVIOUS" -gt 0 ] && [ $((COUNT * 10)) -lt $((PREVIOUS * 7)) ]; then
  echo "peaks: $COUNT summits is > 30 % below last run's $PREVIOUS; not uploading" >&2
  exit 1
fi

# 3. Tile. Every summit is in the tiles from its minzoom (the `tippecanoe`
# member of each feature) and nothing is ever dropped: -r1 turns off
# tippecanoe's thinning of low zooms, --no-feature-limit / --no-tile-size-limit
# stop it shedding features from a crowded tile (the Alps at z7 is ~75 KB
# gzipped — fine). -z12: the ladder's last rung is z12, so z13+ tiles would be
# copies; MapLibre overzooms z12 (4096 units ≈ 2.4 m at z12, plenty for a label).
docker run --rm -v "$PEAKS:/data" "$TIPPECANOE_IMAGE" \
  -o /data/peaks.new.pmtiles --force -t /data \
  -l peaks -n 'Inukshuk peaks' -A '© OpenStreetMap contributors' \
  -Z5 -z12 -r1 --no-feature-limit --no-tile-size-limit -T ele:int \
  --read-parallel --quiet /data/peaks.geojsonl
docker run --rm -v "$PEAKS:/data" "$PMTILES_IMAGE" verify /data/peaks.new.pmtiles >/dev/null
mv "$PEAKS/peaks.new.pmtiles" "$PEAKS/peaks.pmtiles"
echo "$(date) peaks.pmtiles $(du -h "$PEAKS/peaks.pmtiles" | cut -f1), uploading"

# 4. Publish, then remember the count for next month's check.
python3 "$HERE/upload.py" "$PEAKS/peaks.pmtiles" peaks.pmtiles | tail -1
echo "$COUNT" >"$PEAKS/count"
rm -f "$PEAKS/peaks.geojsonl"
echo "$(date) peaks done"
