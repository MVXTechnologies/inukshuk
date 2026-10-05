"""Per-source fetchers for the tide-station pipeline (../tides.sh).

Every fetcher is polite (sequential, ≥ 1 s between requests to one host),
resumable (a per-file cache younger than CACHE_DAYS is kept) and keeps the
previous copy when a request fails, so a flaky agency never empties a source.

    us-coops       NOAA CO-OPS mdapi (station lists + per-station datums, metric)
                   and the published bench-mark sheets (HTML, elevations above MLLW)
    fr-shom        SHOM RAM (Références Altimétriques Maritimes), one WFS call
    no-kartverket  Kartverket tide API: permanent stations, levels above CD and NN2000
    jp-jma         JMA tide-table station list (one HTML page)

CHS (Canada) is deliberately absent: owner decision PLAN Q1 = c (live-only).
No source here needs an account or a key.
"""
import json
import os
import sys
import time
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(HERE, '..', 'geodetic'))  # after ours: geodetic has its own build/catalog
from common import http_get, log  # noqa: E402

CACHE_DAYS = 25
PAUSE_S = float(os.environ.get('TIDES_PAUSE_S', '1.0'))

COOPS_MD = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi'
COOPS_SHEET = 'https://tidesandcurrents.noaa.gov/benchmarks/{id}.html'
SHOM_RAM = ('https://services.data.shom.fr/INSPIRE/wfs?service=WFS&version=2.0.0&request=GetFeature'
            '&typeNames=RAM_BDD_WLD_WGS84G_WFS:ram_3857&outputFormat=application/json')
KV_API = 'https://vannstand.kartverket.no/tideapi.php'
JMA_STATIONS = 'https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php'


def _fresh(path, days=CACHE_DAYS):
    return os.path.exists(path) and time.time() - os.path.getmtime(path) < days * 86400


def _save(path, body):
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(body)
    os.replace(tmp, path)


def _get_to(url, path, days=CACHE_DAYS, missing_ok=False):
    """GET into `path` unless a fresh copy exists. Returns 'cached'|'fetched'|'missing'|'failed'."""
    if _fresh(path, days):
        return 'cached'
    try:
        body = http_get(url, timeout=120)
    except urllib.error.HTTPError as e:
        if e.code == 404 and missing_ok:
            _save(path, b'')
            return 'missing'
        log(f'{url}: HTTP {e.code}; keeping the previous copy' if os.path.exists(path) else f'{url}: HTTP {e.code}')
        return 'failed'
    except Exception as e:  # noqa: BLE001 — one failed station never stops the source
        log(f'{url}: {e}')
        return 'failed'
    finally:
        time.sleep(PAUSE_S)
    _save(path, body)
    return 'fetched'


def fetch_coops(raw):
    os.makedirs(os.path.join(raw, 'datums'), exist_ok=True)
    os.makedirs(os.path.join(raw, 'sheets'), exist_ok=True)
    for kind in ('datums', 'waterlevels', 'tidepredictions', 'benchmarks'):
        r = _get_to(f'{COOPS_MD}/stations.json?type={kind}', os.path.join(raw, f'stations_{kind}.json'), days=6)
        log(f'us-coops: station list {kind}: {r}')
    stations = json.load(open(os.path.join(raw, 'stations_datums.json')))['stations']
    with_bm = {s['id'] for s in json.load(open(os.path.join(raw, 'stations_benchmarks.json')))['stations']}
    counts = {}
    for n, s in enumerate(stations):
        sid = s['id']
        r = _get_to(f'{COOPS_MD}/stations/{sid}/datums.json?units=metric', os.path.join(raw, 'datums', f'{sid}.json'))
        counts[r] = counts.get(r, 0) + 1
        if sid in with_bm:
            r2 = _get_to(COOPS_SHEET.format(id=sid), os.path.join(raw, 'sheets', f'{sid}.html'), missing_ok=True)
            counts['sheet-' + r2] = counts.get('sheet-' + r2, 0) + 1
        if n % 200 == 0:
            log(f'us-coops: {n}/{len(stations)} {counts}')
    log(f'us-coops: done {counts}')


def fetch_shom(raw):
    os.makedirs(raw, exist_ok=True)
    log('fr-shom: RAM', _get_to(SHOM_RAM, os.path.join(raw, 'ram.geojson'), days=6))


def fetch_kartverket(raw):
    os.makedirs(raw, exist_ok=True)
    r = _get_to(f'{KV_API}?tide_request=stationlist&type=perm&lang=en', os.path.join(raw, 'stations.xml'), days=6)
    log(f'no-kartverket: station list {r}')
    import xml.etree.ElementTree as ET  # noqa: PLC0415

    for loc in ET.parse(os.path.join(raw, 'stations.xml')).getroot().iter('location'):
        code = loc.get('code')
        for ref in ('cd', 'nn2000'):
            _get_to(f'{KV_API}?tide_request=stationlevels&stationcode={code}&refcode={ref}&lang=en',
                    os.path.join(raw, f'{code}_{ref}.xml'))
    log('no-kartverket: done')


def fetch_jma(raw):
    os.makedirs(raw, exist_ok=True)
    log('jp-jma: stations', _get_to(JMA_STATIONS, os.path.join(raw, 'station.html'), days=6))


FETCHERS = {
    'us-coops': fetch_coops,
    'fr-shom': fetch_shom,
    'no-kartverket': fetch_kartverket,
    'jp-jma': fetch_jma,
}
