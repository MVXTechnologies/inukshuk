"""One crag per place, from the three sources (DESIGN.md §3.3).

1. OSM → OpenBeta: an OSM crag joins the OpenBeta crag it belongs to when its
   name matches the crag's or one of its sectors' (Jaro-Winkler on folded
   names) within MATCH_M, or whatever the name when it lies within NEAR_M of
   the crag or one of its sectors. Weir's twelve OSM walls fold into
   OpenBeta's Weir that way.
2. Sectors, one source each (never a route-by-route mix, which keeps ODbL
   share-alike scoped and avoids twice-listed routes): an OSM sector and an
   OpenBeta sector are the same wall when their names match or half of their
   route names do. OSM wins when it has the left-to-right order, else the
   source with more routes.
3. camptocamp: each waypoint enriches the best crag it matches (approach,
   rock, aspect, link), or stands as a crag of its own (no route list).

Precedence: name OSM > OpenBeta > camptocamp (OSM's is the local spelling);
access FQME (partner, when signed) > the most restrictive open-source status
> unknown. An unknown status is never shown as open.
"""
import math

from common import fold, haversine_m, jaro_winkler, name_key

MATCH_M = 1500.0
NEAR_M = 300.0
NAME_JW = 0.85
SECTOR_JW = 0.88
ROUTE_OVERLAP = 0.5
CELL_DEG = 0.02
ACCESS_RANK = {'banned': 4, 'closed': 3, 'restricted': 2, 'open': 1}


class Grid:
    """Points in ~2 km cells, for neighbour lookups."""

    def __init__(self):
        self.cells = {}

    def _cell(self, lat, lng):
        return (math.floor(lat / CELL_DEG), math.floor(lng / (CELL_DEG / max(0.2, math.cos(math.radians(lat))))))

    def add(self, lat, lng, item):
        self.cells.setdefault(self._cell(lat, lng), []).append(item)

    def near(self, lat, lng, reach=1):
        cy, cx = self._cell(lat, lng)
        for dy in range(-reach, reach + 1):
            for dx in range(-reach, reach + 1):
                yield from self.cells.get((cy + dy, cx + dx), ())


def _points(crag):
    pts = [(crag['lat'], crag['lng'])]
    pts += [(s['pt'][1], s['pt'][0]) for s in crag.get('sectors') or []]
    return pts


def _min_dist(crag, lat, lng):
    return min(haversine_m(lat, lng, a, b) for a, b in _points(crag))


def _name_score(a_name, b):
    """How well a name matches crag b: its own name, else one of its sectors'."""
    ka = name_key(a_name)
    best = jaro_winkler(ka, name_key(b['name']))
    kind = 'crag'
    for s in b.get('sectors') or []:
        jw = jaro_winkler(ka, name_key(s['n']))
        if jw > best:
            best, kind = jw, 'sector'
    return best, kind


def _route_names(sector):
    return {fold(r['n']) for r in sector['routes'] if r['n'] != 'Unnamed'}


def same_sector(a, b):
    if a['n'] and b['n'] and jaro_winkler(name_key(a['n']), name_key(b['n'])) >= SECTOR_JW:
        return True
    na, nb = _route_names(a), _route_names(b)
    if not na or not nb:
        return False
    return len(na & nb) / min(len(na), len(nb)) >= ROUTE_OVERLAP


def merge_sectors(ob_sectors, osm_sectors):
    """One source per sector; returns the kept sectors."""
    kept_osm = list(osm_sectors)
    out = []
    for sb in ob_sectors:
        twins = [so for so in kept_osm if same_sector(so, sb)]
        if not twins:
            out.append(sb)
            continue
        osm_routes = sum(len(so['routes']) for so in twins)
        if any(so['ordered'] for so in twins) or osm_routes >= len(sb['routes']):
            continue  # OSM's twins stay, the OpenBeta sector goes
        for so in twins:
            kept_osm.remove(so)
        out.append(sb)
    return out + kept_osm


def _restrictive(*accesses):
    best = None
    for a in accesses:
        if a and (best is None or ACCESS_RANK.get(a['status'], 0) > ACCESS_RANK.get(best['status'], 0)):
            best = a
    return best


def absorb_osm(ob_crags, osm_crags):
    """Fold OSM crags into the OpenBeta crag they belong to; returns the OSM crags left."""
    grid = Grid()
    for c in ob_crags:
        for lat, lng in _points(c):
            grid.add(lat, lng, c)
    joined = {}
    left = []
    for o in osm_crags:
        best, best_score = None, 0.0
        seen = set()
        for c in grid.near(o['lat'], o['lng']):
            if id(c) in seen:
                continue
            seen.add(id(c))
            d = _min_dist(c, o['lat'], o['lng'])
            if d > MATCH_M:
                continue
            jw, _kind = _name_score(o['name'], c)
            if jw < NAME_JW:
                # Sectors of the OSM crag may carry the OpenBeta sector names.
                for s in o['sectors']:
                    jw = max(jw, _name_score(s['n'], c)[0])
            score = jw if jw >= NAME_JW else (0.5 if d <= NEAR_M else 0.0)
            score -= d / 1e6  # ties go to the nearer crag
            if score > best_score:
                best, best_score = c, score
        if best is None:
            left.append(o)
        else:
            joined.setdefault(id(best), (best, []))[1].append(o)
    for c, osms in joined.values():
        osm_sectors = [s for o in osms for s in o['sectors']]
        sectors = merge_sectors(c['sectors'], osm_sectors)
        # A wall OSM names but lists no route on (Weir's "Agagio" twin of
        # Adagio) adds nothing next to walls with routes.
        sectors = [s for s in sectors if s['routes']] or sectors
        c['sectors'] = sorted(sectors, key=lambda s: (-len(s['routes']), s['n']))
        c.setdefault('alias', [])
        for o in osms:
            c['alias'] += [o['uid'], *o.get('alias', [])]
            for k in ('rock', 'aspect', 'website', 'declared'):
                if k in o and k not in c:
                    c[k] = o[k]
            if o.get('height'):
                c['height'] = max(c.get('height') or 0, o['height'])
        # One OSM crag of the crag's own name: its local spelling wins (Val-Bélair).
        same = [o for o in osms if jaro_winkler(name_key(o['name']), name_key(c['name'])) >= NAME_JW]
        if len(same) == 1:
            c['name'] = same[0]['name']
            for k in ('name_fr', 'name_en'):
                if k in same[0]:
                    c[k] = same[0][k]
        c['access'] = _restrictive(c.get('access'), *(o.get('access') for o in osms))
        if c['access'] is None:
            c.pop('access')
        c['osm'] = [o['osm'] for o in osms]
    return left


def attach_c2c(crags, c2c_records):
    """Enrich the best match of each camptocamp waypoint; returns the unmatched."""
    grid = Grid()
    for c in crags:
        grid.add(c['lat'], c['lng'], c)
    left = []
    for w in c2c_records:
        best, best_score = None, 0.0
        for c in grid.near(w['lat'], w['lng']):
            if 'c2c' in c:
                continue
            d = haversine_m(c['lat'], c['lng'], w['lat'], w['lng'])
            if d > MATCH_M:
                continue
            jw, _ = _name_score(w['name'], c)
            score = jw if jw >= NAME_JW else (0.5 if d <= NEAR_M else 0.0)
            score -= d / 1e6
            if score > best_score:
                best, best_score = c, score
        if best is None:
            left.append(w)
            continue
        best['c2c'] = w['url']
        best.setdefault('alias', []).append(w['uid'])
        for k in ('rock', 'aspect', 'height'):
            if k in w and k not in best:
                best[k] = w[k]
        if 'approach' in w:
            best['approach'] = w['approach']
        if 'declared' in w and not any(s['routes'] for s in best.get('sectors') or []):
            best['declared'] = w['declared']
    return left


def c2c_crag(w):
    rec = {k: v for k, v in w.items() if k not in ('url',)}
    rec['sectors'] = []
    rec['c2c'] = w['url']
    return rec


def assemble(ob_crags, osm_crags, c2c_records, takedown_uids=()):
    gone = set(takedown_uids)
    ob_crags = [c for c in ob_crags if c['uid'] not in gone]
    osm_crags = [c for c in osm_crags if c['uid'] not in gone]
    c2c_records = [w for w in c2c_records if w['uid'] not in gone]
    osm_left = absorb_osm(ob_crags, osm_crags)
    for o in osm_left:
        o['osm'] = [o['osm']]
    crags = ob_crags + osm_left
    c2c_left = attach_c2c(crags, c2c_records)
    crags += [c2c_crag(w) for w in c2c_left]
    return [c for c in crags if not (set(c.get('alias') or []) & gone)]
