"""OpenStreetMap climbing features (ODbL), fetched like peaks.sh: one Overpass
query per pieces.json bbox, split in four when a box is too big, through a
MIRROR (overpass-api.de blocks the NAS): OVERPASS_URL, default
overpass.private.coffee.

Per box we keep:
- every node / way / relation tagged `climbing=*` or `sport=climbing`
  (gyms are dropped later, in osm.py);
- ways with their geometry (a sector mapped as a `natural=cliff` line gives the
  wall's direction), relations with their members (a `type=site` sector lists
  its route starts);
- `natural=cliff` lines within 40 m of a route start, also with geometry: the
  wall line that orders the routes left to right (order.py).
"""
import json
import os
import sys

from common import log, resumable

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from peaks_geojson import QUERY_MAXSIZE, QUERY_TIMEOUT_S, overpass  # noqa: E402

DEFAULT_ENDPOINT = 'https://overpass.private.coffee/api/interpreter'
CLIFF_AROUND_M = 40


def query_for(bbox):
    w, s, e, n = bbox
    b = f'({s},{w},{n},{e})'
    return (
        f'[out:json][timeout:{QUERY_TIMEOUT_S}][maxsize:{QUERY_MAXSIZE}];'
        f'(node["climbing"]{b};node["sport"="climbing"]{b};)->.n;'
        '.n out qt;'
        f'(way["climbing"]{b};way["sport"="climbing"]{b};)->.w;'
        '.w out tags geom qt;'
        f'(relation["climbing"]{b};relation["sport"="climbing"]{b};)->.r;'
        '.r out body center qt;'
        'node.n["climbing"="route_bottom"]->.rb;'
        f'way(around.rb:{CLIFF_AROUND_M})["natural"="cliff"]->.cl;'
        '(.cl; - .w;)->.cl2;'
        '.cl2 out tags geom qt;'
    )


def fetch(raw_dir, pieces_path):
    endpoint = os.environ.get('OVERPASS_URL') or DEFAULT_ENDPOINT
    os.makedirs(raw_dir, exist_ok=True)
    pieces = json.load(open(pieces_path))['pieces']
    total = 0
    for piece in pieces:
        path = os.path.join(raw_dir, f"{piece['name']}.json")
        if resumable(path):
            continue
        log(f"osm: {piece['name']} {piece['bbox']} via {endpoint}")
        elements = overpass(piece['bbox'], endpoint, log, query_for)
        with open(path + '.tmp', 'w', encoding='utf-8') as f:
            json.dump({'elements': elements}, f)
        os.replace(path + '.tmp', path)
        total += len(elements)
        log(f'osm:   {len(elements)} elements')
    log(f'osm: {total} elements in all')
