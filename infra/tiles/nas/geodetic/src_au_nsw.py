"""New South Wales — Spatial Services SCIMS survey marks (SOURCES.md #15).

ArcGIS FeatureServer `SurveyMarkGDA2020/0` (~282k marks), 2,000 per page.
Published per mark: GDA2020 lat/lon (full precision), MGA2020 E/N (to the
metre), AHD height (the public service publishes it rounded to the metre —
kept as published), GDA2020 ellipsoidal height, monument type, status, trig
name. No conversion: the published lat/lon is the display position.
No public per-mark datasheet.
"""
import os

from common import fnum, log, record
from src_util import arcgis_pages, features, grid, height, text_of

SRC = 'au-nsw'
LAYER = 'https://portal.spatial.nsw.gov.au/server/rest/services/SurveyMarkGDA2020/FeatureServer/0'
FIELDS = ('OBJECTID,marktype,marknumber,markstatus,monumenttype,markalias,trigname,trigtype,mgazone,'
          'gdaclass,ahdclass,longitude,latitude,gdaheight,gdaheightclass,mgaeasting_label,'
          'mganorthing_label,ahdheight_label,marksymbol_label')
# SCIMS mark status: D destroyed, N not found, F found; blank = no report.
STATUS = {'D': 'destroyed', 'N': 'notFound', 'F': 'ok', None: 'ok', '': 'ok', 'S': 'damaged'}
PRECISE = ('2A', '3A', 'A', 'B', 'C')
MONUMENT = (
    (('pillar',), 'pillar'), (('bolt',), 'bolt'), (('pin', 'nail', 'spike'), 'pin'),
    (('rod', 'bar', 'star picket'), 'rod'), (('pipe',), 'pipe'), (('plaque', 'disc', 'disk'), 'disk'),
    (('drill hole', 'cut', 'arrow'), 'cut'), (('ssm', 'conc', 'block'), 'block'),
)


def fetch(raw_dir):
    arcgis_pages(raw_dir, LAYER, FIELDS, page=2000, label=SRC)


def _code(text):
    from src_util import monument_from_words  # noqa: PLC0415

    return monument_from_words(text, MONUMENT)


def mark(a):
    lat, lng = fnum(a.get('latitude')), fnum(a.get('longitude'))
    if lat is None or lng is None:
        return None
    ident = f"{a.get('marktype') or ''}{a.get('marknumber') or ''}"
    if not ident:
        return None
    gda_class = (a.get('gdaclass') or '').upper()
    ahd_class = (a.get('ahdclass') or '').upper()
    h_ell = fnum(a.get('gdaheight'))
    if (a.get('marktype') or '') == 'TS':
        type_ = 'h'
    elif gda_class in PRECISE and h_ell is not None and (a.get('gdaheightclass') or 'U') != 'U':
        type_ = '3d'
    elif gda_class in PRECISE:
        type_ = 'h'
    elif ahd_class.startswith('L'):
        type_ = 'v'
    else:
        type_ = 'u'
    ahd = (a.get('ahdheight_label') or '').strip()
    h = height(ahd, 'AHD', ahd) if ahd else None
    zone = a.get('mgazone')
    g = grid(f'MGA2020 zone {zone}', a.get('mgaeasting_label'), a.get('mganorthing_label')) if zone else None
    mon = (a.get('monumenttype') or '').strip()
    trig = (a.get('trigname') or '').strip()
    status = STATUS.get(a.get('markstatus'), 'unknown')
    return record(
        SRC, ident, lat, lng, type_, 'gda2020',
        name=trig or None,
        aliases=[x for x in {(a.get('markalias') or '').strip(), trig} if x],
        geo=f"{text_of(a.get('latitude'))}, {text_of(a.get('longitude'))}",
        grids=[g] if g else [],
        # Class U: an unclassified (often transformed or scaled) position.
        posAcc=5.0 if gda_class in ('U', '') else None,
        status=status,
        statusRaw=f"{a.get('marksymbol_label') or ''} · GDA class {gda_class or '–'} · AHD class {ahd_class or '–'}",
        hEll=h_ell, hEllText=text_of(a.get('gdaheight')) if h_ell is not None else None,
        hOrtho=[h] if h else [],
        monument={'code': _code(mon), 'text': mon} if mon and mon.upper() != 'UNKNOWN' else None,
        sheet=ident,
    )


def normalize(raw_dir):
    n = 0
    for f in features(raw_dir):
        rec = mark(f.get('attributes') or {})
        if rec:
            n += 1
            yield rec
    log(f'{SRC}: {n} marks')
