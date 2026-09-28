#!/bin/sh
# Refresh the vector base map on R2: cut our regions out of the latest
# Protomaps daily planet build, then upload one PMTiles file. Run monthly
# (cron on the NAS); everything runs in the official go-pmtiles container, so
# the NAS needs only Docker and ~80 GB free in $WORK.
#
#   R2_ACCOUNT_ID=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./refresh.sh
#
# `extract` downloads only the byte ranges our regions need (no 138 GB
# planet download). Replacing the object in place is safe: the Worker keys its
# cache on the ETag and re-reads the directory when it changes.
set -eu

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID (an R2 API token access key)}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
BUCKET=${R2_BUCKET:-inukshuk-tiles}
ARCHIVE=${ARCHIVE:-basemap}
WORK=${WORK:-$HOME/inukshuk-tiles}
IMAGE=${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.31.2}
HERE=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$WORK"
BUILD=$(curl -fsS https://build-metadata.protomaps.dev/builds.json |
  grep -o '"key": *"[0-9]*\.pmtiles"' | tail -1 | sed 's/.*"\([0-9]*\.pmtiles\)"/\1/')
[ -n "$BUILD" ] || { echo "no Protomaps build found" >&2; exit 1; }
echo "Extracting from Protomaps build $BUILD"

docker run --rm -v "$WORK:/data" -v "$HERE:/cfg:ro" "$IMAGE" \
  extract "https://build.protomaps.com/$BUILD" "/data/$ARCHIVE.pmtiles" \
  --region=/cfg/region.geojson --maxzoom=15 --download-threads=8

docker run --rm -v "$WORK:/data" "$IMAGE" verify "/data/$ARCHIVE.pmtiles"

docker run --rm -v "$WORK:/data" -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY "$IMAGE" \
  upload --max-concurrency=4 "/data/$ARCHIVE.pmtiles" "$ARCHIVE.pmtiles" \
  --bucket="s3://$BUCKET?endpoint=https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com&region=auto"

echo "Uploaded $ARCHIVE.pmtiles ($BUILD) to $BUCKET"
