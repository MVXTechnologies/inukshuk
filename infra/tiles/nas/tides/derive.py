"""Chart datum as an ellipsoidal height (the levels table's third column), with
an independent check for every value we show.

Field rule (owner, 2026-10-05): every displayed number is the agency's
published one; a derived number is shown ONLY where an agency oracle confirms
it within tolerance, otherwise it is hidden (never guessed).

| Source | Shown value | How | Oracle (must agree ≤ TOL_M) |
|---|---|---|---|
| us-coops | derived | CD_in_NAVD88 (CO-OPS) + GEOID18 N | NOAA VDatum MLLW → NAD83(2011) h at the gauge |
| fr-shom | published `zh_elli` | SHOM RAM | zh_ref (IGN69) + RAF20 N (IGN's grid) |
| no-kartverket | derived | CD_in_NN2000 (Kartverket) + HREF2018B N | Kartverket's CD-above-ellipsoid grid v2023b |
| jp-jma | — | no open oracle | (hidden) |

Pinned PROJ pipelines (forward = orthometric H → ellipsoidal h, multiplier 1);
the same strings as research/validation/reference_points.json, where they
reproduce the agencies' values. PROJ fetches the grids from cdn.proj.org
(PROJ_NETWORK=ON) and caches them under PROJ_USER_WRITABLE_DIRECTORY.
"""
import json
import os
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(HERE, '..', 'geodetic'))  # after ours: geodetic has its own build/catalog
from common import http_get, log  # noqa: E402

TOL_M = 0.05

GRIDS = {
    'GEOID18': 'us_noaa_g2018u0.tif',
    'RAF20': 'fr_ign_RAF20.tif',
    'HREF2018B': 'no_kv_HREF2018B_NN2000_EUREF89.tif',
    'NO_CD_2023B': 'no_kv_CD_above_Ell_ETRS89_v2023b.tif',
}


def pipeline(grid):
    return ('+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad '
            f'+step +proj=vgridshift +grids={grid} +multiplier=1 '
            '+step +proj=unitconvert +xy_in=rad +xy_out=deg')


class Geoid:
    """grid value at (lon, lat) through the pinned pipeline; None outside the grid."""

    def __init__(self):
        os.environ.setdefault('PROJ_NETWORK', 'ON')
        from pyproj import Transformer  # noqa: PLC0415 — only on the NAS image
        from pyproj import network  # noqa: PLC0415

        network.set_network_enabled(True)
        self._t = {name: Transformer.from_pipeline(pipeline(g)) for name, g in GRIDS.items()}

    def __call__(self, name, lon, lat, h=0.0):
        try:
            _, _, z = self._t[name].transform(lon, lat, h, errcheck=True)
        except Exception:  # noqa: BLE001 — outside the grid / no data
            return None
        return None if z != z or abs(z) > 1e4 else z


# ---------------------------------------------------------------- VDatum (NOAA's own oracle)

VDATUM = 'https://vdatum.noaa.gov/vdatumweb/api/convert'
NUDGES = [(0, 0), (0.002, 0), (-0.002, 0), (0, 0.002), (0, -0.002), (0.005, 0), (-0.005, 0), (0, 0.005), (0, -0.005)]


def vdatum_query(lon, lat):
    q = {'s_x': f'{lon:.6f}', 's_y': f'{lat:.6f}', 's_z': 0, 'region': 'contiguous', 's_h_frame': 'NAD83_2011',
         's_coor': 'geo', 's_v_frame': 'MLLW', 's_v_unit': 'm', 's_v_elevation': 'height',
         't_h_frame': 'NAD83_2011', 't_coor': 'geo', 't_v_frame': 'NAD83_2011', 't_v_unit': 'm',
         't_v_elevation': 'height', 's_v_geoid': 'geoid18', 't_v_geoid': 'geoid18'}
    return f'{VDATUM}?{urllib.parse.urlencode(q)}'


def vdatum_value(body):
    """VDatum JSON → (h of MLLW, uncertainty) or None (error, no data)."""
    try:
        d = json.loads(body)
        z = float(d['t_z'])
    except (ValueError, KeyError, TypeError):
        return None
    if z <= -999:
        return None
    try:
        unc = float(d.get('uncertainty'))
    except (TypeError, ValueError):
        unc = None
    return z, unc


def vdatum_lookup(cache_dir, sid, lon, lat, pause=1.0):
    """MLLW → NAD83(2011) h at the gauge (nudged ≤ 0.005° to reach water). Cached per station."""
    path = os.path.join(cache_dir, f'{sid}.json')
    if os.path.exists(path):
        c = json.load(open(path))
        if c.get('at') == [round(lon, 6), round(lat, 6)]:
            return c.get('result')
    result = None
    for dx, dy in NUDGES:
        try:
            body = http_get(vdatum_query(lon + dx, lat + dy), timeout=90, retries=2, pause=3)
        except Exception as e:  # noqa: BLE001
            body = str(e).encode()
        time.sleep(pause)
        v = vdatum_value(body)
        if v is not None:
            result = {'h': v[0], 'unc': v[1], 'nudge': [dx, dy]}
            break
    os.makedirs(cache_dir, exist_ok=True)
    json.dump({'at': [round(lon, 6), round(lat, 6)], 'result': result, 'checked': time.strftime('%Y-%m-%d')},
              open(path, 'w'))
    return result


# ---------------------------------------------------------------- per source

def _national(rec, datum):
    return next((n for n in rec['national'] if n['datum'] == datum), None)


def _check(rec, value, oracle, oracle_value, extra=None):
    delta = round(value - oracle_value, 4)
    c = {'station': rec['uid'], 'name': rec['name'], 'value': round(value, 4), 'oracle': oracle,
         'oracleValue': round(oracle_value, 4), 'delta': delta, 'pass': abs(delta) <= TOL_M}
    if extra:
        c.update(extra)
    return c


def derive_coops(rec, geoid, vdatum):
    """(ell | None, check | None). `vdatum(rec)` → {'h', 'unc'} or None."""
    nav = _national(rec, 'NAVD88')
    if rec.get('cd') != 'mllw' or nav is None:
        return None, None
    n = geoid('GEOID18', rec['lng'], rec['lat'])
    if n is None:
        return None, None
    value = nav['value'] + n
    oracle = vdatum(rec)
    if oracle is None:
        return None, {'station': rec['uid'], 'name': rec['name'], 'value': round(value, 4),
                      'oracle': 'VDatum', 'pass': None, 'reason': 'no VDatum value at the gauge'}
    check = _check(rec, value, 'VDatum MLLW→NAD83(2011)', oracle['h'],
                   {'oracleUnc': oracle.get('unc'), 'geoidN': round(n, 4)})
    if not check['pass']:
        return None, check
    ell = {'value': round(value, 3), 'text': f'{value:.2f}', 'frame': 'NAD83(2011)', 'epoch': '2010.0',
           'how': 'derived', 'basis': 'CO-OPS NAVD88 offset + NGS GEOID18',
           'checkedBy': 'NOAA VDatum', 'deltaM': check['delta']}
    return ell, check


def derive_shom(rec, geoid):
    pub = rec.get('ellPublished')
    nat = _national(rec, 'IGN69')
    if pub is None:
        return None, None
    if nat is None or 'national-inconsistent' in rec['flags']:
        return None, {'station': rec['uid'], 'name': rec['name'], 'value': pub['value'], 'oracle': 'RAF20',
                      'pass': None, 'reason': 'no IGN69 ZH to check against (overseas or no reference)'}
    n = geoid('RAF20', rec['lng'], rec['lat'])
    if n is None:
        return None, {'station': rec['uid'], 'name': rec['name'], 'value': pub['value'], 'oracle': 'RAF20',
                      'pass': None, 'reason': 'outside the RAF20 grid'}
    check = _check(rec, pub['value'], 'zh_ref (IGN69) + IGN RAF20', nat['value'] + n, {'geoidN': round(n, 4)})
    if not check['pass']:
        return None, check
    ell = {'value': pub['value'], 'text': pub['text'], 'frame': 'RGF93 (GRS80)', 'epoch': None,
           'how': 'published', 'basis': 'SHOM RAM zh_elli', 'checkedBy': 'IGN RAF20',
           'deltaM': check['delta']}
    return ell, check


def derive_kartverket(rec, geoid):
    nat = _national(rec, 'NN2000')
    if nat is None or 'national-inconsistent' in rec['flags']:
        return None, None
    n = geoid('HREF2018B', rec['lng'], rec['lat'])
    grid = geoid('NO_CD_2023B', rec['lng'], rec['lat'])
    if n is None or grid is None:
        return None, {'station': rec['uid'], 'name': rec['name'], 'oracle': 'Kartverket CD grid',
                      'pass': None, 'reason': 'outside HREF2018B / CD grid'}
    value = nat['value'] + n
    check = _check(rec, value, 'Kartverket CD grid v2023b', grid, {'geoidN': round(n, 4)})
    if not check['pass']:
        return None, check
    ell = {'value': round(value, 3), 'text': f'{value:.2f}', 'frame': 'EUREF89 (ETRS89)', 'epoch': None,
           'how': 'derived', 'basis': 'Kartverket NN2000 offset + HREF2018B',
           'checkedBy': 'Kartverket CD model v2023b', 'deltaM': check['delta']}
    return ell, check


def derive_all(stations, geoid, vdatum):
    """Fill `ell` in place; returns the list of checks (the validation table rows)."""
    checks = []
    for rec in stations:
        if rec['src'] == 'us-coops':
            ell, check = derive_coops(rec, geoid, vdatum)
        elif rec['src'] == 'fr-shom':
            ell, check = derive_shom(rec, geoid)
        elif rec['src'] == 'no-kartverket':
            ell, check = derive_kartverket(rec, geoid)
        else:
            ell, check = None, None
        rec.pop('ellPublished', None)
        if ell is not None:
            rec['ell'] = ell
        if check is not None:
            checks.append(check)
    return checks


def summarize(checks):
    """Per oracle: n checked, pass, fail, unchecked, max |Δ|, median |Δ|."""
    out = {}
    for c in checks:
        key = c['station'].split(':')[0]
        s = out.setdefault(key, {'oracle': c['oracle'], 'checked': 0, 'pass': 0, 'fail': 0, 'unchecked': 0,
                                 'maxAbsDeltaM': 0.0, 'deltas': []})
        if c.get('pass') is None:
            s['unchecked'] += 1
            continue
        s['checked'] += 1
        s['pass' if c['pass'] else 'fail'] += 1
        s['deltas'].append((abs(c['delta']), c['pass']))
    for s in out.values():
        d = sorted(s.pop('deltas'))
        s['maxAbsDeltaM'] = round(d[-1][0], 4) if d else None
        s['medianAbsDeltaM'] = round(d[len(d) // 2][0], 4) if d else None
        shown = [x for x, ok in d if ok]
        # The worst deviation among the values the app actually shows.
        s['maxAbsDeltaShownM'] = round(shown[-1], 4) if shown else None
    return out


if __name__ == '__main__':
    log('derive.py is a library; see build.py')
