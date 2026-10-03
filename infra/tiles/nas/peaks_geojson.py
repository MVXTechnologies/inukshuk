#!/usr/bin/env python3
"""Named summits for the base map's `peaks` layer (see peaks.sh).

    peaks_geojson.py fetch PIECES_JSON OUT_DIR     # Overpass → OUT_DIR/<piece>.json
    peaks_geojson.py convert OUT_DIR OUT.geojsonl  # → GeoJSONSeq for tippecanoe; prints the count

Protomaps only puts peaks in its `pois` layer from z13, so a 4000 m summit is
unnamed at the zooms where you'd plan a trip. This builds our own worldwide
tileset from OpenStreetMap: every node tagged natural=peak|volcano with a name.

Each feature carries `name` (+ `name:en` / `name:fr` when they differ), `ele`
(integer metres, when the OSM `ele` tag parses), `kind` (peak|volcano) and
`rank`, the zoom ELEVATION_LADDER gives it — held back where summits crowd
(see "Density" below) — so the big summits show from z5 and smaller ones join
as you zoom in. Its `tippecanoe.minzoom` is PEAK_MAX_LEAD
zooms before the rank, so the app can draw summits earlier (#461). Local prominence would rank better than
raw height, but OSM rarely has it; when the `prominence` tag is there it
promotes the peak (PROMINENCE_PROMOTION).

Overpass etiquette (https://dev.overpass-api.de/overpass-doc/en/preface/commons.html):
one query at a time, a descriptive User-Agent, a pause between queries,
exponential backoff on 429/504, and a bbox that is split into four (then
again, up to MAX_SPLIT_DEPTH) when a piece is too big for one answer.
Standard library only (the NAS has python3, nothing else is installed).
"""
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = 'inukshuk-tiles/1.0 (+https://inukshuk.mvxtechnologies.com)'
DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter'
# Modest on purpose: public Overpass instances refuse (HTTP 504) a query
# that asks to reserve 900 s / 1 GiB before running it — even over a tiny
# bbox (measured 2026-09-29). Big pieces are split in four on failure
# instead, so a small reservation always wins.
QUERY_TIMEOUT_S = 180
QUERY_MAXSIZE = 256 * 1024 * 1024
PAUSE_S = float(os.environ.get('OVERPASS_PAUSE_S', '30'))
RETRIES = 4
MAX_SPLIT_DEPTH = 4

# (minimum elevation in metres, minzoom) — the first row a peak reaches wins.
# z5 is a whole-country view: only the ≥ 4000 m giants (Himalaya, Andes,
# Alps' 4000ers, Alaska, Tian Shan …). By z9 (a region) every 1000 m peak is
# in; z11 (a valley) adds every peak with a known height; peaks with no usable
# `ele` come last, at z12 — still a zoom earlier than Protomaps' z13.
ELEVATION_LADDER = [
    (4000, 5),
    (3000, 6),
    (2000, 7),
    (1500, 8),
    (1000, 9),
    (500, 10),
]
KNOWN_ELE_MINZOOM = 11  # 0 < ele < 500
UNKNOWN_ELE_MINZOOM = 12
# (minimum prominence in metres, zooms earlier): a 900 m monadnock that rises
# 600 m above its surroundings is a landmark; a 2100 m bump on a ridge is not.
PROMINENCE_PROMOTION = [(1500, 2), (500, 1)]
MIN_ZOOM = 5  # tippecanoe -Z
# The app draws each summit up to this many zooms BEFORE its ladder zoom (the
# peak-density setting, #461: `PEAK_MAX_LEAD` in src/core/map/terrainOptions.ts
# — keep the two equal). So every summit carries its ladder zoom as `rank` and
# goes into the tiles this much earlier; the app's filter picks the lead.
PEAK_MAX_LEAD = 2

# Plausible summit heights: the Dead Sea shore to Everest (8849 m) with slack.
ELE_RANGE = (-500.0, 9000.0)

_FEET = re.compile(r"(ft|feet|foot|')\s*$")
_NUMBER = re.compile(r'[-+]?\d[\d,.\s]*')


def parse_ele(raw):
    """OSM `ele`/`prominence` text → metres (float) or None.

    Handles "1234", "1234 m", "1234m", "1,234", "1234,5", "1 234", "4000ft",
    "13,123 ft", "~1200", "ca. 900", "1234;1240" (first value). Anything else
    — or a height outside ELE_RANGE — is None.
    """
    if raw is None:
        return None
    s = str(raw).strip().lower()
    s = s.split(';')[0].strip()
    s = re.sub(r'^(~|≈|c\.|ca\.?|approx\.?|about)\s*', '', s)
    m = _NUMBER.match(s)
    if not m:
        return None
    num = m.group(0).strip()
    unit = s[m.end():].strip()
    if unit and not re.fullmatch(r"(m|meters?|metres?|m\.?\s*a\.?\s*s\.?\s*l\.?|msl|amsl|ft|feet|foot|')", unit):
        return None
    num = re.sub(r'\s+', '', num)
    if re.fullmatch(r'[-+]?\d{1,3}(,\d{3})+(\.\d+)?', num):
        num = num.replace(',', '')  # 1,234 / 13,123.5
    elif re.fullmatch(r'[-+]?\d+,\d+', num):
        num = num.replace(',', '.')  # 1234,5 (decimal comma)
    try:
        value = float(num)
    except ValueError:
        return None
    if _FEET.search(unit):
        value *= 0.3048
    if not math.isfinite(value) or not ELE_RANGE[0] <= value <= ELE_RANGE[1]:
        return None
    return value


def minzoom_for(ele, prominence=None):
    """A summit's rank: the zoom its height earns (see ELEVATION_LADDER)."""
    if ele is None or ele <= 0:
        zoom = UNKNOWN_ELE_MINZOOM
    else:
        zoom = next((z for floor, z in ELEVATION_LADDER if ele >= floor), KNOWN_ELE_MINZOOM)
    if prominence is not None:
        zoom -= next((n for floor, n in PROMINENCE_PROMOTION if prominence >= floor), 0)
    return max(MIN_ZOOM, zoom)


def tile_minzoom(rank):
    """The first zoom whose tiles carry a summit of this rank (PEAK_MAX_LEAD earlier)."""
    return max(MIN_ZOOM, rank - PEAK_MAX_LEAD)


# --- Density: no more summits in a place than its labels have room for --------
#
# The elevation ladder alone floods the great ranges: every 1000 m summit is
# due at z9, and the six z9 tiles around Zermatt hold 4 100 of them (Québec
# City: 148) for the two or three dozen names a phone can show. Each one is
# still parsed, shaped and collided by the map on every tile load and camera
# move — measured in 2026-10 as most of what made the Alps slow to pan.
#
# So a summit's rank is also held back until it is among the best of its
# CELL: the map cut into squares CELL_ZOOM_SHIFT zooms finer than the tiles
# (128 px of a 512-px tile), each keeping its CELL_KEEP best summits (ladder
# rank, then height). A summit label is ~90 x 32 px: six is about what a cell
# has room for, and collisions still pick among them. The squares halve with
# every zoom, so a summit that makes it once stays.
#
# The density setting falls out of it: "more" (lead 2) hands the map six
# summits per 128-px cell — as crowded as collisions allow, which is what
# EVERY setting drew in the Alps before — "normal" six per 256 px, "fewer" six
# per tile. Where summits are sparse (most of the world) each is among the
# best of its cell at once and its rank is the ladder's, unchanged.
#
# Simulated on the live tiles (2026-10, a 411 x 914 px phone, "normal"):
# around Zermatt the tiles in view hand the style 130 summits at z9 instead
# of 3 757 (36 of them on screen: Dufourspitze, Dom, Weisshorn, Matterhorn …
# down to the best of each side valley); around Québec City 61 instead of 108
# (19 on screen, of 26).
CELL_ZOOM_SHIFT = 2
CELL_KEEP = 6
# The last zoom the tiles are built at (peaks.sh -z): every summit is in by then.
MAX_ZOOM = 12


def cell_of(lon, lat, zoom):
    """The (x, y) of the web-mercator square at `zoom` holding a point."""
    n = 2**zoom
    lat = max(-85.0511, min(85.0511, lat))
    x = int((lon + 180.0) / 360.0 * n)
    s = math.sin(math.radians(lat))
    y = int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n)
    return min(n - 1, max(0, x)), min(n - 1, max(0, y))


def density_zooms(summits):
    """For each (lon, lat, ladder_rank, ele): the first zoom at which it is
    among the CELL_KEEP best summits of its cell (MAX_ZOOM at the latest).

    Best = lowest ladder rank, then highest, then input order (stable, so a
    rebuild from the same data ranks the same).
    """
    order = sorted(
        range(len(summits)),
        key=lambda i: (summits[i][2], -(summits[i][3] if summits[i][3] is not None else -1e9), i),
    )
    out = [MAX_ZOOM] * len(summits)
    for zoom in range(0, MAX_ZOOM):
        taken = {}
        left = 0
        # Every summit competes at every zoom — one already in still holds its
        # cell — best first, so a cell's first CELL_KEEP comers are its best.
        for i in order:
            lon, lat = summits[i][0], summits[i][1]
            cell = cell_of(lon, lat, zoom + CELL_ZOOM_SHIFT)
            n = taken.get(cell, 0)
            taken[cell] = n + 1
            if out[i] == MAX_ZOOM:
                if n < CELL_KEEP:
                    out[i] = zoom
                else:
                    left += 1
        if left == 0:
            break
    return out


def dense_rank(ladder_rank, density_zoom):
    """The rank a summit is published with: its ladder rank, held back until
    the zoom its cell has room for it at the widest lead (PEAK_MAX_LEAD)."""
    return min(MAX_ZOOM, max(ladder_rank, density_zoom + PEAK_MAX_LEAD))


def apply_density(features):
    """Re-rank GeoJSON features (from `feature`) in place by local density."""
    summits = [
        (
            f['geometry']['coordinates'][0],
            f['geometry']['coordinates'][1],
            f['properties']['rank'],
            f['properties'].get('ele'),
        )
        for f in features
    ]
    for f, zoom in zip(features, density_zooms(summits)):
        rank = dense_rank(f['properties']['rank'], zoom)
        f['properties']['rank'] = rank
        f['tippecanoe'] = {'minzoom': tile_minzoom(rank)}
    return features


def feature(element):
    """An Overpass node element → a GeoJSON feature, or None when unusable."""
    tags = element.get('tags') or {}
    name = (tags.get('name') or '').strip()
    kind = tags.get('natural')
    lat, lon = element.get('lat'), element.get('lon')
    if not name or kind not in ('peak', 'volcano') or lat is None or lon is None:
        return None
    ele = parse_ele(tags.get('ele'))
    if ele is not None and ele == 0:
        ele = None  # "0" is a placeholder far more often than a sea-level summit
    props = {'name': name, 'kind': kind}
    for key in ('name:en', 'name:fr'):
        value = (tags.get(key) or '').strip()
        if value and value != name:
            props[key] = value
    if ele is not None:
        props['ele'] = int(round(ele))
    rank = minzoom_for(ele, parse_ele(tags.get('prominence')))
    props['rank'] = rank
    return {
        'type': 'Feature',
        'tippecanoe': {'minzoom': tile_minzoom(rank)},
        'properties': props,
        'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]},
    }


def query_for(bbox):
    """Overpass QL for the named summits in a [w, s, e, n] bbox."""
    w, s, e, n = bbox
    return (
        f'[out:json][timeout:{QUERY_TIMEOUT_S}][maxsize:{QUERY_MAXSIZE}];'
        f'node["natural"~"^(peak|volcano)$"]["name"]({s},{w},{n},{e});'
        'out qt;'
    )


def split4(bbox):
    w, s, e, n = bbox
    mx, my = (w + e) / 2, (s + n) / 2
    return [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]]


def overpass(bbox, endpoint, log, query=None):
    """Elements in bbox; retries with backoff, then splits the bbox in four.

    `query` builds the Overpass QL for a bbox (default: the named summits);
    parks_geojson.py passes its own. An element that spans split boxes comes
    back once per box — callers deduplicate by id.
    """
    return _overpass(bbox, endpoint, log, 0, query or query_for)


def _overpass(bbox, endpoint, log, depth, query=query_for):
    body = urllib.parse.urlencode({'data': query(bbox)}).encode()
    last = None
    for attempt in range(RETRIES):
        req = urllib.request.Request(
            endpoint, data=body, method='POST', headers={'User-Agent': USER_AGENT}
        )
        try:
            with urllib.request.urlopen(req, timeout=QUERY_TIMEOUT_S + 120) as resp:
                data = json.loads(resp.read())
            # Overpass reports a timeout / out-of-memory INSIDE a 200 answer
            # (with partial results): the bbox is too big — split it.
            remark = (data.get('remark') or '').strip()
            if 'error' in remark.lower():
                last = remark[:200]
                # Deterministic: the same box times out again. Split now
                # rather than burn ~4 x 3 min on retries (2026-09-29 run).
                break
            else:
                time.sleep(PAUSE_S)
                return data.get('elements', [])
        except urllib.error.HTTPError as e:
            if e.code == 400:
                raise RuntimeError(f'Overpass rejected the query: {e.read()[:300]!r}') from e
            # 429 = our slot is taken, 504 = server queue full: back off.
            last = f'HTTP {e.code}'
            wait = (120 if e.code == 429 else 60) * 2**attempt
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError) as e:
            last = str(e)[:200]
            if 'timed out' in last:
                break  # our read timeout: the box is too big for one answer
            wait = 60 * 2**attempt
        log(f'  {bbox}: {last}; retry {attempt + 1}/{RETRIES} in {wait}s')
        time.sleep(wait)
    if depth >= MAX_SPLIT_DEPTH:
        raise RuntimeError(f'{bbox} failed at split depth {depth}: {last}')
    log(f'  {bbox}: {last}; splitting in four')
    out = []
    for part in split4(bbox):
        out.extend(_overpass(part, endpoint, log, depth + 1, query))
    return out


def log(message):
    print(message, file=sys.stderr, flush=True)


def fetch(pieces_path, out_dir):
    endpoint = os.environ.get('OVERPASS_URL') or DEFAULT_ENDPOINT
    os.makedirs(out_dir, exist_ok=True)
    with open(pieces_path) as f:
        pieces = json.load(f)['pieces']
    for piece in pieces:
        path = os.path.join(out_dir, f"{piece['name']}.json")
        if os.path.exists(path):  # resumable within a run (peaks.sh clears the dir first)
            log(f"{piece['name']}: already fetched")
            continue
        log(f"{time.strftime('%c')} {piece['name']} {piece['bbox']}")
        elements = overpass(piece['bbox'], endpoint, log)
        with open(path + '.tmp', 'w', encoding='utf-8') as f:
            json.dump({'elements': elements}, f)
        os.replace(path + '.tmp', path)
        log(f"  {len(elements)} summits")


def convert(in_dir, out_path):
    """Merge the per-piece answers (deduplicated by OSM id) into GeoJSONSeq."""
    seen = set()
    features = []
    for name in sorted(os.listdir(in_dir)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(in_dir, name), encoding='utf-8') as f:
            elements = json.load(f).get('elements', [])
        for element in elements:
            osm_id = element.get('id')
            if osm_id in seen:
                continue  # pieces share their edges
            seen.add(osm_id)
            feat = feature(element)
            if feat is not None:
                features.append(feat)
    # A rank depends on the summit's neighbours, so only now (apply_density).
    apply_density(features)
    with open(out_path, 'w', encoding='utf-8') as out:
        for feat in features:
            out.write(json.dumps(feat, ensure_ascii=False, separators=(',', ':')) + '\n')
    return len(features)


def main(argv):
    if len(argv) == 4 and argv[1] == 'fetch':
        fetch(argv[2], argv[3])
        return 0
    if len(argv) == 4 and argv[1] == 'convert':
        print(convert(argv[2], argv[3]))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
