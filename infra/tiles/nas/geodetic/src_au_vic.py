"""Victoria — Vicmap Position, survey control marks (SMES_FULL) (SOURCES.md #16).

ArcGIS FeatureServer (services-ap1.arcgis.com/…/Vicmap_Position), ~242k marks,
2,000 per page. Published per mark: GDA2020 lat/lon, MGA2020 E/N + zone,
GDA2020 ellipsoidal height, AHD height (text, as published), techniques,
status, mark type. No conversion: the published GDA2020 lat/lon is the
display position. The SMES per-mark link now redirects (no deep link).
"""
import os

from common import fnum, log, record
from src_util import arcgis_pages, features, grid, height, monument_from_words, text_of

SRC = 'au-vic'
LAYER = 'https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/arcgis/rest/services/Vicmap_Position/FeatureServer/0'
FIELDS = ('OBJECTID,mark_id,symbol,scn_gda,adj_ahd,status,nine_figure_no,name,ahd_height,ahd_technique,'
          'mga2020_easting,mga2020_northing,mga2020_zone,gda2020_latitude_dms,gda2020_longitude_dms,'
          'gda2020_ellipsoid_height,gda2020_technique,mark_type')
STATUS = (('destroy', 'destroyed'), ('replaced', 'destroyed'), ('not found', 'notFound'),
          ('missing', 'damaged'), ('damage', 'damaged'), ('ok', 'ok'))
MONUMENT = (
    (('plaque',), 'disk'), (('rivet', 'bolt'), 'bolt'), (('pipe',), 'pipe'), (('pin', 'nail'), 'pin'),
    (('pillar',), 'pillar'), (('rod',), 'rod'),
)
PRECISE = ('ADJUSTED', 'GNSS (KINEMATIC)', 'GNSS (DIFFERENTIAL)', 'GNSS (STATIC)', 'GNSS')


def fetch(raw_dir):
    arcgis_pages(raw_dir, LAYER, FIELDS, page=2000, label=SRC)


def _status(s):
    t = (s or '').lower()
    for needle, out in STATUS:
        if needle in t:
            return out
    return 'unknown'


def mark(a):
    lat, lng = fnum(a.get('gda2020_latitude_dms')), fnum(a.get('gda2020_longitude_dms'))
    if lat is None or lng is None or a.get('mark_id') is None:
        return None
    tech = (a.get('gda2020_technique') or '').upper()
    ahd_tech = (a.get('ahd_technique') or '').upper()
    h_ell_text = (a.get('gda2020_ellipsoid_height') or '').strip() if isinstance(a.get('gda2020_ellipsoid_height'), str) \
        else text_of(a.get('gda2020_ellipsoid_height'))
    h_ell = fnum(h_ell_text)
    ahd_text = a.get('ahd_height')
    ahd_text = ahd_text.strip() if isinstance(ahd_text, str) else text_of(ahd_text)
    h = height(ahd_text, 'AHD', ahd_text) if ahd_text else None
    if tech in PRECISE and h_ell is not None:
        type_ = '3d'
    elif h and ahd_tech == 'SPIRIT LEVELLING' and tech not in PRECISE:
        type_ = 'v'
    elif tech in PRECISE or (a.get('scn_gda') or '') == 'YES':
        type_ = 'h'
    elif h:
        type_ = 'v'
    else:
        type_ = 'u'
    zone = a.get('mga2020_zone')
    g = grid(f'MGA2020 zone {zone}', a.get('mga2020_easting'), a.get('mga2020_northing')) if zone else None
    mon = (a.get('mark_type') or '').strip()
    mid = str(a['mark_id'])
    st = (a.get('status') or '').strip()
    return record(
        SRC, mid, lat, lng, type_, 'gda2020',
        name=(a.get('name') or '').strip() or None,
        aliases=[x for x in {(a.get('name') or '').strip(), (a.get('nine_figure_no') or '').strip()} if x],
        geo=f"{text_of(a.get('gda2020_latitude_dms'))}, {text_of(a.get('gda2020_longitude_dms'))}",
        grids=[g] if g else [],
        status=_status(st) if st else 'unknown',
        statusRaw=' · '.join(x for x in (st, f'GDA2020 {tech.lower()}' if tech else '',
                                         f'AHD {ahd_tech.lower()}' if ahd_tech else '') if x) or None,
        hEll=h_ell, hEllText=h_ell_text if h_ell is not None else None,
        hOrtho=[h] if h else [],
        monument={'code': monument_from_words(mon, MONUMENT), 'text': mon} if mon and mon != 'other' else None,
        sheet=mid,
    )


def normalize(raw_dir):
    n = 0
    for f in features(raw_dir):
        rec = mark(f.get('attributes') or {})
        if rec:
            n += 1
            yield rec
    log(f'{SRC}: {n} marks')
