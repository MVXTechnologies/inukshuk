#!/bin/sh
# Precise elevation tiles (#725): Mapterhorn's LiDAR-grade terrain for the
# regions in dem/regions.json → 256-px Terrarium PNG archives on R2, served by
# the Worker as /dem/{z}/{x}/{y}.png (AWS Terrarium everywhere else).
# Runbook: ../README.md "Precise elevation (DEM)"; checks: ../DEM-VALIDATION.md.
#
#   ~/inukshuk-tiles/infra/nas/dem.sh [region …]       # NAS, Docker; default: every region
#   DEM_DRY_RUN=1 DEM_LOCAL=1 infra/tiles/nas/dem.sh   # Mac: each region's tiny dryRunBbox,
#                                                      # native pmtiles + python3/Pillow, no upload
#
# Steps per region, each resumable (rerun the same command after a failure):
#   mask      LiDAR cells from Mapterhorn's coverage index + footprints (dem/coverage.py)
#   extract   `pmtiles extract` of planet z0–12 + the 6-x-y archives' z13–15, region only
#   transcode 512-px WebP → 4 × 256-px PNG, bit-exact, into MBTiles (dem/transcode.py)
#   convert   `pmtiles convert`, then dem.py verify (counts, bytes, pixel sha256, mask)
#   upload    upload.py (resumable multipart through the Worker)
# Then dem.index.json goes up LAST (the Worker switches over atomically), and a
# probe tile per piece is fetched back through the live Worker and compared.
#
# Env: WORK (default ~/inukshuk-tiles/work), DEM_FORCE=1 (rebuild an already
# published Mapterhorn version), DEM_MAX_TOTAL_GB (default 320: refuse to upload
# more — the approved R2 budget is ~270 GB), DEM_JOBS (transcode processes),
# TILE_HOST (Worker URL for the probe), PMTILES_IMAGE.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$HOME/inukshuk-tiles/work}
DEMW=$WORK/dem
DRY=${DEM_DRY_RUN:-}
LOCAL=${DEM_LOCAL:-}
MAX_GB=${DEM_MAX_TOTAL_GB:-320}
TILE_HOST=${TILE_HOST:-https://tiles.mvxtechnologies.com}
PMTILES_IMAGE=${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.31.2}
PY_IMAGE=inukshuk-dem-py:1
MH=https://download.mapterhorn.com
mkdir -p "$DEMW"

log() { echo "$(date '+%F %T') $*"; }

LOCK=$DEMW/.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +2880 2>/dev/null)" ]; then
    rmdir "$LOCK" && mkdir "$LOCK"
  else
    log "dem: another run holds $LOCK; skipping" >&2
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

# --- tools: native on the Mac (DEM_LOCAL=1), pinned images on the NAS ------------------
if [ -n "$LOCAL" ]; then
  py() { python3 "$HERE/dem/dem.py" "$@"; }
  pytest_dem() { python3 -m unittest discover -s "$HERE/dem" -p 'test_*.py' 2>&1 | tail -3; }
  pmt() { pmtiles "$@"; }
  W=$DEMW
else
  # Files belong to the owner of $WORK even when the scheduler (root) runs us.
  OWNER=$(stat -c %u:%g "$WORK" 2>/dev/null || stat -f %u:%g "$WORK")
  docker image inspect "$PY_IMAGE" >/dev/null 2>&1 || docker build -q -t "$PY_IMAGE" "$HERE/dem"
  py() {
    docker run --rm -u "$OWNER" --memory "${PY_MEMORY:-4g}" -v "$HERE:/nas:ro" -v "$DEMW:/w" \
      "$PY_IMAGE" python /nas/dem/dem.py "$@"
  }
  pytest_dem() {
    docker run --rm -v "$HERE:/nas:ro" "$PY_IMAGE" \
      python -m unittest discover -s /nas/dem -p 'test_*.py' 2>&1 | tail -3
  }
  pmt() { docker run --rm -u "$OWNER" -e GODEBUG=http2client=0 -v "$DEMW:/w" "$PMTILES_IMAGE" "$@"; }
  W=/w
fi

# The pipeline's own tests first: a broken transcoder must never reach R2.
log "self-test"
pytest_dem | tee "$DEMW/selftest.log"
grep -q '^OK' "$DEMW/selftest.log" || { log "self-test failed" >&2; exit 1; }

curl -fsS "$MH/download_urls.json" -o "$DEMW/download_urls.json"
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DEMW/download_urls.json")
[ -n "$VERSION" ] || { log "no Mapterhorn version" >&2; exit 1; }
log "Mapterhorn $VERSION"
if [ -z "$DRY" ] && [ -z "${DEM_FORCE:-}" ] && [ $# -eq 0 ] \
  && [ "$(cat "$DEMW/.published" 2>/dev/null)" = "$VERSION" ]; then
  log "Mapterhorn $VERSION is already published; nothing to do (DEM_FORCE=1 rebuilds)"
  exit 0
fi
V=$DEMW/$VERSION
VW=$W/$VERSION
mkdir -p "$V"
# Earlier versions' working files (extracts, MBTiles) go once a new one starts.
for old in "$DEMW"/0.*; do
  [ -d "$old" ] && [ "$old" != "$V" ] && { log "removing old working dir $old"; rm -rf "$old"; }
done

[ -s "$V/coverage-index.pmtiles" ] || {
  curl -fsS "$MH/coverage-index.pmtiles" -o "$V/coverage-index.pmtiles.new"
  mv "$V/coverage-index.pmtiles.new" "$V/coverage-index.pmtiles"
}
curl -fsS "$MH/attribution.json" -o "$V/attribution.json"
# Every source we serve must still be in Mapterhorn's attribution list (credits).
python3 - "$HERE/dem/regions.json" "$V/attribution.json" <<'EOF'
import json, sys
conf = json.load(open(sys.argv[1]))
known = {e['source'] for e in json.load(open(sys.argv[2]))}
missing = sorted({s for r in conf['regions'] for s in r['sources']} - known)
if missing:
    sys.exit(f'served sources missing from attribution.json: {missing}')
EOF

REGIONS=$(python3 -c '
import json, sys
only = set(sys.argv[2:])
for r in json.load(open(sys.argv[1]))["regions"]:
    if not only or r["name"] in only:
        print(r["name"], ",".join(str(v) for v in r["bbox"]), ",".join(str(v) for v in r["dryRunBbox"]))
' "$HERE/dem/regions.json" "$@")

MANIFESTS=
while read -r NAME BBOX DRYBBOX; do
  [ -n "$NAME" ] || continue
  [ -n "$DRY" ] && BBOX=$DRYBBOX
  R=$V/$NAME
  RW=$VW/$NAME
  mkdir -p "$R"
  log "$NAME ($BBOX)"

  # 1. mask
  if [ ! -s "$R/mask.json" ]; then
    # Footprints one macrotile (≤ 0.09°) beyond the bbox: the edge cells' inset reads them.
    CBOX=$(python3 -c 'import sys; w,s,e,n=map(float,sys.argv[1].split(",")); print(f"{w-0.1},{s-0.1},{e+0.1},{n+0.1}")' "$BBOX")
    [ -s "$R/coverage.pmtiles" ] || {
      pmt extract "$MH/coverage.pmtiles" "$RW/coverage.new.pmtiles" --bbox="$CBOX" \
        --minzoom=12 --maxzoom=12 >"$R/coverage.extract.log" 2>&1
      mv "$R/coverage.new.pmtiles" "$R/coverage.pmtiles"
    }
    py mask --region "$NAME" \
      --index "$VW/coverage-index.pmtiles" --coverage "$RW/coverage.pmtiles" --bbox="$BBOX" \
      --mask "$RW/mask.json.new" --geojson "$RW/region.geojson"
    mv "$R/mask.json.new" "$R/mask.json"
  fi

  # 2. extract (one archive per Mapterhorn file; a finished one is kept)
  INPUTS=
  py plan --urls "$W/download_urls.json" --geojson "$RW/region.geojson" >"$R/plan.txt"
  while read -r URL Z0 Z1; do
    OUT=$(basename "$URL" .pmtiles)-$Z0-$Z1.pmtiles
    INPUTS="$INPUTS $RW/$OUT"
    [ -s "$R/$OUT" ] && continue
    ok=
    for attempt in 1 2 3 4 5; do
      if pmt extract "$URL" "$RW/$OUT.new" --region="$RW/region.geojson" \
        --minzoom="$Z0" --maxzoom="$Z1" --download-threads=4 >"$R/$OUT.log" 2>&1; then
        ok=1
        break
      fi
      log "$NAME: extract $OUT attempt $attempt failed: $(tail -c 200 "$R/$OUT.log")" >&2
      sleep 60
    done
    [ -n "$ok" ] || { log "$NAME: extract $OUT failed" >&2; exit 1; }
    pmt verify "$RW/$OUT.new" >/dev/null
    mv "$R/$OUT.new" "$R/$OUT"
    log "$NAME: $OUT $(du -h "$R/$OUT" | cut -f1)"
  done <"$R/plan.txt"

  # Mapterhorn must not have published a new release under us mid-extract.
  NOW=$(curl -fsS "$MH/download_urls.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
  [ "$NOW" = "$VERSION" ] || { log "Mapterhorn moved to $NOW during the run; rerun" >&2; exit 1; }

  # 3. transcode (resumable) → 4. convert + verify
  if [ ! -s "$R/manifest.json" ]; then
    # shellcheck disable=SC2086
    py transcode --mask "$RW/mask.json" --out "$RW/$NAME.mbtiles" --name "$NAME" \
      ${DEM_JOBS:+--jobs "$DEM_JOBS"} $INPUTS
    rm -f "$R/$NAME.pmtiles"
    pmt convert "$RW/$NAME.mbtiles" "$RW/$NAME.pmtiles" >"$R/convert.log" 2>&1
    py verify --mbtiles "$RW/$NAME.mbtiles" --pmtiles "$RW/$NAME.pmtiles" --name "$NAME" \
      --mask "$RW/mask.json" --manifest "$RW/manifest.json.new"
    mv "$R/manifest.json.new" "$R/manifest.json"
  fi
  MANIFESTS="$MANIFESTS $RW/manifest.json"
  log "$NAME: $(du -h "$R/$NAME.pmtiles" | cut -f1) ready"
done <<REGIONS_EOF
$REGIONS
REGIONS_EOF

# --- budget, upload, index ------------------------------------------------------------
TOTAL=0
for m in $MANIFESTS; do
  b=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bytes"])' "$V/${m#"$VW"/}")
  TOTAL=$((TOTAL + b))
done
log "total $((TOTAL / 1000000000)) GB (budget $MAX_GB GB)"
[ $((TOTAL / 1000000000)) -le "$MAX_GB" ] || { log "over DEM_MAX_TOTAL_GB; not uploading" >&2; exit 1; }

# shellcheck disable=SC2086
py index --version "$VERSION" --out "$VW/dem.index.json" $MANIFESTS
if [ -n "$DRY" ]; then
  log "dry run: built $(echo $MANIFESTS | wc -w | tr -d ' ') piece(s) and $V/dem.index.json; nothing uploaded"
  exit 0
fi
[ $# -eq 0 ] || { log "partial run ($*): pieces built, index NOT published (run without arguments)"; exit 0; }

for m in $MANIFESTS; do
  NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$V/${m#"$VW"/}")
  log "uploading $NAME"
  python3 "$HERE/upload.py" "$V/$NAME/$NAME.pmtiles" "$NAME.pmtiles" | tail -1
done
python3 "$HERE/upload.py" "$V/dem.index.json" "dem.index.json" | tail -1
echo "$VERSION" >"$DEMW/.published"
log "published Mapterhorn $VERSION"

# --- probe: one tile per piece back through the live Worker ----------------------------
sleep 360 # the Worker re-reads dem.index.json every 5 minutes per isolate
for m in $MANIFESTS; do
  python3 - "$V/${m#"$VW"/}" "$TILE_HOST" <<'EOF'
import hashlib, json, random, sys, urllib.request
m = json.load(open(sys.argv[1]))
z, x, y = m['probe']['tile']
url = f"{sys.argv[2]}/dem/{z}/{x}/{y}.png?v={random.randint(1000, 9999)}"
req = urllib.request.Request(url, headers={'User-Agent': 'inukshuk-dem-probe/1'})
with urllib.request.urlopen(req, timeout=60) as r:
    body, source = r.read(), r.headers.get('X-Dem-Source')
ok = hashlib.sha256(body).hexdigest() == m['probe']['sha256'] and source == f"lidar:{m['name']}"
print(f"probe {m['name']} {z}/{x}/{y}: {source} {'OK' if ok else 'MISMATCH'}")
sys.exit(0 if ok else 1)
EOF
done
