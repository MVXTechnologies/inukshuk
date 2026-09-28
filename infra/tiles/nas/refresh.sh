#!/bin/sh
# Refresh the vector base map on R2: cut our regions out of the latest
# Protomaps daily planet build, then upload it through the tile Worker. Run
# monthly (cron on the NAS). Needs Docker, python3 and ~80 GB free in $WORK.
#
#   ~/inukshuk-tiles/infra/nas/refresh.sh
#
# `extract` downloads only the byte ranges our regions need (no 138 GB planet
# download). HTTP/2 is turned off for it: build.protomaps.com resets long
# HTTP/2 streams ("PROTOCOL_ERROR"), which killed the first run. The upload
# (upload.py) goes through the Worker's token-protected multipart endpoint,
# so no S3 credentials are needed; the token lives in ~/inukshuk-tiles/.upload-token
# (mode 600) and as the Worker secret UPLOAD_TOKEN. The live object is only
# replaced when every part is in, and the Worker re-reads a changed archive
# by its ETag.
set -eu

ARCHIVE=${ARCHIVE:-basemap}
WORK=${WORK:-$HOME/inukshuk-tiles/work}
IMAGE=${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.31.2}
HERE=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$WORK"
BUILD=$(curl -fsS https://build-metadata.protomaps.dev/builds.json |
  grep -o '"key": *"[0-9]*\.pmtiles"' | tail -1 | sed 's/.*"\([0-9]*\.pmtiles\)"/\1/')
[ -n "$BUILD" ] || { echo "no Protomaps build found" >&2; exit 1; }
echo "Extracting from Protomaps build $BUILD"

ok=
for attempt in 1 2 3 4 5; do
  if docker run --rm -e GODEBUG=http2client=0 -v "$WORK:/data" -v "$HERE:/cfg:ro" "$IMAGE" \
    extract "https://build.protomaps.com/$BUILD" "/data/$ARCHIVE.new.pmtiles" \
    --region=/cfg/region.geojson --maxzoom=15 --download-threads=4; then
    ok=1
    break
  fi
  echo "extract attempt $attempt failed; retrying in 60 s" >&2
  sleep 60
done
[ -n "$ok" ] || { echo "extract failed" >&2; exit 1; }

docker run --rm -v "$WORK:/data" "$IMAGE" verify "/data/$ARCHIVE.new.pmtiles"
mv "$WORK/$ARCHIVE.new.pmtiles" "$WORK/$ARCHIVE.pmtiles"

python3 "$HERE/upload.py" "$WORK/$ARCHIVE.pmtiles" "$ARCHIVE.pmtiles"
echo "Uploaded $ARCHIVE.pmtiles ($BUILD)"
