"""Shared paging helpers for the wave-2 source modules (src_*.py).

Every fetcher writes numbered JSON pages under RAW/pages/ and is resumable
within a cycle (common.resumable): an interrupted run continues after the
last complete page. One connection per agency server, a pause between pages.
"""
import glob
import json
import os
import re
import shutil
import time
import urllib.parse

from common import http_get, log, resumable

PAUSE_S = float(os.environ.get('GEODETIC_PAGE_PAUSE_S', '1.0'))


def already_done(raw_dir):
    """A complete page set from this cycle and no half-done one: skip refetching."""
    return resumable(os.path.join(raw_dir, 'pages')) and not os.path.isdir(os.path.join(raw_dir, 'pages.new'))


def _staging(raw_dir):
    """Pages are written to pages.new/ and swapped into pages/ only when complete,
    so a failed fetch leaves last cycle's complete set (last-good fallback)."""
    new = os.path.join(raw_dir, 'pages.new')
    if os.path.isdir(new) and not resumable(new):
        shutil.rmtree(new)
    os.makedirs(new, exist_ok=True)
    return new


def _commit(raw_dir):
    new = os.path.join(raw_dir, 'pages.new')
    final = os.path.join(raw_dir, 'pages')
    old = os.path.join(raw_dir, 'pages.old')
    shutil.rmtree(old, ignore_errors=True)
    if os.path.isdir(final):
        os.replace(final, old)
    os.replace(new, final)
    shutil.rmtree(old, ignore_errors=True)


def _existing(stage):
    return sorted(glob.glob(os.path.join(stage, 'p*.json')))


def _write(stage, n, features, cursor=None):
    path = os.path.join(stage, f'p{n:05d}.json')
    with open(path + '.tmp', 'w', encoding='utf-8') as f:
        json.dump({'cursor': cursor, 'features': features}, f, ensure_ascii=False)
    os.replace(path + '.tmp', path)
    # touch the dir so resumable() sees this cycle's activity
    os.utime(os.path.dirname(path))


def keyset_pages(raw_dir, url_for, key_of, page_size, start=None, label='', parse=json.loads):
    """Keyset paging: url_for(after) → URL of the next `page_size` rows sorted by
    key, where key > after. key_of(feature) → that key. Ends on a short page."""
    os.makedirs(raw_dir, exist_ok=True)
    if already_done(raw_dir):
        log(f'{label}: already fetched this cycle')
        return
    stage = _staging(raw_dir)
    pages = _existing(stage)
    after = start
    if pages:
        after = json.load(open(pages[-1]))['cursor']
    n = len(pages)
    while True:
        feats = parse(http_get(url_for(after), timeout=300)).get('features') or []
        if feats:
            after = key_of(feats[-1])
            _write(stage, n, feats, after)
            n += 1
        if n % 10 == 0:
            log(f'{label}: {n} pages, last key {after}')
        if len(feats) < page_size:
            break
        time.sleep(PAUSE_S)
    _commit(raw_dir)
    log(f'{label}: {n} pages done')


def offset_pages(raw_dir, url_for, page_size, label='', parse=json.loads, total=None):
    """Offset paging: url_for(offset) → URL of `page_size` rows from `offset`."""
    os.makedirs(raw_dir, exist_ok=True)
    if already_done(raw_dir):
        log(f'{label}: already fetched this cycle')
        return
    stage = _staging(raw_dir)
    n = len(_existing(stage))
    while True:
        feats = parse(http_get(url_for(n * page_size), timeout=300)).get('features') or []
        if feats:
            _write(stage, n, feats, n)
            n += 1
        if n % 10 == 0:
            log(f'{label}: {n} pages ({n * page_size}{"/" + str(total) if total else ""})')
        if len(feats) < page_size:
            break
        time.sleep(PAUSE_S)
    _commit(raw_dir)
    log(f'{label}: {n} pages done')


def next_link_pages(raw_dir, first_url, label=''):
    """OGC API Features: follow rel=next links."""
    os.makedirs(raw_dir, exist_ok=True)
    if already_done(raw_dir):
        log(f'{label}: already fetched this cycle')
        return
    stage = _staging(raw_dir)
    pages = _existing(stage)
    url = first_url
    if pages:
        url = json.load(open(pages[-1]))['cursor']
        if url is None:
            _commit(raw_dir)
            return
    n = len(pages)
    while url:
        d = json.loads(http_get(url, timeout=300, headers={'Accept': 'application/geo+json'}))
        nxt = next((ln.get('href') for ln in d.get('links') or [] if ln.get('rel') == 'next'), None)
        _write(stage, n, d.get('features') or [], nxt)
        n += 1
        if n % 10 == 0:
            log(f'{label}: {n} pages')
        url = nxt
        if url:
            time.sleep(PAUSE_S)
    _commit(raw_dir)
    log(f'{label}: {n} pages done')


def features(raw_dir):
    for path in sorted(glob.glob(os.path.join(raw_dir, 'pages', 'p*.json'))):
        with open(path, encoding='utf-8') as f:
            page = json.load(f)
        yield from page['features']


def arcgis_url(layer_url, where, out_fields, offset, count, out_sr=4326, order='OBJECTID'):
    q = {
        'where': where, 'outFields': out_fields, 'outSR': out_sr, 'f': 'geojson',
        'resultOffset': offset, 'resultRecordCount': count, 'orderByFields': order,
        'returnGeometry': 'true',
    }
    return layer_url.rstrip('/') + '/query?' + urllib.parse.urlencode(q)


def arcgis_pages(raw_dir, layer_url, out_fields='*', page=2000, where='1=1', label='', out_sr=4326,
                 order='OBJECTID', fmt='json'):
    """An ArcGIS REST layer, `page` rows at a time (resultOffset paging, one
    connection, a pause between pages). Pages hold Esri JSON features
    ({attributes, geometry}) — or GeoJSON with fmt='geojson'."""
    def url_for(offset):
        q = {
            'where': where, 'outFields': out_fields, 'outSR': out_sr, 'f': fmt,
            'resultOffset': offset, 'resultRecordCount': page, 'orderByFields': order,
            'returnGeometry': 'true',
        }
        return layer_url.rstrip('/') + '/query?' + urllib.parse.urlencode(q)

    def parse(body):
        d = json.loads(body)
        if 'error' in d:
            raise RuntimeError(f"{label}: {d['error']}")
        return d

    offset_pages(raw_dir, url_for, page, label=label, parse=parse)


# ---------- small value helpers ----------

def date_of(s):
    """'2000/10/11', '2000-10-11T…', '20001011', '11.10.2000', '1963' → ISO (or None)."""
    if s is None:
        return None
    s = str(s).strip()
    if not s:
        return None
    m = re.match(r'(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', s)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    m = re.match(r'(\d{1,2})[./](\d{1,2})[./](\d{4})', s)
    if m:
        return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    m = re.fullmatch(r'(\d{4})(\d{2})(\d{2})', s)
    if m:
        return f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
    m = re.match(r'(\d{4})\b', s)
    if m and 1800 < int(m.group(1)) < 2100:
        return m.group(1)
    return None


def epoch_ms_date(v):
    """ArcGIS esriFieldTypeDate (ms since 1970) → ISO date."""
    try:
        return time.strftime('%Y-%m-%d', time.gmtime(int(v) / 1000))
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def acc_m(text):
    """'< 10 cm' / '< 1 m' / '5 mm' → metres (None when unparseable)."""
    if not text:
        return None
    m = re.search(r'([\d.,]+)\s*(mm|cm|dm|km|m)\b', str(text))
    if not m:
        return None
    v = float(m.group(1).replace(',', '.'))
    return v * {'mm': 0.001, 'cm': 0.01, 'dm': 0.1, 'm': 1.0, 'km': 1000.0}[m.group(2)]


def ecef_to_geodetic(x, y, z, a=6378137.0, f=1 / 298.257222101):
    """Geocentric XYZ (GRS80) → lat, lng, ellipsoidal height. An exact
    coordinate conversion within the agency's own frame (no datum shift)."""
    import math  # noqa: PLC0415

    e2 = f * (2 - f)
    lng = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - e2))
    h = 0.0
    for _ in range(10):
        n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - e2 * n / (n + h)))
    n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    h = p / math.cos(lat) - n
    return math.degrees(lat), math.degrees(lng), h


TYPE_PRIORITY = {'gnss': 0, '3d': 1, 'h': 2, 'v': 3, 'u': 4}


def merge_colocated(records, within_m=0.5):
    """One agency, one physical mark in two of its networks (a geodetic vertex
    that is also a levelling mark…): keep the richest type, alias the others'
    IDs, and keep a height the survivor lacks only if on another datum."""
    import math  # noqa: PLC0415

    cell = {}
    out = []
    for r in sorted(records, key=lambda r: TYPE_PRIORITY.get(r['type'], 9)):
        k = (round(r['lat'] * 2e4), round(r['lng'] * 2e4))
        twin = None
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for o in cell.get((k[0] + dy, k[1] + dx), ()):
                    d = math.hypot((o['lat'] - r['lat']) * 111320,
                                   (o['lng'] - r['lng']) * 111320 * math.cos(math.radians(r['lat'])))
                    if d <= within_m:
                        twin = o
        if twin is None:
            cell.setdefault(k, []).append(r)
            out.append(r)
            continue
        twin.setdefault('aliases', [])
        for a in [r['id']] + list(r.get('aliases') or []):
            if a not in twin['aliases'] and a != twin['id']:
                twin['aliases'].append(a)
        datums = {h['datum'] for h in twin.get('hOrtho') or []}
        for h in r.get('hOrtho') or []:
            if h['datum'] not in datums:
                twin.setdefault('hOrtho', []).append(h)
    return out


def text_of(v):
    """An agency value as published: numbers via repr (JSON loses only trailing
    zeros), strings with decimal comma → dot and whitespace collapsed."""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return repr(v)
    s = re.sub(r'\s+', ' ', str(v)).strip()
    s = re.sub(r'(\d),(\d)', r'\1.\2', s)
    return s or None


def height(value, datum, text=None):
    """An hOrtho entry: float value + verbatim text."""
    from common import fnum  # noqa: PLC0415

    v = fnum(value)
    if v is None:
        return None
    return {'value': v, 'datum': datum, 'text': text_of(text if text is not None else value)}


def grid(system, e, n):
    e, n = text_of(e), text_of(n)
    if not system or not e or not n:
        return None
    return {'system': system, 'e': e, 'n': n}


def sentence(s):
    s = re.sub(r'\s+', ' ', str(s or '')).strip()
    return s[:1].upper() + s[1:].lower() if s.isupper() else s


def monument_from_words(text, rules, default='other'):
    t = (text or '').lower()
    for words, code in rules:
        if any(w in t for w in words):
            return code
    return default


def to_wgs84(epsg, x, y):
    """Reproject with pyproj (in the pipeline image) → (lat, lng)."""
    from pyproj import Transformer  # noqa: PLC0415

    t = _TRANSFORMERS.get(epsg)
    if t is None:
        t = _TRANSFORMERS[epsg] = Transformer.from_crs(epsg, 4326, always_xy=True)
    lng, lat = t.transform(x, y)
    return lat, lng


_TRANSFORMERS = {}

BEV_GRID_URL = 'https://cdn.proj.org/at_bev_AT_GIS_GRID_2021_09_28.tif'
BEV_GRID = 'at_bev_AT_GIS_GRID_2021_09_28.tif'
MGI_GK_LON0 = {'M28': 10 + 20 / 60, 'M31': 13 + 20 / 60, 'M34': 16 + 20 / 60}


def fetch_bev_grid(raw_dir):
    """BEV's official MGI → ETRS89 grid (GIS-Grid 2021, CC BY 4.0, from the PROJ CDN)."""
    from common import download  # noqa: PLC0415

    os.makedirs(raw_dir, exist_ok=True)
    try:
        download(BEV_GRID_URL, os.path.join(raw_dir, BEV_GRID))
    except Exception as e:  # noqa: BLE001
        log(f'BEV grid: {e}; Helmert fallback (±1.5 m)')


def mgi_gk_to_etrs89(raw_dir):
    """(meridian 'M28'|'M31'|'M34', Rechtswert, Hochwert) → (lat, lng, posAcc).

    BEV publishes Hochwert with the 5,000,000 m offset kept (true northing), so
    the Gauss-Krüger projection is used with y_0 = 0. With BEV's grid the
    datum change is BEV's own (~0.15 m); without it PROJ's Helmert (~1.5 m)."""
    from pyproj import Transformer  # noqa: PLC0415

    grid_path = os.path.join(raw_dir, BEV_GRID)
    cache = {}

    def conv(meridian, rw, hw):
        t = cache.get(meridian)
        if t is None:
            lon0 = MGI_GK_LON0[meridian]
            tm = f'+proj=tmerc +lat_0=0 +lon_0={lon0} +k=1 +x_0=0 +y_0=0 +ellps=bessel'
            if os.path.exists(grid_path):
                t = Transformer.from_pipeline(
                    f'+proj=pipeline +step +inv {tm} +step +proj=hgridshift +grids={grid_path} '
                    '+step +proj=unitconvert +xy_in=rad +xy_out=deg')
                acc = None
            else:
                t = Transformer.from_crs(f'{tm} +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232',
                                         4326, always_xy=True)
                acc = 1.5
            cache[meridian] = t = (t, acc)
        tr, acc = t
        lng, lat = tr.transform(rw, hw)
        return lat, lng, acc

    return conv


RD_GRID_URL = 'https://cdn.proj.org/nl_nsgi_rdtrans2018.tif'
RD_GRID = 'nl_nsgi_rdtrans2018.tif'


def fetch_rd_grid(raw_dir):
    """NSGI's RDNAPTRANS2018 horizontal grid (from the PROJ CDN)."""
    from common import download  # noqa: PLC0415

    os.makedirs(raw_dir, exist_ok=True)
    try:
        download(RD_GRID_URL, os.path.join(raw_dir, RD_GRID))
    except Exception as e:  # noqa: BLE001
        log(f'RD grid: {e}; Helmert fallback (±1 m)')


def rd_to_etrs89(raw_dir):
    """(x_rd, y_rd) → (lat, lng, posAcc): RD (Amersfoort) with the
    RDNAPTRANS2018 grid (mm-level), else PROJ's Helmert (~1 m)."""
    from pyproj import Transformer  # noqa: PLC0415

    grid_path = os.path.join(raw_dir, RD_GRID)
    if os.path.exists(grid_path):
        t = Transformer.from_pipeline(
            '+proj=pipeline +step +inv +proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 '
            '+k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel '
            f'+step +proj=hgridshift +grids={grid_path} +step +proj=unitconvert +xy_in=rad +xy_out=deg')
        acc = None
    else:
        t = Transformer.from_crs(28992, 4326, always_xy=True)
        acc = 1.0

    def conv(x, y):
        lng, lat = t.transform(x, y)
        return lat, lng, acc

    return conv


def dms_to_deg(text):
    """'53 27 27,04098' → 53.457511… (published DMS, decimal comma allowed)."""
    parts = str(text).replace(',', '.').split()
    if len(parts) != 3:
        return None
    d, m, s = (float(p) for p in parts)
    sign = -1 if str(text).strip().startswith('-') else 1
    return sign * (abs(d) + m / 60 + s / 3600)


OSTN15_URL = 'https://cdn.proj.org/uk_os_OSTN15_NTv2_OSGBtoETRS.tif'


def fetch_ostn15(raw_dir):
    """OS's OSTN15 NTv2 grid (open, from the PROJ CDN) next to the raw data."""
    from common import download  # noqa: PLC0415

    os.makedirs(raw_dir, exist_ok=True)
    path = os.path.join(raw_dir, 'OSTN15_NTv2_OSGBtoETRS.tif')
    try:
        download(OSTN15_URL, path)
    except Exception as e:  # noqa: BLE001 — fall back to the Helmert transform
        log(f'OSTN15 grid: {e}; Helmert fallback (±2 m)')
    return path


def osgb_to_wgs84(raw_dir):
    """(easting, northing) → (lat, lng, posAcc) for British National Grid.

    With the OSTN15 grid: OSGB36 → ETRS89 at the centimetre (ETRS89 is taken
    as WGS 84, like every realization in this pipeline). Without it, PROJ's
    Helmert (±2 m) and posAcc says so.
    """
    from pyproj import Transformer  # noqa: PLC0415

    grid = os.path.join(raw_dir, 'OSTN15_NTv2_OSGBtoETRS.tif')
    if os.path.exists(grid):
        t = Transformer.from_pipeline(
            '+proj=pipeline +step +inv +proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 '
            '+x_0=400000 +y_0=-100000 +ellps=airy '
            f'+step +proj=hgridshift +grids={grid} '
            '+step +proj=unitconvert +xy_in=rad +xy_out=deg')
        acc = None
    else:
        t = Transformer.from_crs(27700, 4326, always_xy=True)
        acc = 2.0

    def conv(e, n):
        lng, lat = t.transform(e, n)
        return lat, lng, acc

    return conv
