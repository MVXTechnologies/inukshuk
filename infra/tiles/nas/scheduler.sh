#!/bin/sh
# Monthly trigger for refresh.sh (base map) then peaks.sh (named summits), a
# weekly geodetic.sh (geodetic points: picks up newly harvested Québec
# datasheets and newly fetched sources, then re-uploads), and a monthly
# climbing.sh (climbing crags, third Thursday; see below). Runs as a small
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
CLIMB_STAMP="$HOME/inukshuk-tiles/work/.last-climbing"
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
  # Climbing crags (climbing.sh): monthly, on the third Thursday (the 15th–21st),
  # from 03:00 — never the 1st (base map + peaks), never a Monday (geodetic's
  # weekly start), and it waits an hour at a time while a geodetic build holds
  # its lock (that build wants most of the NAS's RAM).
  if [ "$(date +%u)" = "4" ] && [ "$(date +%d)" -ge 15 ] && [ "$(date +%d)" -le 21 ] && [ "$(date +%H)" -ge 3 ] \
    && [ "$(cat "$CLIMB_STAMP" 2>/dev/null)" != "$(date +%Y-%m)" ] && [ -x "$HOME/inukshuk-tiles/infra/nas/climbing.sh" ] \
    && [ ! -d "$HOME/inukshuk-tiles/work/geodetic/.build.lock" ]; then
    date +%Y-%m > "$CLIMB_STAMP"
    echo "$(date) climbing starting (log: work/climbing/logs/monthly.log)"
    "$HOME/inukshuk-tiles/infra/nas/climbing.sh" >>"$HOME/inukshuk-tiles/work/climbing/logs/monthly.log" 2>&1 \
      && echo "$(date) climbing done" || echo "$(date) climbing FAILED"
  fi
  sleep 3600
done
