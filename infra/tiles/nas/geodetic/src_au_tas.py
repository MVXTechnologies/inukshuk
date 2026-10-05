"""Tasmania — theLIST survey control (SOURCES.md #19).

ArcGIS MapServer Public/OpenDataWFS/40 "LIST Survey Control" (~12,425 marks).
Published: MGA2020 zone 55 E/N with positional uncertainty, a height with its
datum (AHD83 / AHD79 Tasmania, LOCAL, STATE), classes and orders, status and
a description. No lat/lon is published: the display position is the MGA2020
inverse projection (GDA2020, no datum shift), validated in test_src_au.py
against the GDA2020 lat/lon theLIST's own server returns for the same marks.
"""
from common import fnum, log, record
from src_util import arcgis_pages, features, grid, height, monument_from_words, to_wgs84

SRC = 'au-tas'
LAYER = 'https://services.thelist.tas.gov.au/arcgis/rest/services/Public/OpenDataWFS/MapServer/40'
FIELDS = ('OBJECTID,SITE_PK_ID,SCS_NAME,MGA_ZONE,GDA2020_E,GDA2020_N,GDA2020_PU,PU_METHOD,HEIGHT,'
          'HGT_DATUM,HGT_CLASS,HGT_ORDER,HOR_CLASS,HOR_ORDER,TARGET_STR,MARKSTATUS,DESCRIPT')
VDATUM = {'AHD83': 'AHD83 (Tasmania)', 'AHD79': 'AHD79 (Tasmania)', 'LOCAL': 'Local vertical datum'}
STATUS = {'EXISTING': 'ok', 'NOT FOUND': 'notFound', 'RMS ONLY': 'destroyed', 'DESTROYED': 'destroyed'}
TARGET = {'BCN': 'beacon', 'PIL': 'pillar', 'FT': 'flagstaff/target', 'MON': 'monument', 'CRN': 'cairn'}
MONUMENT = (
    (('pillar',), 'pillar'), (('bolt',), 'bolt'), (('pin', 'nail', 'spike'), 'pin'), (('rod', 'bar'), 'rod'),
    (('pipe', 'tube'), 'pipe'), (('plaque', 'disc', 'disk'), 'disk'), (('drill', 'cut', 'cross'), 'cut'),
    (('cairn', 'rock', 'stone'), 'stone'), (('concrete', 'block'), 'block'),
)


def fetch(raw_dir):
    # outSR 7844 = GDA2020 geographic: the server's own conversion, kept for the validation test.
    arcgis_pages(raw_dir, LAYER, FIELDS, page=2000, out_sr=7844, label=SRC)


def mark(a):
    e, n, zone = fnum(a.get('GDA2020_E')), fnum(a.get('GDA2020_N')), a.get('MGA_ZONE')
    sid = (a.get('SITE_PK_ID') or '').strip()
    if e is None or n is None or not zone or not sid:
        return None
    lat, lng = to_wgs84(7800 + int(zone), e, n)  # EPSG:7855 = GDA2020 / MGA zone 55
    pu = fnum(a.get('GDA2020_PU'))
    vd = VDATUM.get((a.get('HGT_DATUM') or '').strip().upper())
    h = height(a.get('HEIGHT'), vd) if vd else None
    hgt_class = (a.get('HGT_CLASS') or '').upper()
    estimated = (a.get('PU_METHOD') or '').lower() == 'estimated'
    type_ = 'v' if hgt_class.startswith('LEV') and estimated else 'h'
    desc = (a.get('DESCRIPT') or '').strip()
    target = TARGET.get((a.get('TARGET_STR') or '').strip().upper())
    text = '; '.join(x for x in (desc, f'target: {target}' if target else '') if x)
    st = (a.get('MARKSTATUS') or '').strip()
    g = grid(f'MGA2020 zone {zone}', a.get('GDA2020_E'), a.get('GDA2020_N'))
    return record(
        SRC, sid, lat, lng, type_, 'gda2020',
        name=(a.get('SCS_NAME') or '').strip() or None,
        aliases=[x for x in {(a.get('SCS_NAME') or '').strip()} if x],
        grids=[g] if g else [],
        posAcc=pu if pu is not None and pu >= 1 else None,
        status=STATUS.get(st.upper(), 'unknown'),
        statusRaw=' · '.join(x for x in (st, f"horizontal {a.get('HOR_CLASS') or ''} {a.get('HOR_ORDER') or ''}".strip(),
                                         f"height {hgt_class} {a.get('HGT_ORDER') or ''}".strip()) if x) or None,
        hOrtho=[h] if h else [],
        monument={'code': monument_from_words(f'{desc} {target or ""}', MONUMENT), 'text': text} if text else None,
        sheet=sid,
    )


def normalize(raw_dir):
    n = 0
    for f in features(raw_dir):
        rec = mark(f.get('attributes') or {})
        if rec:
            n += 1
            yield rec
    log(f'{SRC}: {n} marks')
