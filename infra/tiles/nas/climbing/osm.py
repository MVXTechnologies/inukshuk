"""OpenStreetMap (ODbL) → crag records.

OSM maps climbing in three kinds of element:
- route starts: `climbing=route_bottom` nodes, `climbing=route` nodes or ways
  (a way's first node is its start) — name, grade, length, bolts, position;
- sectors: `climbing=crag` (a wall: node, `natural=cliff` way, or `type=site`
  relation listing its routes), `climbing=boulder`, or a cliff/rock tagged
  `sport=climbing`;
- areas: `climbing=area`, grouping sectors.

Gyms (`sport=climbing` on a sports centre, a building, indoors…) are dropped.
Each route goes to the sector whose relation lists it, else to the nearest
sector within ROUTE_SECTOR_M. A sector is ordered left to right when OSM
gives us a facing or a wall line (order.py). Each area is a crag with its
sectors; each sector outside an area is a crag of its own (merge.py later
folds them into the OpenBeta crag they belong to: Weir's twelve walls).

ODbL hygiene (DESIGN.md §3.2): these records are only ever OSM sectors, with
OSM's credit; no OSM tag is copied onto another source's record.
"""
import re

import grades
import order
from common import STYLE_BITS, clean, fold, haversine_m

ROUTE_SECTOR_M = 150.0
SAME_SECTOR_M = 150.0
AREA_NODE_M = 500.0
DESC_MAX = 280
GYM_LEISURE = {'sports_centre', 'fitness_centre', 'sports_hall', 'fitness_station', 'pitch', 'playground'}
ROCKY = {'cliff', 'rock', 'bare_rock', 'stone', 'peak', 'ridge', 'arete', 'cave_entrance'}
STYLE_TAGS = [
    ('climbing:sport', 'sport'),
    ('climbing:trad', 'trad'),
    ('climbing:toprope', 'tr'),
    ('climbing:boulder', 'boulder'),
    ('climbing:ice', 'ice'),
    ('climbing:mixed', 'mixed'),
    ('climbing:aid', 'aid'),
    ('climbing:alpine', 'alpine'),
]
_NUM = re.compile(r'^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$')


def osm_id(el):
    return f"{el['type'][0]}{el['id']}"


def is_gym(tags):
    return (
        tags.get('leisure') in GYM_LEISURE
        or tags.get('indoor') == 'yes'
        or 'building' in tags
        or 'amenity' in tags
        or 'shop' in tags
        or tags.get('climbing') in ('gym', 'wall', 'indoor')
        or tags.get('climbing:artificial') == 'yes'
    )


def point_of(el):
    if 'lat' in el:
        return el['lat'], el['lon']
    if 'center' in el:
        return el['center']['lat'], el['center']['lon']
    geom = el.get('geometry') or []
    if geom:
        return (
            sum(g['lat'] for g in geom) / len(geom),
            sum(g['lon'] for g in geom) / len(geom),
        )
    return None


def line_of(el):
    geom = el.get('geometry') or []
    return [(g['lat'], g['lon']) for g in geom if g]


def number(v):
    m = _NUM.match(str(v or '').replace(',', '.'))
    return float(m.group(1)) if m else None


def kind_of(tags):
    c = tags.get('climbing')
    if c in ('route_bottom', 'route'):
        return 'route'
    if c == 'area':
        return 'area'
    if c in ('crag', 'boulder'):
        return 'sector'
    if tags.get('sport') == 'climbing' and tags.get('natural') in ROCKY:
        return 'sector'
    return None


def styles_of(tags):
    st = 0
    for key, style in STYLE_TAGS:
        if tags.get(key) in ('yes', 'only', 'excellent', 'good'):
            st |= STYLE_BITS[style]
    return st


def route_record(el):
    tags = el.get('tags') or {}
    if el['type'] == 'way':
        line = line_of(el)
        start = line[0] if line else point_of(el)
    else:
        start = point_of(el)
    if start is None:
        return None
    out = {'id': f"osm:{el['type'][0]}{el['id']}", 'n': clean(tags.get('name'), 120) or 'Unnamed'}
    out.update(grades.from_osm(tags))
    st = styles_of(tags)
    if st:
        out['st'] = st
    length = number(tags.get('climbing:length') or tags.get('length'))
    if length and 0 < length < 2000:
        out['len'] = round(length)
    bolts = number(tags.get('climbing:bolts'))
    if bolts and 0 < bolts < 200:
        out['bolts'] = int(bolts)
    pitches = number(tags.get('climbing:pitches'))
    if pitches and 1 < pitches < 100:
        out['p'] = int(pitches)
    desc = clean(tags.get('description'), DESC_MAX)
    if desc:
        out['d'] = desc
    out['pos'] = [round(start[1], 7), round(start[0], 7)]
    return out


def _merge_elements(raw_elements):
    """One element per (type, id): ways keep their geometry, relations their members."""
    out = {}
    for el in raw_elements:
        key = (el['type'], el['id'])
        prev = out.get(key)
        if prev is None:
            out[key] = el
            continue
        for k in ('geometry', 'members', 'center', 'tags', 'lat', 'lon'):
            if k in el and k not in prev:
                prev[k] = el[k]
    return out


def _crag_attrs(tags):
    a = {}
    rock = clean(tags.get('climbing:rock') or tags.get('rock'), 40)
    if rock:
        a['rock'] = rock
    facing = clean(tags.get('climbing:orientation'), 20)
    if facing:
        a['aspect'] = facing
    height = number(tags.get('climbing:length:max') or tags.get('height') or tags.get('climbing:length'))
    if height and 0 < height < 3000:
        a['height'] = round(height)
    site = clean(tags.get('website') or tags.get('contact:website') or tags.get('url'), 300)
    if site and site.startswith('http') and 'mountainproject.com' not in site:
        a['website'] = site
    declared = number(tags.get('climbing:routes'))
    if declared and 0 < declared < 5000:
        a['declared'] = int(declared)
    acc = tags.get('climbing:access') or tags.get('access')
    if acc in ('no', 'private', 'permit', 'permissive'):
        a['access'] = acc
    for lang in ('fr', 'en'):
        v = clean(tags.get(f'name:{lang}'), 120)
        if v:
            a[f'name_{lang}'] = v
    return a


def normalize(raw_elements, takedowns=None):
    gone = set((takedowns or {}).get('osm') or [])
    els = _merge_elements(raw_elements)
    routes, sectors, areas, cliffs = {}, [], [], {}
    for (typ, eid), el in els.items():
        tags = el.get('tags') or {}
        if f'{typ}/{eid}' in gone:
            continue
        if typ == 'way' and tags.get('natural') == 'cliff' and el.get('geometry'):
            cliffs[eid] = line_of(el)
        if is_gym(tags):
            continue
        kind = kind_of(tags)
        if kind == 'route':
            r = route_record(el)
            if r:
                routes[(typ, eid)] = r
        elif kind in ('sector', 'area'):
            pt = point_of(el)
            if pt is None:
                continue
            item = {
                'key': (typ, eid),
                'el': el,
                'tags': tags,
                'pt': pt,
                'name': clean(tags.get('name'), 120),
                'members': [(m['type'], m['ref']) for m in el.get('members') or []],
                'line': line_of(el) if typ == 'way' else [],
                'routes': [],
            }
            (areas if kind == 'area' else sectors).append(item)

    sectors = _merge_same_sectors(sectors)
    _assign_routes(sectors, routes)
    for s in sectors:
        _order_sector(s, cliffs)

    # Areas take the sectors they list or contain; the rest stand alone.
    taken = set()
    crags = []
    for a in sorted(areas, key=lambda a: a['key'][0] != 'relation'):
        members = set(a['members'])
        mine = []
        for i, s in enumerate(sectors):
            if i in taken:
                continue
            if s['key'] in members or any(k in members for k in s.get('alias_keys', [])):
                mine.append(i)
            elif a['line'] and len(a['line']) > 3 and a['line'][0] == a['line'][-1]:
                if _in_polygon(s['pt'], a['line']):
                    mine.append(i)
            elif a['key'][0] == 'node' and haversine_m(*a['pt'], *s['pt']) <= AREA_NODE_M:
                if a['name'] or s['name']:
                    mine.append(i)
        taken.update(mine)
        secs = [sectors[i] for i in mine]
        rec = _crag_record(a, secs)
        if rec:
            crags.append(rec)
    for i, s in enumerate(sectors):
        if i not in taken:
            rec = _crag_record(s, [s])
            if rec:
                crags.append(rec)
    return crags


def _in_polygon(pt, ring):
    lat, lng = pt
    inside = False
    for i in range(len(ring) - 1):
        (y1, x1), (y2, x2) = ring[i], ring[i + 1]
        if (y1 > lat) != (y2 > lat):
            x = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if x > lng:
                inside = not inside
    return inside


def _merge_same_sectors(sectors):
    """A wall mapped twice (a cliff way + a `type=site` relation of the same
    name, as at Weir) is one sector: relation members + way line."""
    prio = {'relation': 0, 'way': 1, 'node': 2}
    sectors.sort(key=lambda s: prio[s['key'][0]])
    out = []
    for s in sectors:
        twin = None
        if s['name']:
            for o in out:
                if o['name'] and fold(o['name']) == fold(s['name']) and (
                    haversine_m(*o['pt'], *s['pt']) <= SAME_SECTOR_M
                ):
                    twin = o
                    break
        if twin is None:
            s['alias_keys'] = []
            out.append(s)
            continue
        twin['alias_keys'].append(s['key'])
        twin['members'] = twin['members'] + s['members']
        if not twin['line'] and s['line']:
            twin['line'] = s['line']
        for k, v in s['tags'].items():
            twin['tags'].setdefault(k, v)
    return out


def _sector_distance(s, lat, lng):
    if s['line'] and len(s['line']) >= 2:
        return order.line_distance_m(s['line'], lat, lng)
    return haversine_m(lat, lng, *s['pt'])


def _assign_routes(sectors, routes):
    claimed = set()
    for s in sectors:
        for m in s['members']:
            if m in routes and m not in claimed:
                s['routes'].append(routes[m])
                claimed.add(m)
    for key, r in routes.items():
        if key in claimed:
            continue
        lng, lat = r['pos']
        best, best_d = None, ROUTE_SECTOR_M
        for s in sectors:
            if abs(s['pt'][0] - lat) > 0.01 or abs(s['pt'][1] - lng) > 0.02:
                continue
            d = _sector_distance(s, lat, lng)
            if d < best_d:
                best, best_d = s, d
        if best is not None:
            best['routes'].append(r)
            claimed.add(key)


def _wall_line(s, cliffs):
    if s['line'] and s['tags'].get('natural') == 'cliff' and s['line'][0] != s['line'][-1]:
        return s['line']
    for typ, ref in s['members']:
        if typ == 'way' and ref in cliffs:
            return cliffs[ref]
    starts = [(r['pos'][1], r['pos'][0]) for r in s['routes']]
    if not starts:
        return None
    lat = sum(p[0] for p in starts) / len(starts)
    lng = sum(p[1] for p in starts) / len(starts)
    best, best_d = None, order.CLIFF_NEAR_M
    for line in cliffs.values():
        if not line or abs(line[0][0] - lat) > 0.05 or abs(line[0][1] - lng) > 0.08:
            continue
        d = order.line_distance_m(line, lat, lng)
        if d < best_d:
            best, best_d = line, d
    return best


def _order_sector(s, cliffs):
    rs = s['routes']
    s['ordered'] = False
    if len(rs) >= 2:
        starts = [(r['pos'][1], r['pos'][0]) for r in rs]
        idx = order.order_routes(
            starts,
            facing=order.facing_azimuth(s['tags'].get('climbing:orientation')),
            line_ll=_wall_line(s, cliffs),
        )
        if idx is not None:
            s['routes'] = [rs[i] for i in idx]
            s['ordered'] = True
            return
    s['routes'] = sorted(rs, key=lambda r: (r.get('k') or 'z', r.get('x', 99), r['n'].lower()))


def _sector_out(s):
    rs = s['routes']
    if rs:
        lng = sum(r['pos'][0] for r in rs) / len(rs)
        lat = sum(r['pos'][1] for r in rs) / len(rs)
    else:
        lat, lng = s['pt']
    out = {
        'n': s['name'] or 'Unnamed wall',
        'src': 'osm',
        'osm': f"{s['key'][0]}/{s['key'][1]}",
        'pt': [round(lng, 6), round(lat, 6)],
        'ordered': s['ordered'],
        'routes': rs,
    }
    st = styles_of(s['tags'])
    if st and not rs:
        out['st'] = st
    return out


def _crag_record(head, secs):
    secs = [s for s in secs if s['routes']] or [s for s in secs if s['name']]
    if not secs and not head['name']:
        return None
    name = head['name'] or next((s['name'] for s in secs if s['name']), None)
    if not name:
        return None
    lat, lng = head['pt']
    if head['key'][0] != 'node' and secs:
        pts = [s['pt'] for s in secs]
        lat = sum(p[0] for p in pts) / len(pts)
        lng = sum(p[1] for p in pts) / len(pts)
    tags = dict(head['tags'])
    for s in secs:
        for k, v in s['tags'].items():
            tags.setdefault(k, v)
    attrs = _crag_attrs(tags)
    # The crag's height is its tallest wall's, not whichever sector came first.
    heights = [h for h in (_crag_attrs(x['tags']).get('height') for x in [head, *secs]) if h]
    if heights:
        attrs['height'] = max(heights)
    acc = attrs.pop('access', None)
    rec = {
        'uid': f"osm-{head['key'][0][0]}{head['key'][1]}",
        'src': 'osm',
        'name': name,
        'lat': round(lat, 6),
        'lng': round(lng, 6),
        'sectors': sorted((_sector_out(s) for s in secs), key=lambda x: (-len(x['routes']), x['n'])),
        'osm': f"{head['key'][0]}/{head['key'][1]}",
        'alias': [f"osm-{k[0][0]}{k[1]}" for s in secs for k in [s['key'], *s.get('alias_keys', [])]],
        **attrs,
    }
    # Only restrictions are read: a crag is never "open" from OSM's silence
    # (or from `access=yes`, which is often about the road).
    if acc == 'no':
        rec['access'] = {'status': 'closed', 'src': 'osm', 'note': 'access=no in OpenStreetMap'}
    elif acc in ('private', 'permit'):
        rec['access'] = {'status': 'restricted', 'src': 'osm', 'note': f'access={acc} in OpenStreetMap'}
    return rec
