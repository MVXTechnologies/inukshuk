#!/bin/sh
# Refresh the vector base map on R2 from the latest Protomaps daily planet
# build: one regional archive per entry in pieces.json (Canada/US and Europe in
# 8 pieces — a single extract's directory does not fit in the NAS's RAM), then
# `basemap.index.json`, which the Worker routes tiles by. The index goes up
# LAST, so a refresh switches over only when every piece is in. Run monthly
# (scheduler.sh); needs Docker, python3 and ~80 GB free in $WORK.
#
#   ~/inukshuk-tiles/infra/nas/refresh.sh [piece-name …]   # default: all pieces
#
# `extract` downloads only the byte ranges a piece needs. HTTP/2 is turned off
# for it: build.protomaps.com resets long HTTP/2 streams ("PROTOCOL_ERROR").
# Uploads go through the Worker's token-protected multipart endpoint
# (upload.py; token in ~/inukshuk-tiles/.upload-token), so no S3 keys.
set -eu

WORK=${WORK:-$HOME/inukshuk-tiles/work}
IMAGE=${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.31.2}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$WORK"

BUILD=$(curl -fsS https://build-metadata.protomaps.dev/builds.json |
  grep -o '"key": *"[0-9]*\.pmtiles"' | tail -1 | sed 's/.*"\([0-9]*\.pmtiles\)"/\1/')
[ -n "$BUILD" ] || { echo "no Protomaps build found" >&2; exit 1; }
echo "$(date) Protomaps build $BUILD"

# "name w,s,e,n" per piece, optionally filtered by the arguments.
PIECES=$(python3 -c '
import json, sys
only = set(sys.argv[2:])
for p in json.load(open(sys.argv[1]))["pieces"]:
    if not only or p["name"] in only:
        print(p["name"], ",".join(str(v) for v in p["bbox"]))
' "$HERE/pieces.json" "$@")

# Heredoc, not a pipe: the loop must run in THIS shell so a failed piece exits
# before the index is published.
while read -r NAME BBOX; do
  echo "$(date) $NAME ($BBOX)"
  ok=
  for attempt in 1 2 3 4 5; do
    if docker run --rm -e GODEBUG=http2client=0 -v "$WORK:/data" "$IMAGE" \
      extract "https://build.protomaps.com/$BUILD" "/data/$NAME.new.pmtiles" \
      --bbox="$BBOX" --maxzoom=15 --download-threads=4 >"$WORK/$NAME.extract.log" 2>&1; then
      ok=1
      break
    fi
    echo "$(date) $NAME extract attempt $attempt failed: $(tail -c 200 "$WORK/$NAME.extract.log")" >&2
    sleep 60
  done
  [ -n "$ok" ] || { echo "$NAME: extract failed" >&2; exit 1; }
  docker run --rm -v "$WORK:/data" "$IMAGE" verify "/data/$NAME.new.pmtiles" >/dev/null
  mv "$WORK/$NAME.new.pmtiles" "$WORK/$NAME.pmtiles"
  echo "$(date) $NAME $(du -h "$WORK/$NAME.pmtiles" | cut -f1), uploading"
  python3 "$HERE/upload.py" "$WORK/$NAME.pmtiles" "$NAME.pmtiles" | tail -1
done <<PIECES_EOF
$PIECES
PIECES_EOF

# Publish the routing index last (only when every piece was refreshed).
if [ $# -eq 0 ]; then
  python3 "$HERE/upload.py" "$HERE/pieces.json" "basemap.index.json" | tail -1
fi
echo "$(date) refresh done ($BUILD)"
