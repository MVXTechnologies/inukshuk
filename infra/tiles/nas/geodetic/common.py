"""Shared helpers for the geodetic-points pipeline (../geodetic.sh).

Standard library only, so every module also runs on a bare python3; the
pipeline's container (Dockerfile) adds pypdf for the Québec datasheets and
certifi for the CA roots the NAS's own bundle lacks (Québec's servers chain
to Sectigo R46).

The build record (DESIGN.md §2.1) is a plain dict:

    uid, src, id, name?, aliases[], lat, lng, posAcc?, type (3d|h|v|gnss|u),
    datum (key into datums.DATUMS), hEll?, hOrtho [{value, datum}], monument
    {code, text}?, status (ok|damaged|notFound|destroyed|unknown), statusRaw,
    lastVisit (YYYY-MM-DD)?, sheet?
"""
import email.utils
import gzip
import json
import math
import os
import ssl
import struct
import sys
import time
import urllib.error
import urllib.request

USER_AGENT = (
    'InukshukGeodetic/1 (+https://inukshuk.mvxtechnologies.com; '
    'marc-andre.vigneault@mvxtechnologies.com)'
)
TYPES = ('3d', 'h', 'v', 'gnss', 'u')
STATUSES = ('ok', 'damaged', 'destroyed', 'notFound', 'unknown')
# Tile record `c` (DESIGN.md §2.2).
STATUS_CODE = {'ok': 0, 'damaged': 1, 'destroyed': 2, 'notFound': 3, 'unknown': 4}
MONUMENTS = (
    'disk', 'bolt', 'pillar', 'rod', 'pipe', 'stone', 'block', 'cut', 'pin',
    'structure', 'antenna', 'other',
)


def log(*args):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *args, file=sys.stderr, flush=True)


def ssl_context():
    try:
        import certifi  # noqa: PLC0415 — optional, present in the pipeline image

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_CTX = None


def http_get(url, timeout=120, data=None, headers=None, retries=4, pause=5.0):
    """GET (or POST with `data`) → bytes, retried with backoff on network/5xx errors."""
    global _CTX
    if _CTX is None:
        _CTX = ssl_context()
    hdrs = {'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip'}
    hdrs.update(headers or {})
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
                body = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    body = gzip.decompress(body)
                return body
        except urllib.error.HTTPError as e:
            last = e
            if e.code < 500 and e.code != 429:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = e
        time.sleep(pause * (2 ** attempt))
    raise RuntimeError(f'{url}: {last}')


def download(url, path, timeout=600):
    """Conditional GET into `path` (Last-Modified / ETag kept in `path.meta.json`).

    Returns True when the file changed. A failed fetch with a previous copy on
    disk keeps that copy (last-good fallback) and returns False.
    """
    global _CTX
    if _CTX is None:
        _CTX = ssl_context()
    meta_path = path + '.meta.json'
    meta = {}
    if os.path.exists(path) and os.path.exists(meta_path):
        meta = json.load(open(meta_path))
    headers = {'User-Agent': USER_AGENT}
    if meta.get('etag'):
        headers['If-None-Match'] = meta['etag']
    if meta.get('lastModified'):
        headers['If-Modified-Since'] = meta['lastModified']
    req = urllib.request.Request(url, headers=headers)
    tmp = path + '.part'
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r, open(tmp, 'wb') as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
            new_meta = {'etag': r.headers.get('ETag'), 'lastModified': r.headers.get('Last-Modified'),
                        'url': url, 'fetched': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        os.replace(tmp, path)
        json.dump(new_meta, open(meta_path, 'w'))
        return True
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return False
        if os.path.exists(path):
            log(f'{url}: HTTP {e.code}; keeping the previous copy')
            return False
        raise
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        if os.path.exists(path):
            log(f'{url}: {e}; keeping the previous copy')
            return False
        raise


def resumable(path, max_age_days=20):
    """True when an interrupted fetch may keep `path`: GEODETIC_RESUME=1 and
    the file is from this cycle (younger than `max_age_days`), so a resumed
    run never keeps last month's answers forever."""
    return (os.environ.get('GEODETIC_RESUME') == '1' and os.path.exists(path)
            and time.time() - os.path.getmtime(path) < max_age_days * 86400)


def http_date(path):
    """The Last-Modified of a downloaded file as YYYY-MM-DD, or None."""
    try:
        lm = json.load(open(path + '.meta.json')).get('lastModified')
        return time.strftime('%Y-%m-%d', email.utils.parsedate(lm)) if lm else None
    except (OSError, ValueError, TypeError):
        return None


# ---------- Shapefile (points) + DBF, no GDAL needed ----------

def read_dbf(path, encoding='cp1252'):
    """Yield each DBF record as {field: stripped str} (deleted records skipped)."""
    with open(path, 'rb') as f:
        b = f.read()
    n, header_len, rec_len = struct.unpack('<IHH', b[4:12])
    fields, i = [], 32
    while b[i] != 0x0D:
        name = b[i:i + 11].split(b'\0')[0].decode('ascii')
        fields.append((name, b[i + 16]))
        i += 32
    for k in range(n):
        o = header_len + k * rec_len
        if b[o] == 0x2A:  # '*' = deleted
            yield None
            continue
        p, row = o + 1, {}
        for name, length in fields:
            row[name] = b[p:p + length].decode(encoding, 'replace').strip()
            p += length
        yield row


def read_shp_points(path):
    """Yield (x, y) per record of a Point/PointZ/PointM shapefile (None for null shapes)."""
    with open(path, 'rb') as f:
        b = f.read()
    o = 100
    while o + 8 <= len(b):
        _, content_len = struct.unpack('>ii', b[o:o + 8])
        shape_type = struct.unpack('<i', b[o + 8:o + 12])[0]
        if shape_type in (1, 11, 21):
            yield struct.unpack('<dd', b[o + 12:o + 28])
        else:
            yield None
        o += 8 + content_len * 2


def read_shapefile(base, encoding='cp1252'):
    """Yield (row, (x, y)) for every live record of `base`.shp/.dbf."""
    for row, xy in zip(read_dbf(base + '.dbf', encoding), read_shp_points(base + '.shp')):
        if row is not None and xy is not None:
            yield row, xy


# ---------- Geometry ----------

def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def lcc_inverse(x, y, lat0, lon0, sp1, sp2, fe=0.0, fn=0.0, a=6378137.0, f=1 / 298.257222101):
    """Lambert Conformal Conic (2SP) inverse on an ellipsoid (GRS80 by default) → (lat, lon)."""
    e = math.sqrt(f * (2 - f))

    def m(phi):
        return math.cos(phi) / math.sqrt(1 - (e * math.sin(phi)) ** 2)

    def t(phi):
        s = e * math.sin(phi)
        return math.tan(math.pi / 4 - phi / 2) / ((1 - s) / (1 + s)) ** (e / 2)

    p0, p1, p2 = map(math.radians, (lat0, sp1, sp2))
    n = (math.log(m(p1)) - math.log(m(p2))) / (math.log(t(p1)) - math.log(t(p2)))
    big_f = m(p1) / (n * t(p1) ** n)
    r0 = a * big_f * t(p0) ** n
    dx, dy = x - fe, r0 - (y - fn)
    r = math.copysign(math.hypot(dx, dy), n)
    tt = (r / (a * big_f)) ** (1 / n)
    theta = math.atan2(dx, dy) if n > 0 else math.atan2(-dx, -dy)
    lon = math.degrees(theta / n) + lon0
    phi = math.pi / 2 - 2 * math.atan(tt)
    for _ in range(15):
        s = e * math.sin(phi)
        nxt = math.pi / 2 - 2 * math.atan(tt * ((1 - s) / (1 + s)) ** (e / 2))
        if abs(nxt - phi) < 1e-13:
            phi = nxt
            break
        phi = nxt
    return math.degrees(phi), lon


# ---------- Records ----------

def norm_id(s):
    """Uppercase, no spaces/dashes/dots: the ID-equivalence key (DESIGN.md §4)."""
    return ''.join(ch for ch in str(s).upper() if ch.isalnum())


def fnum(s):
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return None if isinstance(s, float) and math.isnan(s) else float(s)
    s = str(s).strip().replace(' ', '').replace(' ', '').replace(',', '.')
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def record(src, ident, lat, lng, type_, datum, **kw):
    """A build record with the required fields; `kw` adds the optional ones (None dropped)."""
    rec = {
        'uid': f'{src}:{ident}',
        'src': src,
        'id': str(ident),
        'lat': round(float(lat), 8),
        'lng': round(float(lng), 8),
        'type': type_,
        'datum': datum,
        'hOrtho': [],
        'aliases': [],
        'status': 'ok',
    }
    for k, v in kw.items():
        if v is None or v == '' or v == []:
            continue
        rec[k] = v
    return rec


def valid_position(lat, lng):
    return (lat is not None and lng is not None and -90 <= lat <= 90 and -180 <= lng <= 180
            and not (abs(lat) < 1e-9 and abs(lng) < 1e-9))


def write_ndjson(path, records):
    tmp = path + '.tmp'
    n = 0
    with open(tmp, 'w', encoding='utf-8') as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n')
            n += 1
    os.replace(tmp, path)
    return n


def read_ndjson(path):
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)
