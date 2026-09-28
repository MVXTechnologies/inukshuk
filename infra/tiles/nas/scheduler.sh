#!/bin/sh
# Monthly trigger for refresh.sh, run as a small always-on container because
# user crontabs are disabled on the UGREEN NAS (see compose.yaml). Checks
# hourly; runs once on the 1st of the month from 03:00, remembered in a stamp
# file so a restart the same day doesn't run it twice.
set -u
apk add --no-cache python3 curl >/dev/null
STAMP="$HOME/inukshuk-tiles/work/.last-refresh"
while true; do
  if [ "$(date +%d)" = "01" ] && [ "$(date +%H)" -ge 3 ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$(date +%Y-%m)" ]; then
    date +%Y-%m > "$STAMP"
    echo "$(date) refresh starting"
    "$HOME/inukshuk-tiles/infra/nas/refresh.sh" && echo "$(date) refresh done" || echo "$(date) refresh FAILED"
  fi
  sleep 3600
done
