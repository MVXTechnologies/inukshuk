"""Queensland — survey control (SOURCES.md #17).

ArcGIS MapServer Location/SurveyControl. Every mark with a GDA2020 position is
in exactly one of the lineage layers 3 (GDA datum), 4 (GDA derived) and 16
(GDA scaled); layer 0 holds the CORS (~176). Each row carries GDA2020
lat/lon + positional uncertainty, ellipsoidal height, AHD height + class,
mark type, condition, last visit and the per-mark PDF report URL.
No conversion: the published GDA2020 lat/lon is the display position.
"""
import os

from common import fnum, log, record
from src_util import arcgis_pages, epoch_ms_date, features, height, monument_from_words, text_of

SRC = 'au-qld'
BASE = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Location/SurveyControl/MapServer/'
LAYERS = {'cors': 0, 'gda_datum': 3, 'gda_derived': 4, 'gda_scaled': 16}
P = 'sirpub.prop.qld_surveycontrol_scdb.'
FIELDS = ','.join([P + f for f in (
    'mrk_id', 'alt1_nm', 'alt2_nm', 'mrktype_de', 'mrkcnd_de', 'lastvisit_dt', 'gda2020lineage_de',
    'gda2020latitude', 'gda2020longitude', 'gda2020hrzposu', 'gda2020height', 'gda2020fix_de',
    'ahdheight', 'ahdcls_de', 'ahdlineage_de', 'objectid')] +
    ['sirpub.prop.qld_surveycontrol_rpt_link.report_url'])
STATUS = (('destroy', 'destroyed'), ('not found', 'notFound'), ('missing', 'notFound'),
          ('damage', 'damaged'), ('disturb', 'damaged'), ('unstable', 'damaged'), ('good', 'ok'), ('found', 'ok'))
MONUMENT = (
    (('pillar',), 'pillar'), (('bolt',), 'bolt'), (('pin', 'nail', 'spike'), 'pin'),
    (('rod', 'bar', 'picket'), 'rod'), (('pipe', 'tube'), 'pipe'), (('plaque', 'disc', 'disk', 'medallion'), 'disk'),
    (('drill', 'cut', 'arrow', 'cross'), 'cut'), (('mast', 'post on roof', 'antenna', 'cors'), 'antenna'),
    (('block', 'concrete', 'conc'), 'block'),
)


def fetch(raw_dir):
    for name, layer in LAYERS.items():
        arcgis_pages(os.path.join(raw_dir, name), BASE + str(layer), FIELDS, page=2000,
                     order=P + 'objectid', label=f'{SRC} {name}')


def _get(a, f):
    return a.get(P + f)


def _status(text):
    t = (text or '').lower()
    for needle, s in STATUS:
        if needle in t:
            return s
    return 'unknown'


def mark(a, layer):
    lat, lng = fnum(_get(a, 'gda2020latitude')), fnum(_get(a, 'gda2020longitude'))
    mid = (_get(a, 'mrk_id') or '').strip()
    if lat is None or lng is None or not mid:
        return None
    lineage = (_get(a, 'gda2020lineage_de') or '').strip()
    unc = fnum(_get(a, 'gda2020hrzposu'))
    h_ell = fnum(_get(a, 'gda2020height'))
    ahd = _get(a, 'ahdheight')
    h = height(ahd, 'AHD') if ahd is not None else None
    if layer == 'cors':
        type_ = 'gnss'
    elif lineage.lower() == 'scaled':
        type_ = 'v' if h else 'u'
    elif h_ell is not None and (_get(a, 'gda2020fix_de') or '').upper() == 'GNSS':
        type_ = '3d'
    else:
        type_ = 'h'
    if lineage.lower() == 'scaled':
        pos_acc = max(unc or 0, 10.0)
    else:
        pos_acc = unc if unc is not None and unc >= 1 else None
    mon = (_get(a, 'mrktype_de') or '').strip()
    names = [n for n in (_get(a, 'alt1_nm'), _get(a, 'alt2_nm')) if n]
    cond = (_get(a, 'mrkcnd_de') or '').strip()
    return record(
        SRC, mid, lat, lng, type_, 'gda2020',
        name=names[0] if names else None,
        aliases=names,
        geo=f"{text_of(_get(a, 'gda2020latitude'))}, {text_of(_get(a, 'gda2020longitude'))}",
        posAcc=pos_acc,
        status=_status(cond) if cond else 'unknown',
        statusRaw=' · '.join(x for x in (cond, f'GDA2020 {lineage}' if lineage else '',
                                         _get(a, 'ahdcls_de') or '') if x) or None,
        hEll=h_ell, hEllText=text_of(_get(a, 'gda2020height')) if h_ell is not None else None,
        hOrtho=[h] if h else [],
        monument={'code': monument_from_words(mon, MONUMENT), 'text': mon} if mon else None,
        lastVisit=epoch_ms_date(_get(a, 'lastvisit_dt')),
        url=a.get('sirpub.prop.qld_surveycontrol_rpt_link.report_url'),
        sheet=mid,
    )


def normalize(raw_dir):
    seen = set()
    n = 0
    for name in LAYERS:
        for f in features(os.path.join(raw_dir, name)):
            rec = mark(f.get('attributes') or {}, name)
            if rec is None or rec['uid'] in seen:
                continue  # a CORS is also in the GDA datum layer
            seen.add(rec['uid'])
            n += 1
            yield rec
    log(f'{SRC}: {n} marks')
