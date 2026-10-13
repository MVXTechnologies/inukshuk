#!/bin/zsh
# Add the team-photos demo trail (scripts/demo/team-photos-demo.py) and its
# photos to an installed simulator build, next to the library's own trails.
#   usage: seed-team-demo.sh <sim-udid> <fixture-dir>
set -e
P=$1; F=$2
xcrun simctl terminate $P com.inukshuk.app 2>/dev/null || true
D=$(xcrun simctl get_app_container $P com.inukshuk.app data)/Documents
mkdir -p $D/tracks $D/photos
cp $F/tracks/*.gpx $D/tracks/
cp -R $F/photos/ $D/photos/
python3 - "$D" "$F" <<'PY'
import json, sys
D, F = sys.argv[1:]
t = json.load(open(f'{F}/track.json'))
try:
    lib = json.load(open(f'{D}/library.json'))
except Exception:
    lib = {"schemaVersion": 8, "maps": [], "folders": [], "mapVisibilityMode": "type",
           "visibleFolderIds": [], "activeMapId": None, "activeTrackIds": [],
           "customCategories": [], "waypoints": [], "tracks": []}
lib['tracks'] = [x for x in lib.get('tracks', []) if x.get('id') != t['id']] + [t]
json.dump(lib, open(f'{D}/library.json', 'w'))
print('seeded', t['name'], t.get('photoCount'), 'photos')
PY
