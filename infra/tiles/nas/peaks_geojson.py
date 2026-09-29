#!/usr/bin/env python3
"""Named summits for the base map's `peaks` layer (see peaks.sh).

    peaks_geojson.py fetch PIECES_JSON OUT_DIR     # Overpass → OUT_DIR/<piece>.json
    peaks_geojson.py convert OUT_DIR OUT.geojsonl  # → GeoJSONSeq for tippecanoe; prints the count

Protomaps only puts peaks in its `pois` layer from z13, so a 4000 m summit is
unnamed at the zooms where you'd plan a trip. This builds our own worldwide
tileset from OpenStreetMap: every node tagged natural=peak|volcano with a name.

Each feature carries `name` (+ `name:en` / `name:fr` when they differ), `ele`
(integer metres, when the OSM `ele` tag parses) and `kind` (peak|volcano), and
a `tippecanoe.minzoom` from ELEVATION_LADDER, so the big summits show from z5
and smaller ones join as you zoom in. Local prominence would rank better than
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
    """The zoom a summit first appears at (see ELEVATION_LADDER)."""
    if ele is None or ele <= 0:
        zoom = UNKNOWN_ELE_MINZOOM
    else:
        zoom = next((z for floor, z in ELEVATION_LADDER if ele >= floor), KNOWN_ELE_MINZOOM)
    if prominence is not None:
        zoom -= next((n for floor, n in PROMINENCE_PROMOTION if prominence >= floor), 0)
    return max(MIN_ZOOM, zoom)


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
    return {
        'type': 'Feature',
        'tippecanoe': {'minzoom': minzoom_for(ele, parse_ele(tags.get('prominence')))},
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


def overpass(bbox, endpoint, log):
    """Elements in bbox; retries with backoff, then splits the bbox in four."""
    return _overpass(bbox, endpoint, log, 0)


def _overpass(bbox, endpoint, log, depth):
    body = urllib.parse.urlencode({'data': query_for(bbox)}).encode()
    last = None
    too_big = 0
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
                too_big += 1
                if too_big >= 2:
                    break
                wait = 60
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
            wait = 60 * 2**attempt
        log(f'  {bbox}: {last}; retry {attempt + 1}/{RETRIES} in {wait}s')
        time.sleep(wait)
    if depth >= MAX_SPLIT_DEPTH:
        raise RuntimeError(f'{bbox} failed at split depth {depth}: {last}')
    log(f'  {bbox}: {last}; splitting in four')
    out = []
    for part in split4(bbox):
        out.extend(_overpass(part, endpoint, log, depth + 1))
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
    count = 0
    with open(out_path, 'w', encoding='utf-8') as out:
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
                    out.write(json.dumps(feat, ensure_ascii=False, separators=(',', ':')) + '\n')
                    count += 1
    return count


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
