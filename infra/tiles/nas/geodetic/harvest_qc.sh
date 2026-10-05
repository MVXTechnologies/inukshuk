#!/bin/sh
# Run the Québec datasheet harvester (enrich_qc.py) as a small, always-on
# container: resumes by itself after a NAS reboot, does the ~3-day initial
# pass once, then once a day re-fetches the bulk shapefile (conditional GET)
# and fetches only new matricules or those whose status changed.
#
#   ~/inukshuk-tiles/infra/nas/geodetic/harvest_qc.sh start   # (re)start the container
#   ~/inukshuk-tiles/infra/nas/geodetic/harvest_qc.sh status  # progress.json + last log lines
#   ~/inukshuk-tiles/infra/nas/geodetic/harvest_qc.sh stop    # clean stop after the current sheet
#
# State: $WORK/geodetic/qc-fiches (fiches.jsonl, texts.jsonl.gz, harvest.log).
# geodetic.sh reads fiches.jsonl at build time and ships whatever is there.
set -eu
WORK=${WORK:-$HOME/inukshuk-tiles/work}
HERE=$(cd "$(dirname "$0")" && pwd)
STATE=$WORK/geodetic/qc-fiches
IMAGE=inukshuk-geodetic-py:1
NAME=inukshuk-geodetic-harvest
INTERVAL=${QC_HARVEST_INTERVAL:-2.5}

case "${1:-}" in
start)
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" "$HERE"
  mkdir -p "$STATE/bulk"
  rm -f "$STATE/STOP"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped --memory 512m --cpus 0.5 \
    -u "$(id -u):$(id -g)" -v "$HERE:/app:ro" -v "$STATE:/state" "$IMAGE" sh -c "
      while true; do
        python -c 'import sys; sys.path.insert(0, \"/app\"); import qc; qc.fetch(\"/state/bulk\")' >>/state/harvest.log 2>&1
        python /app/enrich_qc.py harvest /state /state/bulk --interval $INTERVAL >>/state/harvest.log 2>&1
        [ -e /state/STOP ] && sleep infinity
        sleep 86400
      done"
  echo "started $NAME (log: $STATE/harvest.log)"
  ;;
stop)
  touch "$STATE/STOP"
  echo "STOP requested; the container idles after the current sheet (docker rm -f $NAME to remove it)"
  ;;
status)
  cat "$STATE/progress.json" 2>/dev/null && echo
  tail -3 "$STATE/harvest.log" 2>/dev/null || true
  ;;
*)
  echo "usage: $0 start|stop|status" >&2
  exit 2
  ;;
esac
