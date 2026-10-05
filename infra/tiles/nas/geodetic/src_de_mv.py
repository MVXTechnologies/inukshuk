"""Germany, Mecklenburg-Vorpommern — LAiV AFIS fixed points (SOURCES.md #11).

The WFS www.geodaten-mv.de/dienste/afis_wfs (CC BY 4.0 per the state's open
data terms — its OGC API variant is CC BY-NC, so the WFS is used), GML only:
adv_afis_lfp (horizontal, ~15k) and adv_afis_hfp (levelling, ~12.5k), 5,000
per page. ETRS89/UTM33 E/N (EPSG:25833), DHHN2016 normal heights, monument
wording ("Mauerbolzen, horizontal eingebracht"), last check date, a per-point
PDF ("Einzelnachweis"). No lat/lon is published: the display position is the
UTM inverse (pure projection, no datum shift).
The gravity layer (adv_afis_sfp) is out of scope.
"""
import os
import urllib.parse
import xml.etree.ElementTree as ET

from common import fnum, log, record
from src_util import date_of, features, grid, height, monument_from_words, offset_pages, to_wgs84

SRC = 'de-mv'
WFS = 'https://www.geodaten-mv.de/dienste/afis_wfs'
NS = '{https://www.geodaten-mv.de/dienste/afis_wfs}'
WFS_NS = '{http://www.opengis.net/wfs/2.0}'
LAYERS = {'lfp': 'h', 'hfp': 'v'}
PAGE = 5000
VDATUM = {'DE_DHHN2016_NH': 'DHHN2016', 'DE_DHHN92_NH': 'DHHN92'}
MONUMENT = (
    (('bolzen', 'niete'), 'bolt'), (('pfeiler',), 'pillar'), (('platte',), 'disk'), (('stein',), 'stone'),
    (('rohr',), 'pipe'), (('kreuz', 'meißel'), 'cut'), (('turm', 'kirch', 'knopf'), 'structure'),
)


def _parse(body):
    root = ET.fromstring(body)
    feats = []
    for member in root.iter(WFS_NS + 'member'):
        for el in member:
            props = {}
            for c in el:
                tag = c.tag.replace(NS, '')
                if tag not in ('geometry', '{http://www.opengis.net/gml/3.2}boundedBy'):
                    props[tag] = (c.text or '').strip()
            feats.append({'properties': props})
    return {'features': feats}


def fetch(raw_dir):
    for layer in LAYERS:
        def url_for(offset, layer=layer):
            return WFS + '?' + urllib.parse.urlencode({
                'SERVICE': 'WFS', 'VERSION': '2.0.0', 'REQUEST': 'GetFeature',
                'TYPENAMES': f'afismv:adv_afis_{layer}', 'COUNT': PAGE, 'STARTINDEX': offset})
        offset_pages(os.path.join(raw_dir, layer), url_for, PAGE, label=f'{SRC} {layer}', parse=_parse)


def point(p, type_):
    e, n = fnum(p.get('east')), fnum(p.get('north'))
    pid = p.get('punktkennung')
    if e is None or n is None or not pid:
        return None
    lat, lng = to_wgs84(25833, e, n)
    vd = VDATUM.get(p.get('referenzsystem') or '')
    h = height(p.get('hoehe'), vd, p.get('hoehe')) if vd and p.get('hoehe') else None
    mon = p.get('punktvermarkung') or ''
    notes = ' · '.join(x for x in (p.get('lagebeschreibung'), p.get('nutzerspezifische_bemerkungen')) if x)
    g = grid('ETRS89 UTM 33', p.get('east'), p.get('north'))
    return record(
        SRC, pid, lat, lng, type_, 'etrs89',
        grids=[g] if g else [],
        status='ok',
        statusRaw=' · '.join(x for x in (p.get('ordnung') or p.get('ordnung_hoehe'),
                                         p.get('punktstabilitaet'), notes) if x) or None,
        hOrtho=[h] if h else [],
        monument={'code': monument_from_words(mon, MONUMENT), 'text': mon} if mon else None,
        lastVisit=date_of(p.get('ueberwachungsdatum')),
        url=p.get('pdf_url') or None,
        sheet=pid,
    )


def normalize(raw_dir):
    n = 0
    for layer, type_ in LAYERS.items():
        for f in features(os.path.join(raw_dir, layer)):
            rec = point(f['properties'], type_)
            if rec:
                n += 1
                yield rec
    log(f'{SRC}: {n} points')
