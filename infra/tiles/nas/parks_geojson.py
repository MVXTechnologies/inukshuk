#!/usr/bin/env python3
"""National parks and protected areas for the base map's `parks` tiles (see parks.sh).

    parks_geojson.py fetch PIECES_JSON OUT_DIR                 # Overpass → OUT_DIR/<piece>.<tier>.json
    parks_geojson.py convert OUT_DIR AREAS.geojsonl LABELS.geojsonl
                                                               # → GeoJSONSeq; prints "<national> <labels>"

Why our own tiles: Protomaps files protected land under four kinds
(`national_park`, `nature_reserve`, `protected_area`, `park`) by rules that
miss the OSM tag that says it outright. Measured on the served tiles
(2026-10): of 26 well-known parks, 9 are `national_park`, 8 `nature_reserve`
(Yellowstone, Yosemite, Kruger, Serengeti), 6 plain `park` — the kind of a
city square — with a name only from z12–13 (Jacques-Cartier, Grands-Jardins,
Algonquin, the Swiss National Park, Triglav, Daisetsuzan), and 2 have no
polygon at all (Lake District, Adirondack). OSM itself is clear:
boundary=national_park.

Two tiers, two Overpass queries per pieces.json bbox:

- NATIONAL — boundary=national_park, or boundary=protected_area with
  protect_class=2 (IUCN II) — fetched WITH geometry. Each becomes a polygon in
  the `parks` layer (the app's boundary line and inner band) and a point in
  `park_labels`, placed inside its largest part, as far from the edge as a
  coarse search finds.
- RESERVE — every other named boundary=protected_area of a nature class
  (PROTECT_CLASSES) and leisure=nature_reserve — fetched as tags + bounds
  only (their geometry would be gigabytes; Protomaps' polygons draw their
  boundary). Each becomes a point in `park_labels`, at the centre of its
  bounds.

Every feature carries `name` (+ `name:en` / `name:fr` when they differ),
`class` (national | reserve) and `rank`: the zoom its area earns on
AREA_LADDER, reserves RESERVE_DEMOTION zooms later. A label is in the tiles
from its rank; a polygon AREA_LEAD zooms earlier, so the outline of a park
arrives before its name.

Overpass etiquette and the retry/split machinery are peaks_geojson.py's.
Standard library only (the NAS has python3, nothing else is installed).
"""
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from peaks_geojson import (  # noqa: E402
    DEFAULT_ENDPOINT,
    QUERY_MAXSIZE,
    QUERY_TIMEOUT_S,
    log,
    overpass,
)

# (minimum area in km², rank) — the first row an area reaches wins. z5 is a
# whole-country view: Banff (6 641 km²), Yellowstone (8 983), Kruger (19 485).
# Jacques-Cartier (670 km²) is ~60 px wide at z7, about the size of its name.
AREA_LADDER = [
    (20000, 4),
    (5000, 5),
    (1500, 6),
    (400, 7),
    (100, 8),
    (25, 9),
    (6, 10),
]
SMALL_RANK = 11
# A reserve of the same size is named this many zooms after a national park.
RESERVE_DEMOTION = 2
MIN_ZOOM = 4  # tippecanoe -Z
MAX_ZOOM = 12  # tippecanoe -z: the last rank, so nothing is ever left out
# A polygon is in the tiles this many zooms before its label's rank.
AREA_LEAD = 2

# OSM protect_class values that mean nature (IUCN Ia–VI, plus 7: protected by
# local rule — Québec's ZECs). Left out: 11–19 resources, 21–29 heritage,
# political and military areas, 97–99 international labels (Natura 2000 alone
# is ~27 000 sites over land that carries no boundary on the ground).
PROTECT_CLASSES = {'1', '1a', '1b', '2', '3', '4', '5', '6', '7'}

# How much of its bounding box a reserve fills, on average (its area is only
# estimated: no geometry is fetched for the reserve tier).
BBOX_FILL = 0.6
KM_PER_DEG = 111.32
# Label search: vertices kept of the ring, and grid cells per side.
LABEL_RING_POINTS = 100
LABEL_GRID = 12


def _filters(tags, bbox):
    w, s, e, n = bbox
    box = f'({s},{w},{n},{e})'
    return ''.join(f'{kind}{tags}{box};' for kind in ('relation', 'way'))


def national_query(bbox):
    """Overpass QL: the national tier in a [w, s, e, n] bbox, with geometry."""
    return (
        f'[out:json][timeout:{QUERY_TIMEOUT_S}][maxsize:{QUERY_MAXSIZE}];('
        + _filters('["boundary"="national_park"]["name"]', bbox)
        + _filters('["boundary"="protected_area"]["protect_class"="2"]["name"]', bbox)
        + ');out geom qt;'
    )


def reserve_query(bbox):
    """Overpass QL: every named protected area in a bbox — tags and bounds.

    `out` takes ONE geometry mode: asking for `center bb` returns the bounds
    alone (measured 2026-10-02), so the label point is derived from them.
    """
    return (
        f'[out:json][timeout:{QUERY_TIMEOUT_S}][maxsize:{QUERY_MAXSIZE}];('
        + _filters('["boundary"="protected_area"]["name"]', bbox)
        + _filters('["leisure"="nature_reserve"]["name"]', bbox)
        + ');out tags bb qt;'
    )


TIERS = (('national', national_query), ('reserve', reserve_query))


def classify(tags):
    """'national', 'reserve' or None (unnamed, or not protected nature)."""
    if not (tags.get('name') or '').strip():
        return None
    boundary = tags.get('boundary')
    protect_class = (tags.get('protect_class') or '').strip().lower()
    if boundary == 'national_park':
        return 'national'
    if boundary == 'protected_area':
        if protect_class == '2':
            return 'national'
        if not protect_class or protect_class in PROTECT_CLASSES:
            return 'reserve'
        return None
    if tags.get('leisure') == 'nature_reserve':
        return 'reserve'
    return None


def rank_for(area_km2, tier):
    """The zoom an area's name is due at (see AREA_LADDER)."""
    rank = next((z for floor, z in AREA_LADDER if area_km2 >= floor), SMALL_RANK)
    if tier != 'national':
        rank += RESERVE_DEMOTION
    return max(MIN_ZOOM, min(MAX_ZOOM, rank))


def ring_area_km2(ring):
    """Area of a closed [(lon, lat), …] ring: shoelace on a local equal-area plane."""
    if len(ring) < 4:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = math.cos(math.radians(lat0))
    total = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        total += x1 * k * y2 - x2 * k * y1
    return abs(total) / 2 * KM_PER_DEG * KM_PER_DEG


def bounds_area_km2(bounds):
    """The estimated area of an element known only by its Overpass `bounds`."""
    h = max(0.0, bounds['maxlat'] - bounds['minlat'])
    w = max(0.0, bounds['maxlon'] - bounds['minlon'])
    k = math.cos(math.radians((bounds['maxlat'] + bounds['minlat']) / 2))
    return w * k * h * KM_PER_DEG * KM_PER_DEG * BBOX_FILL


def _bounds_centre(bounds):
    return (
        (bounds['minlon'] + bounds['maxlon']) / 2,
        (bounds['minlat'] + bounds['maxlat']) / 2,
    )


def _line(geometry):
    return [(p['lon'], p['lat']) for p in geometry or [] if p]


def assemble(lines):
    """Stitch way geometries end to end into closed rings; open chains are dropped.

    A boundary relation lists its ways in no order and in either direction;
    ways of one ring share end nodes, so their end coordinates match exactly.
    """
    rings = []
    open_lines = []
    for line in lines:
        if len(line) >= 4 and line[0] == line[-1]:
            rings.append(line)
        elif len(line) >= 2:
            open_lines.append(line)
    ends = {}
    for i, line in enumerate(open_lines):
        ends.setdefault(line[0], []).append(i)
        ends.setdefault(line[-1], []).append(i)
    used = [False] * len(open_lines)
    for i, first in enumerate(open_lines):
        if used[i]:
            continue
        used[i] = True
        chain = list(first)
        while chain[0] != chain[-1]:
            nxt = next((j for j in ends.get(chain[-1], ()) if not used[j]), None)
            if nxt is None:
                break
            used[nxt] = True
            piece = open_lines[nxt]
            chain.extend(piece[1:] if piece[0] == chain[-1] else piece[-2::-1])
        if len(chain) >= 4 and chain[0] == chain[-1]:
            rings.append(chain)
    return rings


def rings_of(element):
    """An Overpass `out geom` way or relation → (outer rings, inner rings)."""
    if element.get('type') == 'way':
        return assemble([_line(element.get('geometry'))]), []
    outer, inner = [], []
    for member in element.get('members') or []:
        if member.get('type') != 'way':
            continue
        line = _line(member.get('geometry'))
        (inner if member.get('role') == 'inner' else outer).append(line)
    return assemble(outer), assemble(inner)


def inside(point, ring):
    """Even-odd point-in-ring test."""
    x, y = point
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def _edge_distance2(x, y, ring):
    best = float('inf')
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        dx, dy = x2 - x1, y2 - y1
        length2 = dx * dx + dy * dy
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / length2))
        px, py = x1 + t * dx - x, y1 + t * dy - y
        best = min(best, px * px + py * py)
    return best


def label_point(ring):
    """A point well inside a ring: the grid point farthest from its edge.

    A centroid can fall outside a crescent-shaped park (or in the fjord that
    splits it). This is a coarse pole of inaccessibility: a LABEL_GRID² search
    over the bounding box against a thinned copy of the ring, then one finer
    pass around the winner. Holes are ignored (a name over a park's lake is
    fine). Falls back to the bounding-box centre for a degenerate ring.
    """
    step = max(1, (len(ring) - 1) // LABEL_RING_POINTS)
    thin = ring[:-1:step] + [ring[0]]
    lat0 = sum(p[1] for p in thin) / len(thin)
    k = math.cos(math.radians(lat0)) or 1e-9
    flat = [(x * k, y) for x, y in thin]
    xs, ys = [p[0] for p in flat], [p[1] for p in flat]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    mid_x, mid_y = (x0 + x1) / 2, (y0 + y1) / 2
    best, best_score = None, None

    def search(cx, cy, half_w, half_h, cells):
        nonlocal best, best_score
        for i in range(cells):
            for j in range(cells):
                x = cx - half_w + (i + 0.5) * 2 * half_w / cells
                y = cy - half_h + (j + 0.5) * 2 * half_h / cells
                if not inside((x, y), flat):
                    continue
                # Farthest from the edge; among equals (a long park), the most central.
                score = (
                    round(_edge_distance2(x, y, flat), 12),
                    -((x - mid_x) ** 2 + (y - mid_y) ** 2),
                )
                if best_score is None or score > best_score:
                    best, best_score = (x, y), score

    search(mid_x, mid_y, (x1 - x0) / 2, (y1 - y0) / 2, LABEL_GRID)
    if best is None:
        return (mid_x / k, mid_y)
    search(best[0], best[1], (x1 - x0) / LABEL_GRID, (y1 - y0) / LABEL_GRID, 6)
    return (best[0] / k, best[1])


def _names(tags):
    name = tags['name'].strip()
    props = {'name': name}
    for key in ('name:en', 'name:fr'):
        value = (tags.get(key) or '').strip()
        if value and value != name:
            props[key] = value
    return props


def _point(lon, lat, props, minzoom):
    return {
        'type': 'Feature',
        'tippecanoe': {'minzoom': minzoom},
        'properties': props,
        'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]},
    }


def _round(ring):
    return [[round(x, 6), round(y, 6)] for x, y in ring]


def national_features(element):
    """An `out geom` element of the national tier → (polygon | None, label | None).

    A relation whose ways do not close gives no polygon; it keeps a label at
    the centre of its bounds when Overpass sent them.
    """
    tags = element.get('tags') or {}
    if classify(tags) != 'national':
        return None, None
    outers, inners = rings_of(element)
    names = _names(tags)
    if not outers:
        bounds = element.get('bounds')
        if not bounds:
            return None, None
        rank = rank_for(bounds_area_km2(bounds), 'national')
        props = {**names, 'class': 'national', 'rank': rank}
        return None, _point(*_bounds_centre(bounds), props, rank)
    outers.sort(key=ring_area_km2, reverse=True)
    area = sum(ring_area_km2(r) for r in outers) - sum(ring_area_km2(r) for r in inners)
    rank = rank_for(max(area, 0.0), 'national')
    # Each hole goes to the outer ring that contains it.
    polygons = [[_round(r)] for r in outers]
    for hole in inners:
        home = next((i for i, r in enumerate(outers) if inside(hole[0], r)), None)
        if home is not None:
            polygons[home].append(_round(hole))
    props = {**names, 'class': 'national', 'rank': rank}
    polygon = {
        'type': 'Feature',
        'tippecanoe': {'minzoom': max(MIN_ZOOM, rank - AREA_LEAD)},
        'properties': props,
        'geometry': {'type': 'MultiPolygon', 'coordinates': polygons},
    }
    return polygon, _point(*label_point(outers[0]), props, rank)


def reserve_label(element):
    """An `out tags bb` element of the reserve tier → a label point, or None."""
    tags = element.get('tags') or {}
    if classify(tags) != 'reserve':
        return None
    bounds = element.get('bounds')
    if not bounds:
        return None
    rank = rank_for(bounds_area_km2(bounds), 'reserve')
    props = {**_names(tags), 'class': 'reserve', 'rank': rank}
    return _point(*_bounds_centre(bounds), props, rank)


def fetch(pieces_path, out_dir):
    endpoint = os.environ.get('OVERPASS_URL') or DEFAULT_ENDPOINT
    os.makedirs(out_dir, exist_ok=True)
    with open(pieces_path) as f:
        pieces = json.load(f)['pieces']
    for piece in pieces:
        for tier, query in TIERS:
            path = os.path.join(out_dir, f"{piece['name']}.{tier}.json")
            if os.path.exists(path):  # resumable within a run (parks.sh clears the dir first)
                log(f"{piece['name']} {tier}: already fetched")
                continue
            log(f"{time.strftime('%c')} {piece['name']} {tier} {piece['bbox']}")
            elements = overpass(piece['bbox'], endpoint, log, query)
            with open(path + '.tmp', 'w', encoding='utf-8') as f:
                json.dump({'elements': elements}, f)
            os.replace(path + '.tmp', path)
            log(f'  {len(elements)} elements')


def _elements(in_dir, tier):
    """Every element of a tier's files, once (pieces and split boxes overlap)."""
    seen = set()
    for name in sorted(os.listdir(in_dir)):
        if not name.endswith(f'.{tier}.json'):
            continue
        with open(os.path.join(in_dir, name), encoding='utf-8') as f:
            elements = json.load(f).get('elements', [])
        for element in elements:
            key = (element.get('type'), element.get('id'))
            if key in seen:
                continue
            seen.add(key)
            yield key, element


def convert(in_dir, areas_path, labels_path):
    """Write the two GeoJSONSeq files; returns (national polygons, labels)."""
    dump = lambda feat: json.dumps(feat, ensure_ascii=False, separators=(',', ':')) + '\n'
    national, labels, unclosed = set(), 0, 0
    polygons = 0
    with open(areas_path, 'w', encoding='utf-8') as areas, open(
        labels_path, 'w', encoding='utf-8'
    ) as points:
        for key, element in _elements(in_dir, 'national'):
            polygon, label = national_features(element)
            if polygon is None and label is None:
                continue
            national.add(key)
            if polygon is None:
                unclosed += 1
            else:
                areas.write(dump(polygon))
                polygons += 1
            points.write(dump(label))
            labels += 1
        placed = set()
        for key, element in _elements(in_dir, 'reserve'):
            if key in national:
                continue  # the reserve query also returns the national tier
            label = reserve_label(element)
            if label is None:
                continue
            # OSM often holds one reserve twice (a way and a relation of the
            # same outline): same name, same bounds — one label.
            spot = (label['properties']['name'], *label['geometry']['coordinates'])
            if spot in placed:
                continue
            placed.add(spot)
            points.write(dump(label))
            labels += 1
    if unclosed:
        log(f'{unclosed} national areas with no closed ring (label only)')
    return polygons, labels


def main(argv):
    if len(argv) == 4 and argv[1] == 'fetch':
        fetch(argv[2], argv[3])
        return 0
    if len(argv) == 5 and argv[1] == 'convert':
        print(*convert(argv[2], argv[3], argv[4]))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
