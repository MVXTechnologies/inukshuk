#!/usr/bin/env bash
# Print "<latitude> <longitude>" of a Maestro flow's first `setLocation`, or
# exit 1 when it has none.
#
# The runner re-applies it after the flow (poll-overlay.sh): Maestro's mock
# location providers go away with its session, and a map that follows the
# user then snaps back to the runner's own last fix (CI 2026-10-09, run
# 37890668976: the pdf-overlays poll photographed Québec, not the fixture).
set -u
FLOW=${1:?usage: flow-location.sh <flow.yaml>}
awk '
  /^[[:space:]]*-?[[:space:]]*setLocation:/ { inside = 1; lat = ""; lon = ""; next }
  inside && /latitude:/ { lat = $2 }
  inside && /longitude:/ { lon = $2 }
  inside && lat != "" && lon != "" { print lat, lon; found = 1; exit }
  inside && /^[[:space:]]*-/ { inside = 0 }
  END { exit found ? 0 : 1 }
' "$FLOW"
