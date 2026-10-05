#!/bin/sh
# Monthly trigger for refresh.sh (base map) then peaks.sh (named summits), and
# a weekly geodetic.sh (geodetic points: picks up newly harvested Québec
# datasheets and newly fetched sources, then re-uploads). Runs as a small
# always-on container because user crontabs are disabled on the UGREEN NAS
# (see compose.yaml). Checks hourly. The monthly jobs run once on the 1st from
# 03:00; geodetic runs once per ISO week on Monday from 04:00, never on the
# 1st (so it can't collide with the monthly jobs). Each is remembered in a
# stamp file so a restart the same day doesn't run it twice. The jobs are
# independent: any can fail without stopping the others (each keeps its
# previous archive live).
set -u
apk add --no-cache python3 curl >/dev/null
STAMP="$HOME/inukshuk-tiles/work/.last-refresh"
GEO_STAMP="$HOME/inukshuk-tiles/work/.last-geodetic"
while true; do
  if [ "$(date +%d)" = "01" ] && [ "$(date +%H)" -ge 3 ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$(date +%Y-%m)" ]; then
    date +%Y-%m > "$STAMP"
    echo "$(date) refresh starting"
    "$HOME/inukshuk-tiles/infra/nas/refresh.sh" && echo "$(date) refresh done" || echo "$(date) refresh FAILED"
    echo "$(date) peaks starting"
    "$HOME/inukshuk-tiles/infra/nas/peaks.sh" && echo "$(date) peaks done" || echo "$(date) peaks FAILED"
  fi
  if [ "$(date +%u)" = "1" ] && [ "$(date +%d)" != "01" ] && [ "$(date +%H)" -ge 4 ] \
    && [ "$(cat "$GEO_STAMP" 2>/dev/null)" != "$(date +%G-%V)" ] && [ -x "$HOME/inukshuk-tiles/infra/nas/geodetic.sh" ]; then
    date +%G-%V > "$GEO_STAMP"
    # Both in the background: a slow source (NRCan pages its webapp for ~1.5
    # days) must not hold this loop or the build. The build publishes what is
    # on disk now; this week's fetches land in next week's build. Each source
    # and the build hold their own locks, so overlapping weeks never collide.
    echo "$(date) geodetic fetch + build starting (logs: work/geodetic/logs/weekly-*.log)"
    G="$HOME/inukshuk-tiles/infra/nas/geodetic.sh"
    "$G" fetch >>"$HOME/inukshuk-tiles/work/geodetic/logs/weekly-fetch.log" 2>&1 &
    "$G" build >>"$HOME/inukshuk-tiles/work/geodetic/logs/weekly-build.log" 2>&1 &
  fi
  sleep 3600
done
