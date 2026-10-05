"""OpenStreetMap man_made=survey_point — the gap filler (SOURCES.md #23).

ODbL: OSM survivors go to their own tile layer (`geodetic_osm`) with their own
credit, and no OSM tag is ever copied onto an official record (DESIGN.md §4.3).
Fetched like peaks.sh: one Overpass query per pieces.json bbox, through a
MIRROR (overpass-api.de blocks the NAS): OVERPASS_URL, default
overpass.private.coffee.
"""
import json
import os
import sys

from common import log, norm_id, record, resumable

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from peaks_geojson import QUERY_MAXSIZE, QUERY_TIMEOUT_S, overpass  # noqa: E402

SRC = 'osm'
DEFAULT_ENDPOINT = 'https://overpass.private.coffee/api/interpreter'
PURPOSE = {'horizontal': 'h', 'vertical': 'v', 'both': '3d', 'gravity': 'u'}
STRUCTURE = {
    'pillar': 'pillar', 'beacon': 'pillar', 'medallion': 'disk', 'plate': 'disk',
    'bolt': 'bolt', 'pin': 'pin', 'rod': 'rod', 'mark': 'cut', 'cross': 'cut',
    'block': 'block', 'stone': 'stone', 'cairn': 'stone', 'pipe': 'pipe',
}


def query_for(bbox):
    w, s, e, n = bbox
    return (
        f'[out:json][timeout:{QUERY_TIMEOUT_S}][maxsize:{QUERY_MAXSIZE}];'
        f'node["man_made"="survey_point"]({s},{w},{n},{e});'
        'out qt;'
    )


def fetch(raw_dir, pieces_path):
    endpoint = os.environ.get('OVERPASS_URL') or DEFAULT_ENDPOINT
    os.makedirs(raw_dir, exist_ok=True)
    pieces = json.load(open(pieces_path))['pieces']
    for piece in pieces:
        path = os.path.join(raw_dir, f"{piece['name']}.json")
        if resumable(path):
            continue
        log(f"{SRC}: {piece['name']} {piece['bbox']} via {endpoint}")
        elements = overpass(piece['bbox'], endpoint, log, query_for)
        with open(path + '.tmp', 'w', encoding='utf-8') as f:
            json.dump({'elements': elements}, f)
        os.replace(path + '.tmp', path)
        log(f'{SRC}:   {len(elements)} survey points')


def _ele(v):
    try:
        return round(float(str(v).replace(',', '.').replace('m', '').strip()), 3)
    except (TypeError, ValueError):
        return None


def normalize(raw_dir):
    seen = set()
    for name in sorted(os.listdir(raw_dir)):
        if not name.endswith('.json'):
            continue
        for el in json.load(open(os.path.join(raw_dir, name), encoding='utf-8')).get('elements', []):
            if el.get('type') != 'node' or el['id'] in seen:
                continue
            seen.add(el['id'])
            t = el.get('tags') or {}
            if t.get('disused') == 'yes' or t.get('survey_point:status') in ('destroyed', 'missing'):
                continue
            ref, label = (t.get('ref') or '').strip(), (t.get('name') or '').strip()
            structure = (t.get('survey_point:structure') or '').lower()
            ele = _ele(t.get('ele'))
            aliases = [a for a in (ref, label) if a]
            # IDs embedded in a datasheet URL also identify the official twin.
            for k in ('website', 'url'):
                u = t.get(k) or ''
                tail = u.rstrip('/').rsplit('/', 1)[-1].split('=')[-1].split('.')[0]
                if 3 <= len(norm_id(tail)) <= 12:
                    aliases.append(tail)
            yield record(
                SRC, el['id'], el['lat'], el['lon'],
                PURPOSE.get((t.get('survey_point:purpose') or '').lower(), 'u'), 'wgs84',
                name=ref or label or None,
                aliases=aliases,
                hOrtho=[{'value': ele, 'datum': None}] if ele is not None else [],
                monument={'code': STRUCTURE.get(structure, 'other'), 'text': structure} if structure else None,
                url=t.get('website') or t.get('url') or None,
            )
