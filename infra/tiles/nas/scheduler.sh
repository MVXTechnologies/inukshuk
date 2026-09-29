#!/bin/sh
# Monthly trigger for refresh.sh (base map) then peaks.sh (named summits), run
# as a small always-on container because user crontabs are disabled on the
# UGREEN NAS (see compose.yaml). Checks hourly; runs once on the 1st of the
# month from 03:00, remembered in a stamp file so a restart the same day
# doesn't run it twice. The two jobs are independent: either can fail without
# stopping the other (each keeps the previous month's archive live).
set -u
apk add --no-cache python3 curl >/dev/null
STAMP="$HOME/inukshuk-tiles/work/.last-refresh"
while true; do
  if [ "$(date +%d)" = "01" ] && [ "$(date +%H)" -ge 3 ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$(date +%Y-%m)" ]; then
    date +%Y-%m > "$STAMP"
    echo "$(date) refresh starting"
    "$HOME/inukshuk-tiles/infra/nas/refresh.sh" && echo "$(date) refresh done" || echo "$(date) refresh FAILED"
    echo "$(date) peaks starting"
    "$HOME/inukshuk-tiles/infra/nas/peaks.sh" && echo "$(date) peaks done" || echo "$(date) peaks FAILED"
  fi
  sleep 3600
done
