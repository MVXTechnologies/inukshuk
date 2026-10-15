#!/usr/bin/env python3
"""Cross-check our DEM tiles against the agencies' own tools (DEM-VALIDATION.md).

For each site in validation-sites.json:

1. Our tile: the Mapterhorn z15 WebP covering the site, cut into its z16
   quadrant by transcode.py (the exact code the NAS runs) — i.e. the bytes
   /dem/16/x/y.png serves.
2. The agency's terrain model at the same places, from its official service:
   - Québec: NRCan HRDEM Mosaic DTM, WCS GetCoverage on the tile's own
     Web Mercator grid (every pixel of the tile, CGVD2013);
   - Switzerland: swisstopo's height service (swissALTI3D, LN02), positions
     converted WGS84 → LV95 by swisstopo REFRAME;
   - France: IGN Géoplateforme altimetry service (LiDAR HD MNT, NGF-IGN69;
     RGE ALTI reported alongside).
3. Survey benchmarks near the site (levelled / GNSS heights, the agency's
   published value): NRCan CBN / HP3D / PVC (CGVD2013), swisstopo HFP1 /
   LFP1 (H02 = LN02).

Writes a JSON report and, with --fixtures DIR, the small fixture the Worker's
Jest gate reads (src/__fixtures__/dem/validation.json): a 32 × 32-px crop of
each tile (Terrarium PNG, base64) with the official values at points inside it.

    python3 validate.py --report report.json [--fixtures DIR] [--sites id,id]

Network: ~150 KB per site from tiles.mapterhorn.com plus the agencies' APIs,
paced (PAUSE_S). Standard library + Pillow.
"""
import argparse
import base64
import io
import json
import math
import os
import statistics
import struct
import sys
import time
import urllib.parse
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from transcode import quadrants  # noqa: E402

UA = 'inukshuk-dem-validate/1 (+https://github.com/MVXTechnologies/inukshuk)'
MAPTERHORN = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
HRDEM_WCS = 'https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic'
CH_HEIGHT = 'https://api3.geo.admin.ch/rest/services/height'
CH_IDENTIFY = 'https://api3.geo.admin.ch/rest/services/api/MapServer/identify'
REFRAME = 'https://geodesy.geo.admin.ch/reframe/{op}'
IGN_ALTI = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json'
NRCAN = 'https://webapp.csrs-scrs.nrcan-rncan.gc.ca/geod/process'
Z = 16
SIZE = 256
CROP = 32
WORLD = 2 * math.pi * 6378137.0
PAUSE_S = float(os.environ.get('VALIDATE_PAUSE_S', '0.2'))


def http(url, data=None, timeout=120, attempts=4):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            time.sleep(PAUSE_S)
            return body
        except Exception as e:
            if attempt == attempts - 1:
                raise
            print(f'retrying {url[:120]}: {e}', file=sys.stderr, flush=True)
            time.sleep(5 * (attempt + 1))


# --- tile geometry -----------------------------------------------------------------

def global_px(lat, lon, z=Z):
    """Continuous pixel coordinates (pixel centres at .5) of a point at zoom z."""
    n = SIZE * 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def px_lonlat(gx, gy, z=Z):
    n = SIZE * 2 ** z
    lon = gx / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy / n))))
    return lat, lon


# --- our tiles ---------------------------------------------------------------------

class OurTiles:
    """z16 tiles as /dem serves them inside coverage, made from Mapterhorn z15 WebP."""

    def __init__(self):
        self.cache = {}

    def png(self, x, y):
        key = (x, y)
        if key not in self.cache:
            webp = http(MAPTERHORN.format(z=Z - 1, x=x >> 1, y=y >> 1))
            for z, qx, qy, png, _ in quadrants(Z - 1, x >> 1, y >> 1, webp,
                                               lambda z, a, b: True):
                self.cache[(qx, qy)] = png
        return self.cache[key]

    def heights(self, x, y):
        img = Image.open(io.BytesIO(self.png(x, y))).convert('RGB')
        b = img.tobytes()
        return [b[i] * 256 + b[i + 1] + b[i + 2] / 256 - 32768 for i in range(0, len(b), 3)]

    def at(self, lat, lon):
        """Bilinear height at a point (pixel centres), across tile edges."""
        gx, gy = global_px(lat, lon)
        fx, fy = gx - 0.5, gy - 0.5
        x0, y0 = math.floor(fx), math.floor(fy)
        tx, ty = fx - x0, fy - y0
        vals = []
        for dy in (0, 1):
            for dx in (0, 1):
                px, py = x0 + dx, y0 + dy
                h = self._h(px // SIZE, py // SIZE)
                vals.append(h[(py % SIZE) * SIZE + px % SIZE])
        top = vals[0] * (1 - tx) + vals[1] * tx
        bottom = vals[2] * (1 - tx) + vals[3] * tx
        return top * (1 - ty) + bottom * ty

    def _h(self, x, y):
        k = ('h', x, y)
        if k not in self.cache:
            self.cache[k] = self.heights(x, y)
        return self.cache[k]


# --- official terrain models ---------------------------------------------------------

def hrdem_tile(x, y):
    """NRCan HRDEM Mosaic DTM on the z16 tile's own grid: 65 536 floats (None = no data)."""
    size = WORLD / 2 ** Z
    w = -WORLD / 2 + x * size
    n = WORLD / 2 - y * size
    px = size / SIZE
    q = {
        'service': 'WCS', 'version': '1.1.1', 'request': 'GetCoverage', 'identifier': 'dtm',
        'boundingbox': f'{w + px / 2},{n - size + px / 2},{w + size - px / 2},{n - px / 2},'
                       'urn:ogc:def:crs:EPSG::3857',
        'format': 'image/geotiff', 'GridBaseCRS': 'urn:ogc:def:crs:EPSG::3857',
        'GridOffsets': f'{px},{-px}', 'GridOrigin': f'{w + px / 2},{n - px / 2}', 'store': 'false',
    }
    tif = http(HRDEM_WCS + '?' + urllib.parse.urlencode(q))
    return parse_float_tiff(tif, (w, n), px)


def parse_float_tiff(tif, origin, px):
    """The WCS answer: one strip/tile of 256 × 256 float32, grid checked against ours."""
    bo = {b'MM': '>', b'II': '<'}[tif[:2]]
    (ifd,) = struct.unpack(bo + 'I', tif[4:8])
    (count,) = struct.unpack(bo + 'H', tif[ifd:ifd + 2])
    tags = {}
    types = {3: ('H', 2), 4: ('I', 4), 12: ('d', 8), 11: ('f', 4)}
    for i in range(count):
        e = ifd + 2 + 12 * i
        tag, typ, n = struct.unpack(bo + 'HHI', tif[e:e + 8])
        if typ not in types:
            continue
        fmt, size = types[typ]
        raw = tif[e + 8:e + 12] if n * size <= 4 else \
            tif[struct.unpack(bo + 'I', tif[e + 8:e + 12])[0]:][:n * size]
        tags[tag] = struct.unpack(bo + fmt * n, raw[:n * size])
    w, h = tags[256][0], tags[257][0]
    if (w, h) != (SIZE, SIZE) or tags.get(258, (32,))[0] != 32 or tags.get(259, (1,))[0] != 1:
        raise ValueError(f'unexpected WCS raster {w}x{h} {tags.get(258)} {tags.get(259)}')
    tie, scale = tags[33922], tags[33550]
    if abs(tie[3] - origin[0]) > px * 1e-3 or abs(tie[4] - origin[1]) > px * 1e-3 \
            or abs(scale[0] - px) > px * 1e-6:
        raise ValueError('WCS grid does not match the tile grid')
    off = (tags.get(273) or tags.get(324))[0]
    vals = struct.unpack(bo + 'f' * (SIZE * SIZE), tif[off:off + 4 * SIZE * SIZE])
    nodata = -32767.0
    return [None if (v <= nodata + 1 or v != v or abs(v) > 1e5) else v for v in vals]


def reframe(op, a, b):
    d = json.loads(http(REFRAME.format(op=op) + '?' + urllib.parse.urlencode(
        {'easting': a, 'northing': b, 'format': 'json'})))
    return float(d['easting']), float(d['northing'])


def ch_height(lat, lon):
    e, n = reframe('wgs84tolv95', lon, lat)
    d = json.loads(http(CH_HEIGHT + '?' + urllib.parse.urlencode(
        {'easting': f'{e:.2f}', 'northing': f'{n:.2f}', 'sr': 2056})))
    return float(d['height'])


IGN_LIDAR_HD = 'ign_lidar_hd_mnt_mono_wld'  # LiDAR HD MNT, 0.5 m (with interpolation)
IGN_RGE_ALTI = 'ign_rge_alti_wld'  # RGE ALTI 1 m / 5 m


def ign_heights(points, resource):
    q = {'lon': '|'.join(f'{lon:.7f}' for _, lon in points),
         'lat': '|'.join(f'{lat:.7f}' for lat, _ in points),
         'resource': resource, 'zonly': 'true'}
    d = json.loads(http(IGN_ALTI + '?' + urllib.parse.urlencode(q)))
    return [None if v <= -99999 else float(v) for v in d['elevations']]


# --- benchmarks ---------------------------------------------------------------------

def nrcan_marks(lat, lon, radius_deg=0.03, limit=12):
    """NRCan CBN / HP3D / PVC stations near a point with a CGVD2013 height (GOOD only)."""
    import csv
    ids = []
    for net in ('cbn', 'hp3d', 'pvc'):
        body = urllib.parse.urlencode({
            'map': net, 'minlatitude': lat - radius_deg, 'maxlatitude': lat + radius_deg,
            'minlongitude': lon - radius_deg * 1.5, 'maxlongitude': lon + radius_deg * 1.5,
        }).encode()
        d = json.loads(http(f'{NRCAN}/getStations.php', data=body, timeout=45, attempts=2))
        for grp in (d.get('networks') or {}).get('stations') or []:
            for st in grp:
                if (st.get('status') or '').upper() == 'GOOD':
                    ids.append((st['net'], st['id']))
    out = []
    for k in range(0, len(ids), 20):
        batch = [i for _, i in ids[k:k + 20]]
        body = urllib.parse.urlencode({'id': ','.join(batch), 'type': 'csv', 'map': ''}).encode()
        text = http(f'{NRCAN}/stationsDownload.php', data=body, timeout=45, attempts=2).decode('utf-8-sig', 'replace')
        for r in csv.DictReader(io.StringIO(text)):
            try:
                h = float(r.get('CGVD2013') or 'x')
                mlat = float(r['Latitude'])
                mlon = -abs(float(r['Longitude']))
            except ValueError:
                continue
            decimals = len((r['Latitude'].split('.') + [''])[1])
            try:
                sigma = max(float(r.get('Latitude sigma') or 'x'),
                            float(r.get('Longitude sigma') or 'x'))
            except ValueError:
                sigma = None
            # Without a published sigma the position is only as good as its
            # decimals (4 → ~11 m): scaled from a map, not surveyed.
            pos_acc = sigma if sigma is not None else 111_000 * 10 ** -decimals
            out.append({'id': r['Unique Number'], 'name': r.get('Name'), 'lat': mlat, 'lon': mlon,
                        'h': h, 'datum': 'CGVD2013', 'posAccM': round(pos_acc, 3),
                        'kind': next(n for n, i in ids if i == r['Unique Number'])})
        if k + 20 >= 80:  # enough candidates; be polite to the CSRS webapp
            break
    # Surveyed positions first: a map-scaled one says little on a slope.
    return sorted(out, key=lambda m: (m['posAccM'], m['id']))[:limit]


def swiss_marks(lat, lon, half_m=2500, limit=12):
    e, n = reframe('wgs84tolv95', lon, lat)
    env = f'{e - half_m},{n - half_m},{e + half_m},{n + half_m}'
    q = {'geometryType': 'esriGeometryEnvelope', 'geometry': env, 'imageDisplay': '500,500,96',
         'mapExtent': env, 'tolerance': 0, 'sr': 2056, 'returnGeometry': 'true', 'limit': 50,
         'layers': 'all:ch.swisstopo.fixpunkte-hfp1,ch.swisstopo.fixpunkte-lfp1'}
    d = json.loads(http(CH_IDENTIFY + '?' + urllib.parse.urlencode(q)))
    out = []
    for f in d.get('results', []):
        a = f.get('attributes', {})
        if a.get('h02') is None:
            continue
        mlon, mlat = reframe('lv95towgs84', a['e95'], a['n95'])
        out.append({'id': f['id'], 'name': a.get('punktname'), 'lat': mlat, 'lon': mlon,
                    'h': float(a['h02']), 'datum': 'LN02', 'kind': f.get('layerBodId'),
                    'posAccM': float(a.get('l_gen_lv95') or 1.0),
                    'mark': a.get('kennzeichnung') or a.get('punktzeichen')})
        if len(out) >= limit:
            break
    return out


def envelope(ours, lat, lon, radius_m):
    """Lowest and highest DEM height within radius_m of a point (a disc of samples)."""
    dlat = radius_m / 111_320
    dlon = radius_m / (111_320 * math.cos(math.radians(lat)))
    vals = [ours.at(lat + dlat * j / 5, lon + dlon * i / 5)
            for j in range(-5, 6) for i in range(-5, 6) if i * i + j * j <= 25]
    return min(vals), max(vals)


# --- statistics ----------------------------------------------------------------------

def stats(diffs):
    if not diffs:
        return None
    a = sorted(diffs)
    absd = sorted(abs(d) for d in a)
    n = len(a)
    return {
        'n': n,
        'mean': round(statistics.fmean(a), 3),
        'median': round(statistics.median(a), 3),
        'rms': round(math.sqrt(sum(d * d for d in a) / n), 3),
        'p95abs': round(absd[min(n - 1, int(0.95 * n))], 3),
        'maxabs': round(absd[-1], 3),
    }


# --- one site ------------------------------------------------------------------------

def crop_png(png, x0, y0):
    img = Image.open(io.BytesIO(png)).convert('RGB').crop((x0, y0, x0 + CROP, y0 + CROP))
    out = io.BytesIO()
    img.save(out, 'PNG', compress_level=9)
    return out.getvalue()


def run_site(site, ours, log):
    gx, gy = global_px(site['lat'], site['lon'])
    tx, ty = int(gx // SIZE), int(gy // SIZE)
    png = ours.png(tx, ty)
    h = ours.heights(tx, ty)
    # The crop: 32 × 32 px around the site (kept inside the tile).
    cx0 = min(max(int(gx % SIZE) - CROP // 2, 0), SIZE - CROP)
    cy0 = min(max(int(gy % SIZE) - CROP // 2, 0), SIZE - CROP)
    result = {'id': site['id'], 'region': site['region'], 'tile': [Z, tx, ty],
              'crop': [cx0, cy0, CROP], 'tool': site['official']}
    fixture_points = []
    if site['official'] == 'hrdem-wcs':
        off = hrdem_tile(tx, ty)
        diffs = [h[i] - off[i] for i in range(SIZE * SIZE) if off[i] is not None]
        result['tileVsOfficial'] = stats(diffs)
        crop_d = []
        for py in range(cy0, cy0 + CROP, 4):
            for px in range(cx0, cx0 + CROP, 4):
                v = off[py * SIZE + px]
                if v is not None:
                    fixture_points.append([px - cx0, py - cy0, round(v, 3)])
                    crop_d.append(h[py * SIZE + px] - v)
        result['cropVsOfficial'] = stats(crop_d)
        result['datum'] = 'CGVD2013'
    elif site['official'] in ('swisstopo-height', 'ign-lidarhd'):
        pts = []
        step = CROP // 4
        for py in range(cy0 + step // 2, cy0 + CROP, step):
            for px in range(cx0 + step // 2, cx0 + CROP, step):
                lat, lon = px_lonlat(tx * SIZE + px + 0.5, ty * SIZE + py + 0.5)
                pts.append((px, py, lat, lon))
        if site['official'] == 'swisstopo-height':
            vals = [ch_height(lat, lon) for _, _, lat, lon in pts]
            result['datum'] = 'LN02'
        else:
            # The product Mapterhorn takes where it exists (frhd*, 0.5 m)…
            vals = ign_heights([(lat, lon) for _, _, lat, lon in pts], IGN_LIDAR_HD)
            result['datum'] = 'NGF-IGN69'
            # …and, for the record, IGN's older RGE ALTI at the same points.
            rge = ign_heights([(lat, lon) for _, _, lat, lon in pts], IGN_RGE_ALTI)
            result['cropVsRgeAlti'] = stats([h[py * SIZE + px] - v for (px, py, _, _), v
                                             in zip(pts, rge) if v is not None])
        diffs = []
        for (px, py, _, _), v in zip(pts, vals):
            if v is None:
                continue
            fixture_points.append([px - cx0, py - cy0, v])
            diffs.append(h[py * SIZE + px] - v)
        result['cropVsOfficial'] = stats(diffs)
    else:
        raise ValueError(f'unknown tool {site["official"]}')

    marks = []
    try:
        if site.get('benchmarks') == 'nrcan':
            marks = nrcan_marks(site['lat'], site['lon'])
        elif site.get('benchmarks') == 'swisstopo':
            marks = swiss_marks(site['lat'], site['lon'])
    except Exception as e:  # the CSRS webapp is slow at times: benchmarks are a bonus
        result['benchmarksError'] = str(e)
    bdiffs, precise, consistent = [], [], 0
    for m in marks:
        try:
            m['dem'] = round(ours.at(m['lat'], m['lon']), 3)
            lo, hi = envelope(ours, m['lat'], m['lon'], max(m['posAccM'], 1.0))
        except Exception as e:  # a tile outside Mapterhorn's z15 coverage
            m['error'] = str(e)
            continue
        m['diff'] = round(m['dem'] - m['h'], 3)
        m['demRange'] = [round(lo, 2), round(hi, 2)]
        # Consistent: the mark's height is a ground height somewhere within its
        # own position uncertainty, give or take the DTM's ±0.5 m.
        m['consistent'] = lo - 0.5 <= m['h'] <= hi + 0.5
        consistent += m['consistent']
        bdiffs.append(m['diff'])
        if m['posAccM'] <= 1.0:
            precise.append(m['diff'])
    result['benchmarks'] = marks
    result['benchmarksVsDem'] = stats(bdiffs)
    result['benchmarksPreciseVsDem'] = stats(precise)
    result['benchmarksConsistent'] = [consistent, len(bdiffs)]
    log(f"{site['id']}: tile {result.get('tileVsOfficial')} crop {result['cropVsOfficial']} "
        f"benchmarks {result['benchmarksVsDem']} precise {result['benchmarksPreciseVsDem']} "
        f"consistent {result['benchmarksConsistent']}")
    fixture = {
        'id': site['id'], 'region': site['region'], 'tool': site['official'],
        'datum': result['datum'], 'tile': result['tile'], 'crop': result['crop'],
        'png': base64.b64encode(crop_png(png, cx0, cy0)).decode(),
        'official': fixture_points,
    }
    return result, fixture


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--sites-file', default=os.path.join(HERE, 'validation-sites.json'))
    ap.add_argument('--sites', help='comma-separated site ids (default: all)')
    ap.add_argument('--report', required=True)
    ap.add_argument('--fixtures')
    a = ap.parse_args()
    sites = json.load(open(a.sites_file))['sites']
    if a.sites:
        keep = set(a.sites.split(','))
        sites = [s for s in sites if s['id'] in keep]
    ours = OurTiles()
    results, fixtures = [], []
    for site in sites:
        r, f = run_site(site, ours, lambda m: print(time.strftime('%T'), m, flush=True))
        results.append(r)
        fixtures.append(f)
    # Sites run now replace their earlier entries; the others are kept (so a
    # slow agency server can be retried site by site), in validation-sites order.
    order = {s['id']: i for i, s in enumerate(json.load(open(a.sites_file))['sites'])}

    def upsert(path, key, fresh, extra):
        old = json.load(open(path))[key] if os.path.exists(path) else []
        ids = {e['id'] for e in fresh}
        merged = [e for e in old if e['id'] not in ids and e['id'] in order] + fresh
        merged.sort(key=lambda e: order[e['id']])
        with open(path, 'w') as fh:
            json.dump({**extra, key: merged}, fh, indent=1, ensure_ascii=False)
            fh.write('\n')

    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    upsert(a.report, 'sites', results, {'generated': now})
    if a.fixtures:
        os.makedirs(a.fixtures, exist_ok=True)
        upsert(os.path.join(a.fixtures, 'validation.json'), 'sites', fixtures,
               {'generated': now, 'cropSize': CROP})


if __name__ == '__main__':
    main()
