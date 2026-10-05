"""South Australia — survey marks (SOURCES.md #18).

One zipped shapefile from the state's data portal (data.sa.gov.au →
dptiapps.com.au/dataportal/SurveyMarks_shp.zip, ~39 MB, CC BY 3.0 AU), GDA2020
layer, ~193k marks (~30k flagged gone). Published: GDA2020 lat/lon, MGA2020
E/N + zone, a height with its vertical datum code, horizontal fixing method,
order, positional uncertainty, gone flag.

The DBF stores numbers as doubles, so values carry float noise
(-34.915806269999997); they are rounded back to the published precision
(lat/lon 9 decimals, E/N and heights 3) before being shown. Heights are
labelled AHD only where v_datum = 'A'; other codes are not guessed.
Positions fixed by scaling (SCA) or digitising (DIG) are approximate.
"""
import os
import zipfile

from common import download, fnum, log, read_shapefile, record
from src_util import grid, height, text_of

SRC = 'au-sa'
URL = 'https://www.dptiapps.com.au/dataportal/SurveyMarks_shp.zip'
BASE = 'SurveyMarks_GDA2020'
GNSS_FIX = ('GPR', 'GPH', 'PPP', 'RTK', 'GPS', 'GNS')
APPROX_FIX = {'SCA': 30.0, 'DIG': 10.0}


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    zpath = os.path.join(raw_dir, 'SurveyMarks_shp.zip')
    changed = download(URL, zpath)
    if changed or not os.path.exists(os.path.join(raw_dir, BASE + '.dbf')):
        with zipfile.ZipFile(zpath) as z:
            for ext in ('.dbf', '.shp', '.shx', '.prj'):
                with z.open(BASE + ext) as src, open(os.path.join(raw_dir, BASE + ext), 'wb') as dst:
                    while True:
                        chunk = src.read(1 << 20)
                        if not chunk:
                            break
                        dst.write(chunk)
    log(f'{SRC}: {"updated" if changed else "unchanged"}')


def _round_text(v, places):
    x = fnum(v)
    return None if x is None else text_of(round(x, places))


def mark(r):
    lat, lng = fnum(r.get('latitude')), fnum(r.get('longitude'))
    mid = (r.get('mark_no') or '').strip()
    if lat is None or lng is None or not mid:
        return None
    lat, lng = round(lat, 9), round(lng, 9)
    fix = (r.get('h_fixing') or '').strip().upper()
    v_datum = (r.get('v_datum') or '').strip().upper()
    h = height(_round_text(r.get('height'), 3), 'AHD') if v_datum == 'A' else None
    precise = fix not in APPROX_FIX and fix != ''
    if fix in GNSS_FIX and h:
        type_ = '3d'
    elif precise:
        type_ = 'h'
    elif h:
        type_ = 'v'
    else:
        type_ = 'u'
    unc = fnum(r.get('h_position'))
    pos_acc = APPROX_FIX.get(fix) or (unc if unc is not None and unc >= 1 else None)
    zone = fnum(r.get('zone'))
    g = grid(f'MGA2020 zone {int(zone)}', _round_text(r.get('easting'), 3), _round_text(r.get('northing'), 3)) \
        if zone else None
    gone = (r.get('gone') or '').strip().upper() == 'Y'
    return record(
        SRC, mid, lat, lng, type_, 'gda2020',
        geo=f'{text_of(lat)}, {text_of(lng)}',
        grids=[g] if g else [],
        posAcc=pos_acc,
        status='destroyed' if gone else 'unknown',
        statusRaw=' · '.join(x for x in (
            f"type {r.get('marktype')}" if r.get('marktype') else '',
            f'fixed by {fix}' if fix else '',
            f"order {r.get('h_order')}" if (r.get('h_order') or '').strip('*') else '') if x) or None,
        hOrtho=[h] if h else [],
        sheet=mid,
    )


def normalize(raw_dir):
    n = 0
    for r, _xy in read_shapefile(os.path.join(raw_dir, BASE), 'latin1'):
        if (r.get('public') or 'Y').strip().upper() != 'Y':
            continue
        rec = mark(r)
        if rec:
            n += 1
            yield rec
    log(f'{SRC}: {n} marks')
