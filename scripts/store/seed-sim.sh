#!/bin/zsh
# Load the demo runs from gen-demo-runs.py into an installed simulator build
# (store screenshots, visual QA). Replaces the library's trails, keeps its
# maps, and resets the display mode to Normal.
#   usage: seed-sim.sh <sim-udid> <fixtures-dir> [light|dark]
set -e
P=$1; F=$2; THEME=${3:-light}
xcrun simctl terminate $P com.inukshuk.app 2>/dev/null || true
D=$(xcrun simctl get_app_container $P com.inukshuk.app data)/Documents
mkdir -p $D/tracks
rm -f $D/tracks/*.gpx $D/recorder-checkpoint.json
cp $F/tracks/*.gpx $D/tracks/
python3 - "$D" "$F" "$THEME" <<'PY'
import json, sys
D, F, theme = sys.argv[1:]
tracks = json.load(open(f'{F}/tracks.json'))
t = tracks[0]; d = t['stats']['distanceM']
t['notes'] = [
    {"id": "nA1", "distanceM": round(d * 0.18), "text": "Fog lifting off the river — worth the early start", "createdAt": t['startedAt'] + 600000},
    {"id": "nA2", "distanceM": round(d * 0.62), "text": "Water fountain open at the Martello tower", "createdAt": t['startedAt'] + 1200000},
]
try:
    lib = json.load(open(f'{D}/library.json'))
except Exception:
    lib = {"schemaVersion": 8, "maps": [], "folders": [], "mapVisibilityMode": "type", "visibleFolderIds": [],
           "activeMapId": None, "activeTrackIds": [], "customCategories": [], "waypoints": []}
lib['tracks'] = tracks
json.dump(lib, open(f'{D}/library.json', 'w'))
try:
    s = json.load(open(f'{D}/settings.json'))
except Exception:
    s = {"schemaVersion": 3}
s.update({"displayCondition": "normal", "autoNightAtSunset": False, "showHeatmap": True, "themeMode": theme,
          "lastKnownPosition": {"latitude": 46.8030, "longitude": -71.2170}, "lastActivityCategory": "bike"})
json.dump(s, open(f'{D}/settings.json', 'w'))
PY
echo "seeded $(ls $F/tracks | wc -l | tr -d ' ') trails"
