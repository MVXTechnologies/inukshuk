"""Build record → tile feature (DESIGN.md §2.2), one GeoJSONSeq line each.

Official marks go to layer `geodetic`, OpenStreetMap ones to `geodetic_osm`.
Keys are one or two letters to keep tiles small; the app decodes them in
src/core/geodetic/record.ts. What the card shows as the agency's values —
`gc` (published geographic coordinates), `g1`/`g2` (published grid
coordinates, "system;E;N"), `H`/`H2`/`h` (heights) — are the agency's own
text, never recomputed. `x`/`y` are the display position (doubles), the
geometry only draws.
"""
import json

from catalog import DATUM_INDEX, SOURCE_INDEX, VDATUM_INDEX, is_modern
from common import STATUS_CODE

MONUMENT_LABEL = {
    'disk': 'disk', 'bolt': 'bolt', 'pillar': 'pillar', 'rod': 'rod', 'pipe': 'pipe',
    'stone': 'stone', 'block': 'block', 'cut': 'cut', 'pin': 'pin', 'structure': 'structure',
    'antenna': 'antenna', 'other': 'other',
}


MAX_TILE_ZOOM = 13


def _coord(v):
    return round(float(v), 8)


def _published(text, value):
    """A height as the agency printed it (a string: an MVT number would lose
    trailing zeros, '78.010' vs '78.01'); the float only when no text was kept."""
    if text:
        return str(text).strip()
    return repr(round(float(value), 4))


def props(rec):
    p = {'i': rec['id'], 's': SOURCE_INDEX[rec['src']], 'k': rec['type']}
    if rec['src'] == 'osm':
        if rec.get('name') and rec['name'] != rec['id']:
            p['n'] = rec['name'][:40]
        h = (rec.get('hOrtho') or [None])[0]
        if h:
            p['H'] = _published(h.get('text'), h['value'])
        if rec.get('monument'):
            p['m'] = rec['monument']['code']
            p['mt'] = rec['monument']['text'][:60]
        if rec.get('url'):
            p['w'] = rec['url'][:200]
        p['y'], p['x'] = _coord(rec['lat']), _coord(rec['lng'])
        return p
    code = STATUS_CODE.get(rec['status'], 4)
    if code:
        p['c'] = code
    if not is_modern(rec['datum']):
        p['l'] = 1
    p['y'], p['x'] = _coord(rec['lat']), _coord(rec['lng'])
    p['d'] = DATUM_INDEX[rec['datum']]
    if rec.get('name') and rec['name'] != rec['id']:
        p['n'] = rec['name'][:40]
    heights = [h for h in rec.get('hOrtho') or [] if h.get('datum') in VDATUM_INDEX]
    for n, h in enumerate(heights[:2]):
        suffix = '' if n == 0 else '2'
        p['H' + suffix] = _published(h.get('text'), h['value'])
        p['hd' + suffix] = VDATUM_INDEX[h['datum']]
    if rec.get('hEll') is not None:
        p['h'] = _published(rec.get('hEllText'), rec['hEll'])
    if rec.get('geo'):
        p['gc'] = rec['geo'][:80]
    for n, g in enumerate((rec.get('grids') or [])[:2]):
        p[f'g{n + 1}'] = f"{g['system']};{g['e']};{g['n']}"[:90]
    mon = rec.get('monument')
    if mon:
        p['m'] = mon['code']
        if mon.get('text') and mon['text'].lower() != MONUMENT_LABEL.get(mon['code']):
            p['mt'] = mon['text'][:160]
    if rec.get('lastVisit'):
        p['v'] = rec['lastVisit'][:10]
    acc = rec.get('posAcc')
    if acc is not None and acc >= 1:
        p['p'] = int(round(acc * 10))
    if rec.get('url'):
        # A per-mark datasheet link the source's URL template can't express.
        p['w'] = rec['url'][:200]
    return p


def feature_line(rec):
    """Tiles stop at z13 (MapLibre overzooms; the exact position is in x/y). A
    mark the ladder lets in only at z14 is stored in z13 tiles with `z: 14`,
    and the app's z13 layer skips it — a property filter, never ["zoom"]."""
    p = props(rec)
    if rec['minzoom'] > MAX_TILE_ZOOM:
        p['z'] = rec['minzoom']
    f = {
        'type': 'Feature',
        'tippecanoe': {'minzoom': min(rec['minzoom'], MAX_TILE_ZOOM)},
        'geometry': {'type': 'Point', 'coordinates': [round(rec['lng'], 7), round(rec['lat'], 7)]},
        'properties': p,
    }
    return json.dumps(f, ensure_ascii=False, separators=(',', ':'))
