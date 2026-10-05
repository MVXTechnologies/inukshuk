"""USA — NOAA NGS datasheet archive shapefiles (SOURCES.md #3).

One zip per state / territory / neighbouring province, rebuilt monthly:
geodesy.noaa.gov/pub/DS_ARCHIVE/ShapeFiles/{ST}.zip (~150 MB in all).
"""
import os
import re
import zipfile

from common import download, fnum, http_get, log, read_shapefile, record

SRC = 'us-ngs'
BASE = 'https://geodesy.noaa.gov/pub/DS_ARCHIVE/ShapeFiles/'
STATUS = {
    'GOOD': 'ok', 'MONUMENTED': 'ok', 'FIRST OBSERVED': 'ok', 'SEE DESCRIPTION': 'unknown',
    'POOR': 'damaged', 'MARK NOT FOUND': 'notFound', 'NOT FOUND': 'notFound',
    'DESTROYED': 'destroyed', '': 'unknown',
}
# POS_SRCE → how far our displayed position can be off, in metres (None = precise).
POS_ACC = {'SCALED': 30.0, 'HD_HELD1': 5.0, 'HD_HELD2': 10.0, 'NO CHECK': 10.0}
VDATUM = {
    'NAVD 88': 'NAVD88', 'NGVD 29': 'NGVD29', 'PRVD02': 'PRVD02', 'GUVD04': 'GUVD04',
    'ASVD02': 'ASVD02', 'NMVD03': 'NMVD03', 'VIVD09': 'VIVD09', 'IGLD 85': 'IGLD85',
    'LOCAL TIDAL': 'Chart datum (local tidal)', 'MLLW': 'Chart datum (local tidal)',
}
# MARKER code prefixes → monument code.
MARKER = (
    (('DB', 'DD', 'DV', 'DS', 'DR', 'DT', 'DZ', 'DO', 'DE', 'DH', 'DJ', 'DA'), 'disk'),
    (('B',), 'bolt'), (('R', 'L'), 'pin'), (('F', 'I', 'SR'), 'rod'), (('P',), 'pipe'),
    (('X', 'C'), 'cut'), (('M', '71'), 'stone'), (('A', 'SA'), 'antenna'),
    (('ST', 'T', 'Z'), 'structure'),
)


def states():
    html = http_get(BASE).decode('utf-8', 'replace')
    return sorted(set(re.findall(r'href="([A-Z]{2})\.zip"', html)))


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    for st in states():
        zpath = os.path.join(raw_dir, f'{st}.zip')
        changed = download(BASE + f'{st}.zip', zpath)
        out = os.path.join(raw_dir, st)
        if changed or not os.path.isdir(out):
            os.makedirs(out, exist_ok=True)
            with zipfile.ZipFile(zpath) as z:
                for name in z.namelist():
                    if name.lower().endswith(('.dbf', '.shp')):
                        with z.open(name) as src, open(os.path.join(out, os.path.basename(name)), 'wb') as dst:
                            dst.write(src.read())
        log(f'{SRC}: {st} {"updated" if changed else "unchanged"}')


def datum_of(pos_datum, tag):
    pos_datum, tag = pos_datum.upper(), tag.upper()
    if 'NAD 27' in pos_datum or 'NAD27' in pos_datum:
        return 'nad27'
    if 'MA11' in tag:
        return 'nad83-ma11'
    if 'PA11' in tag:
        return 'nad83-pa11'
    if '2011' in tag:
        return 'nad83-2011'
    if '2007' in tag:
        return 'nad83-2007'
    if '1986' in tag:
        return 'nad83-1986'
    if 'NAD 83' in pos_datum or 'NAD83' in pos_datum:
        return 'nad83-harn'
    return 'wgs84'


def _code(text):
    head = text.split('=')[0].strip().upper()
    for prefixes, code in MARKER:
        if head in prefixes:
            return code
    return 'other'


def _words(s):
    """'DD = SURVEY DISK' → 'Survey disk' (the agency's words, sentence case)."""
    s = s.split('=', 1)[-1].strip()
    return s[:1].upper() + s[1:].lower() if s else ''


def monument_of(marker, setting):
    if not marker:
        return None
    text = _words(marker)
    if setting:
        text += ', ' + _words(setting)[:1].lower() + _words(setting)[1:]
    return {'code': _code(marker), 'text': text}


def _date(s):
    s = (s or '').strip()
    if re.fullmatch(r'\d{8}', s):
        return f'{s[:4]}-{s[4:6]}-{s[6:]}'
    if re.fullmatch(r'\d{4}', s):
        return s
    return None


def _squash(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def published_geo(r):
    """NGS's own LATITUDE / LONGITUDE text, e.g. '43 57 56. (N), 073 07 00. (W)'."""
    la, lo = _squash(r.get('LATITUDE')), _squash(r.get('LONGITUDE'))
    return f'{la}, {lo}' if la and lo else None


def published_grids(r):
    """State Plane and UTM as NGS publishes them (metres, verbatim digits)."""
    out = []
    zone, n, e = _squash(r.get('SPC_ZONE')), _squash(r.get('SPC_NORTH')), _squash(r.get('SPC_EAST'))
    if zone and n and e:
        out.append({'system': f'SPC {zone}', 'n': n, 'e': e})
    zone, n, e = _squash(r.get('UTM_ZONE')), _squash(r.get('UTM_NORTH')), _squash(r.get('UTM_EAST'))
    if zone and n and e:
        out.append({'system': f'UTM zone {zone}', 'n': n, 'e': e})
    return out or None


def row_to_record(r):
    """One NGS shapefile row → build record (None for a row without a PID or position)."""
    lat, lng = fnum(r.get('DEC_LAT')), fnum(r.get('DEC_LON'))
    if lat is None or lng is None or not r.get('PID'):
        return None
    pos_src = (r.get('POS_SRCE') or '').upper()
    datum = datum_of(r.get('POS_DATUM') or '', r.get('DATUM_TAG') or '')
    ell = fnum(r.get('ELLIP_HT'))
    h_ortho = []
    ortho = fnum(r.get('ORTHO_HT'))
    vsrc = (r.get('VERT_SRCE') or '').upper()
    vd = VDATUM.get((r.get('VERT_DATUM') or '').upper())
    if ortho is not None and vd and vsrc not in ('SCALED', ''):
        h_ortho.append({'value': ortho, 'text': r['ORTHO_HT'].strip(), 'datum': vd})
    if r.get('CORS_ID'):
        type_ = 'gnss'
    elif pos_src == 'ADJUSTED' and ell is not None:
        type_ = '3d'
    elif pos_src == 'ADJUSTED':
        type_ = 'h'
    elif h_ortho:
        type_ = 'v'
    else:
        type_ = 'u'
    cond = (r.get('LAST_COND') or '').upper()
    return record(
        SRC, r['PID'], lat, lng, type_, datum,
        name=(r.get('NAME') or '').strip() or None,
        aliases=[a for a in {(r.get('NAME') or '').strip(), (r.get('CORS_ID') or '').strip()} if a],
        posAcc=POS_ACC.get(pos_src),
        status=STATUS.get(cond, 'unknown'),
        statusRaw=cond or None,
        hEll=ell,
        hEllText=r['ELLIP_HT'].strip() if ell is not None else None,
        hOrtho=h_ortho,
        geo=published_geo(r),
        grids=published_grids(r),
        monument=monument_of(r.get('MARKER') or '', r.get('SETTING') or ''),
        lastVisit=_date(r.get('LAST_RECV')),
        sheet=r['PID'],
    )


def normalize(raw_dir):
    for st in sorted(os.listdir(raw_dir)):
        d = os.path.join(raw_dir, st)
        if not os.path.isdir(d):
            continue
        shp = [n for n in os.listdir(d) if n.lower().endswith('.shp')]
        if not shp:
            continue
        for r, _xy in read_shapefile(os.path.join(d, shp[0][:-4]), 'latin1'):
            rec = row_to_record(r)
            if rec is not None:
                yield rec
