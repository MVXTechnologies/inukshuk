"""Raw agency responses → the common station / tidal-benchmark records.

Sign convention (SOURCES.md, CONVERT.md): `CD_in_X` is the height of chart
datum's zero in vertical datum X, so for any level

    H_X = H_CD + CD_in_X          (CD_in_X < 0: CD lies below X's zero)

Station record (one dict; `text` fields are the agency's digits):

    uid, src, id, name, lat, lng, posAccM?, kind (gauge|ref|sec|hist), live?,
    cd (CD kind key, catalog.CD_KINDS), levels [{code, text, value}] above CD,
    high → low; extremes [{code, text, value, date}] above CD;
    national [{datum, text, value}] = CD_in_X as published; ell? (filled by
    derive.py); epoch?, published?, refPort? {id}, url?, flags []

Tidal benchmark record:

    src, station (uid), stationName, cd (CD kind), id, name, lat, lng,
    cdText/cdValue (height above CD as published), date?, alsoMHW?,
    joinKey {src, id | name}, nationalCheck? {datum, value}

Nothing here touches the network; every parser takes the raw files only.
"""
import html as htmlmod
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(HERE, '..', 'geodetic'))  # after ours: geodetic has its own build/catalog
from common import log, norm_id  # noqa: E402


def _f(v):
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if x != x else x


def _txt(value, decimals):
    return f'{value:.{decimals}f}'


def _date8(s):
    """'20121030' → '2012-10-30'."""
    s = (s or '').strip()
    return f'{s[:4]}-{s[4:6]}-{s[6:8]}' if re.fullmatch(r'\d{8}', s) else None


def _mon_d_y(s):
    """'Nov 19 2012' (CO-OPS `accepted`) → '2012-11-19'; anything else → None."""
    import time  # noqa: PLC0415

    try:
        return time.strftime('%Y-%m-%d', time.strptime((s or '').strip(), '%b %d %Y'))
    except ValueError:
        return None


def _station(src, sid, name, lat, lng, **kw):
    rec = {'uid': f'{src}:{sid}', 'src': src, 'id': str(sid), 'name': name, 'lat': round(float(lat), 6),
           'lng': round(float(lng), 6), 'levels': [], 'extremes': [], 'national': [], 'flags': []}
    for k, v in kw.items():
        if v is not None and v != []:
            rec[k] = v
    return rec


# ---------------------------------------------------------------- NOAA CO-OPS

COOPS_TIDAL = ('MHHW', 'MHW', 'DTL', 'MTL', 'MSL', 'MLW', 'MLLW')


def coops_station(meta, datums, live_ids, pred):
    """One CO-OPS station from its mdapi entry + datums.json (metric). None when it has no CD.

    Datums come on the station datum (STND = 0): every level above CD is
    `value − MLLW`, both published to the mm, so the difference is exact to
    the mm. NAVD88 likewise gives CD_in_NAVD88 = MLLW − NAVD88.
    """
    if not datums or datums.get('units') != 'meters':
        return None
    sid = meta['id']
    by = {d['name']: _f(d.get('value')) for d in datums.get('datums') or [] if d.get('name')}
    kind = 'gauge' if sid in live_ids else ('ref' if pred.get(sid, {}).get('type') == 'R'
                                             else 'sec' if sid in pred else 'hist')
    common = dict(
        kind=kind, live='coops' if sid in live_ids else None,
        epoch=(datums.get('epoch') or '').replace('-', '–') or None,
        published=_mon_d_y(datums.get('accepted')),
        refPort={'id': f"us-coops:{pred[sid]['reference_id']}"}
        if pred.get(sid, {}).get('type') == 'S' and pred[sid].get('reference_id') else None,
    )
    if 'GL_LWD' in by and by['GL_LWD'] is not None:
        # Great Lakes: chart datum is the lake's Low Water Datum, a fixed IGLD 1985 height.
        rec = _station('us-coops', sid, meta['name'], meta['lat'], meta['lng'], cd='lwd', **common)
        rec['national'].append({'datum': 'IGLD85', 'value': by['GL_LWD'], 'text': _txt(by['GL_LWD'], 2)})
        return rec
    mllw = by.get('MLLW')
    if mllw is None:
        return None
    rec = _station('us-coops', sid, meta['name'], meta['lat'], meta['lng'], cd='mllw', **common)
    rows = []
    hat, lat = _f(datums.get('HAT')), _f(datums.get('LAT'))
    if hat is not None:
        rows.append(('HAT', hat))
    for code in COOPS_TIDAL:
        if by.get(code) is not None:
            rows.append((code, by[code]))
    if lat is not None:
        rows.append(('LAT', lat))
    for code, v in sorted(rows, key=lambda r: -r[1]):
        above = round(v - mllw, 3)
        rec['levels'].append({'code': code, 'value': above, 'text': _txt(above, 3)})
    for code, key, dkey in (('HOWL', 'max', 'maxdate'), ('LOWL', 'min', 'mindate')):
        v = _f(datums.get(key))
        if v is not None:
            above = round(v - mllw, 3)
            rec['extremes'].append({'code': code, 'value': above, 'text': _txt(above, 3),
                                    'date': _date8(datums.get(dkey))})
    if by.get('NAVD88') is not None:
        cd_in = round(mllw - by['NAVD88'], 3)
        rec['national'].append({'datum': 'NAVD88', 'value': cd_in, 'text': _txt(cd_in, 3)})
    if meta.get('nonNavigational'):
        rec['flags'].append('nonNavigational')
    return rec


_BLOCK = re.compile(
    r'STAMPING:\s*(?P<stamp>[^\n]*?)\s*\n\s*DESIGNATION:\s*(?P<desig>[^\n]*?)\s*\n'
    r'.*?VM#:\s*(?P<vm>\d+)'
    r'.*?IDB PID#:\s*(?P<pid>[A-Z]{2}\d{4})?'
    r'.*?LATITUDE:[^(]*\(\s*(?P<lat>-?\d+\.\d+)\)\s*LONGITUDE:[^(]*\(\s*(?P<lng>-?\d+\.\d+)\)',
    re.S)


def _sheet_text(html):
    t = re.sub(r'<[^>]+>', ' ', html)
    t = htmlmod.unescape(t).replace('\xa0', ' ')
    return re.sub(r'[ \t\r]+', ' ', t)


def parse_coops_sheet(html):
    """A published CO-OPS bench-mark sheet → (meta, [marks]).

    meta: publication date, the sheet's own NAVD88 relation (above MLLW).
    marks: stamping, designation, VM#, PID, lat/lng and the elevations table
    ("Bench Mark Elevation Information In METERS above: MLLW MHW"), matched by
    stamping (or designation when the sheet prints no stamping).
    """
    t = _sheet_text(html)
    meta = {}
    m = re.search(r'PUBLICATION DATE:\s*(\d{2})/(\d{2})/(\d{4})', t)
    if m:
        meta['published'] = f'{m.group(3)}-{m.group(1)}-{m.group(2)}'
    m = re.search(r'NAVD88\s*=\s*(-?\d+\.\d+)', t)
    if m:
        meta['navd88AboveMllw'] = float(m.group(1))
    marks, seen = [], set()
    for b in _BLOCK.finditer(t):
        vm = b.group('vm')
        if vm in seen:
            continue
        seen.add(vm)
        marks.append({'stamping': b.group('stamp').strip(), 'designation': b.group('desig').strip(), 'vm': vm,
                      'pid': b.group('pid'), 'lat': float(b.group('lat')), 'lng': float(b.group('lng'))})
    head = re.search(r'Bench Mark Elevation Information In METERS above:\s*\n\s*Stamping or Designation\s+([A-Z0-9 ]+)\n',
                     t)
    if not head:
        return meta, []
    cols = head.group(1).split()
    rows = {}
    for line in t[head.end():].split('\n'):
        line = line.strip()
        if not line:
            if rows:
                break
            continue
        parts = line.split()
        if len(parts) <= len(cols) or not all(re.fullmatch(r'-?\d+\.\d+', p) for p in parts[-len(cols):]):
            break
        rows[' '.join(parts[:-len(cols)])] = dict(zip(cols, parts[-len(cols):]))
    out = []
    for mk in marks:
        key = mk['stamping'] or mk['designation']
        row = rows.get(key) or rows.get(mk['designation'])
        if not row or 'MLLW' not in row:
            continue
        mk = dict(mk, mllw=row['MLLW'], mhw=row.get('MHW'))
        out.append(mk)
    return meta, out


def normalize_coops(raw):
    def load(name):
        p = os.path.join(raw, name)
        return json.load(open(p))['stations'] if os.path.exists(p) else []

    live = {s['id'] for s in load('stations_waterlevels.json')}
    pred = {s['id']: s for s in load('stations_tidepredictions.json')}
    stations, bms = [], []
    for meta in load('stations_datums.json'):
        p = os.path.join(raw, 'datums', f"{meta['id']}.json")
        if not os.path.exists(p) or os.path.getsize(p) == 0:
            continue
        try:
            datums = json.load(open(p))
        except ValueError:
            continue
        rec = coops_station(meta, datums, live, pred)
        if rec is None:
            continue
        stations.append(rec)
        sp = os.path.join(raw, 'sheets', f"{meta['id']}.html")
        if rec['cd'] != 'mllw' or not os.path.exists(sp) or os.path.getsize(sp) == 0:
            continue
        sheet_meta, marks = parse_coops_sheet(open(sp, encoding='utf-8', errors='replace').read())
        nav = next((n['value'] for n in rec['national'] if n['datum'] == 'NAVD88'), None)
        sheet_nav = sheet_meta.get('navd88AboveMllw')
        for mk in marks:
            if not mk['pid']:
                continue
            bm = {'src': 'us-coops', 'station': rec['uid'], 'stationName': rec['name'], 'cd': 'mllw',
                  'id': mk['pid'], 'name': mk['designation'], 'lat': mk['lat'], 'lng': mk['lng'],
                  'cdText': mk['mllw'], 'cdValue': float(mk['mllw']), 'date': sheet_meta.get('published'),
                  'joinKey': {'src': 'us-ngs', 'id': mk['pid']}}
            if mk.get('mhw'):
                bm['alsoMHW'] = mk['mhw']
            # The sheet's own NAVD88 relation (same epoch as its elevations) wins over today's datums.
            rel = -sheet_nav if sheet_nav is not None else nav
            if rel is not None:
                bm['nationalCheck'] = {'datum': 'NAVD88', 'value': round(float(mk['mllw']) + rel, 3)}
            bms.append(bm)
    return stations, bms


# ---------------------------------------------------------------- SHOM RAM

SHOM_LEVELS = ('phma', 'pmve', 'pmme', 'nm', 'bmme', 'bmve', 'pbma')
SHOM_NATIONAL = {'IGN69': 'IGN69', 'IGN78': 'IGN78'}


def shom_station(p):
    site, zone = (p.get('site') or '').strip(), (p.get('zone') or '').strip()
    if not site or p.get('latitude') is None or p.get('longitude') is None:
        return None
    sid = f'{norm_id(site)}-{norm_id(zone)}'[:64]
    rec = _station('fr-shom', sid, site, p['latitude'], p['longitude'], cd='zh', kind='ref', zone=zone or None)
    rows = [(k.upper(), _f(p.get(k))) for k in SHOM_LEVELS]
    for code, v in sorted([r for r in rows if r[1] is not None], key=lambda r: -r[1]):
        rec['levels'].append({'code': code, 'value': v, 'text': _txt(v, 2)})
    zh_ref, ref = _f(p.get('zh_ref')), (p.get('reference') or '').strip()
    if zh_ref is not None and ref:
        rf_zh, rf_ref = _f(p.get('rf_zh')), _f(p.get('rf_ref'))
        entry = {'datum': SHOM_NATIONAL.get(ref, ref), 'value': zh_ref, 'text': _txt(zh_ref, 3)}
        if rf_zh is not None and rf_ref is not None:
            # SHOM identity on its own reference mark: rf_ref = rf_zh + zh_ref.
            entry['identity'] = round(rf_ref - (rf_zh + zh_ref), 4)
            if abs(entry['identity']) > 0.0015:
                rec['flags'].append('national-inconsistent')
        rec['national'].append(entry)
    if _f(p.get('zh_elli')) is not None:
        rec['ellPublished'] = {'value': _f(p['zh_elli']), 'text': _txt(_f(p['zh_elli']), 3)}
    if p.get('date_ch'):
        rec['published'] = str(p['date_ch'])
    return rec


def normalize_shom(raw):
    feats = json.load(open(os.path.join(raw, 'ram.geojson')))['features']
    stations, bms, seen = [], [], set()
    for f in feats:
        p = f.get('properties') or {}
        rec = shom_station(p)
        if rec is None or rec['uid'] in seen:
            continue
        seen.add(rec['uid'])
        stations.append(rec)
        rf, rf_zh = (p.get('rf') or '').strip(), _f(p.get('rf_zh'))
        if rf and rf_zh is not None and (p.get('organisme') or '').upper() == 'IGN' and 'national-inconsistent' not in rec['flags']:
            bm = {'src': 'fr-shom', 'station': rec['uid'], 'stationName': rec['name'], 'cd': 'zh',
                  'name': rf, 'cdText': _txt(rf_zh, 3), 'cdValue': rf_zh, 'lat': rec['lat'], 'lng': rec['lng'],
                  'date': str(p['date_rf']) if p.get('date_rf') else None,
                  'joinKey': {'src': 'fr-ign', 'name': rf}}
            nat = rec['national'][0] if rec['national'] else None
            if nat is not None:
                bm['nationalCheck'] = {'datum': 'NGF-IGN69' if nat['datum'] == 'IGN69' else nat['datum'],
                                       'value': round(rf_zh + nat['value'], 3)}
            bms.append(bm)
    return stations, bms


# ---------------------------------------------------------------- Kartverket

KV_TIDAL = {'HAT', 'MHWS', 'MHW', 'MHWN', 'MSL', 'MLWN', 'MLW', 'MLWS', 'LAT'}


def _kv_date(info):
    m = re.fullmatch(r'(\d{1,2})\.(\d{1,2})\.(\d{4})', (info or '').strip())
    return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}' if m else None


def kartverket_station(cd_xml, nn_xml=None):
    root = ET.fromstring(cd_xml)
    ll = root.find('locationlevel')
    if ll is None or (ll.get('reflevel') or '').upper() != 'CD' or ll.get('unit') != 'cm':
        return None
    loc = ll.find('location')
    rec = _station('no-kartverket', loc.get('code'), loc.get('name'), loc.get('latitude'), loc.get('longitude'),
                   cd='sjokartnull', kind='gauge', live='kv')
    levels = {r.get('code'): r for r in ll.iter('reflevel')}
    for code, r in sorted(((c, r) for c, r in levels.items() if c in KV_TIDAL),
                          key=lambda cr: -float(cr[1].get('value'))):
        v = round(float(r.get('value')) / 100, 3)
        rec['levels'].append({'code': code, 'value': v, 'text': _txt(v, 3)})
        if code == 'MSL' and r.get('epoch'):
            rec['epoch'] = r.get('epoch').replace('-', '–')
    for code in ('HOWL', 'LOWL'):
        r = levels.get(code)
        if r is not None:
            v = round(float(r.get('value')) / 100, 3)
            rec['extremes'].append({'code': code, 'value': v, 'text': _txt(v, 3), 'date': _kv_date(r.get('info'))})
    nn = levels.get('NN2000')
    if nn is not None:
        cd_in = round(-float(nn.get('value')) / 100, 3)
        entry = {'datum': 'NN2000', 'value': cd_in, 'text': _txt(cd_in, 3)}
        if nn_xml:
            # Kartverket's own NN2000-referenced list must carry CD at the same height.
            nroot = ET.fromstring(nn_xml)
            cd_row = next((r for r in nroot.iter('reflevel') if r.get('code') == 'CD'), None)
            if cd_row is not None:
                entry['identity'] = round(float(cd_row.get('value')) / 100 - cd_in, 4)
                if abs(entry['identity']) > 0.0015:
                    rec['flags'].append('national-inconsistent')
        rec['national'].append(entry)
    if loc.get('landlift'):
        rec['landUpliftCmYr'] = loc.get('landlift')
    return rec


def normalize_kartverket(raw):
    stations = []
    for name in sorted(os.listdir(raw)):
        if not name.endswith('_cd.xml'):
            continue
        code = name[:-len('_cd.xml')]
        nn = os.path.join(raw, f'{code}_nn2000.xml')
        try:
            rec = kartverket_station(open(os.path.join(raw, name), 'rb').read(),
                                     open(nn, 'rb').read() if os.path.exists(nn) else None)
        except ET.ParseError as e:
            log(f'no-kartverket: {code}: {e}')
            continue
        if rec:
            stations.append(rec)
    return stations, []


# ---------------------------------------------------------------- JMA

_JMA_ROW = re.compile(
    r'<tr\s+class="mtx"><td>\d+</td>\s*<td>(?P<code>[A-Z0-9]{2})</td><td><a[^>]*>(?P<name>[^<]+)</a></td>\s*'
    r'<td>(?P<lat>[^<]+)</td>\s*<td>(?P<lng>[^<]+)</td>\s*<td>(?P<msl_dt>[^<]*)</td>\s*<td>(?P<msl_tp>[^<]*)</td>\s*'
    r'<td>(?P<dt_tp>[^<]*)</td>')


def _dm(s):
    m = re.match(r'\s*(\d+)\D+(\d+(?:\.\d+)?)', s)
    return int(m.group(1)) + float(m.group(2)) / 60 if m else None


def _cm(s):
    s = (s or '').strip()
    return float(s) if re.fullmatch(r'-?\d+(\.\d+)?', s) else None


def jma_stations(html):
    out = []
    for m in _JMA_ROW.finditer(html):
        lat, lng = _dm(m.group('lat')), _dm(m.group('lng'))
        msl_dt = _cm(m.group('msl_dt'))
        if lat is None or lng is None or msl_dt is None:
            continue
        rec = _station('jp-jma', m.group('code'), htmlmod.unescape(m.group('name')).strip(), lat, lng,
                       cd='jma-tt', kind='ref', posAccM=1000)
        v = round(msl_dt / 100, 3)
        rec['levels'].append({'code': 'MSL', 'value': v, 'text': _txt(v, 3)})
        dt_tp, msl_tp = _cm(m.group('dt_tp')), _cm(m.group('msl_tp'))
        if dt_tp is not None:
            entry = {'datum': 'JGD2024', 'value': round(dt_tp / 100, 3), 'text': _txt(dt_tp / 100, 3)}
            if msl_tp is not None:
                # MSL − datum (cm) must equal MSL height − datum height (cm), to JMA's 0.1 cm.
                entry['identity'] = round((msl_tp - dt_tp - msl_dt) / 100, 4)
                if abs(entry['identity']) > 0.0015:
                    rec['flags'].append('national-inconsistent')
            rec['national'].append(entry)
        out.append(rec)
    return out


def normalize_jma(raw):
    html = open(os.path.join(raw, 'station.html'), encoding='utf-8', errors='replace').read()
    return jma_stations(html), []


NORMALIZERS = {
    'us-coops': normalize_coops,
    'fr-shom': normalize_shom,
    'no-kartverket': normalize_kartverket,
    'jp-jma': normalize_jma,
}
