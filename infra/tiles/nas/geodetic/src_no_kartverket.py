"""Norway — Kartverket fastmerker (SOURCES.md #9).

Three national GML files through the Geonorge download API (an anonymous
order, no login): Høydefastmerker (levelling, ~27k), Trekantpunkter (trig,
~41.6k), Landsnett og stamnett (national GNSS network, ~12k). EUREF89
geographic (EPSG:4258) as published, plus EUREF89 UTM E/N, NN2000 normal
heights, NN1954 heights, ellipsoidal heights, monument reference, base and
description, verification status and date. No conversion: the published
lat/lon is the display position. No per-point datasheet. CC BY 4.0.
"""
import json
import os
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

from common import USER_AGENT, download, log, record, ssl_context
from src_util import date_of, grid, height, monument_from_words

SRC = 'no-kartverket'
DATASETS = {
    'hoyde': '43838cda-fa62-11e6-bc64-92361f002671',
    'trekant': 'dc37b5b6-fa60-11e6-bc64-92361f002671',
    'stam': 'b0bea40a-2e4b-4ae0-8439-7037a3b60181',
}
ORDER = 'https://nedlasting.geonorge.no/api/order'
APP = '{https://skjema.geonorge.no/SOSI/produktspesifikasjon/Fastmerker/20230801}'
GML = '{http://www.opengis.net/gml/3.2}'
TYPE = {'nivPunkt': 'v', 'trigPunkt': 'h', 'landsnettPunkt': '3d', 'stamnettPunkt': '3d'}
STATUS = {'funnetIOrden': 'ok', 'funnetSkadet': 'damaged', 'skadet': 'damaged', 'ikkeFunnet': 'notFound',
          'ødelagt': 'destroyed', 'odelagt': 'destroyed', 'tapt': 'destroyed'}
MONUMENT = (
    (('bolt',), 'bolt'), (('spir', 'lykt', 'kule'), 'structure'), (('varde',), 'stone'),
    (('borhull',), 'cut'), (('ror',), 'pipe'), (('tapp',), 'pin'),
)


def _order(uuid):
    body = {'email': '', 'orderLines': [{
        'metadataUuid': uuid,
        'areas': [{'code': '0000', 'type': 'landsdekkende', 'name': 'Hele landet'}],
        'projections': [{'code': '4258'}],
        'formats': [{'name': 'GML'}],
    }]}
    req = urllib.request.Request(ORDER, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', 'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=120, context=ssl_context()) as r:
        files = json.load(r)['files']
    return files[0]['downloadUrl']


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    for name, uuid in DATASETS.items():
        # Each order gets a fresh URL, so there is no conditional GET: these
        # files are small (3–8 MB zipped) and fetched monthly at most.
        path = os.path.join(raw_dir, f'{name}.zip')
        meta = path + '.meta.json'
        if os.path.exists(meta):
            os.remove(meta)
        download(_order(uuid), path)
        log(f'{SRC}: {name} fetched')


def _t(el, tag):
    c = el.find(APP + tag)
    return (c.text or '').strip() if c is not None and c.text else None


def _mark(el):
    pos = el.find(f'{APP}posisjon/{GML}Point/{GML}pos')
    num = _t(el, 'punktNummer')
    if pos is None or not pos.text or not num:
        return None
    lat_s, lng_s = pos.text.split()[:2]
    kind = _t(el, 'punkttype') or ''
    acc_mm = None
    q = el.find(f'{APP}kvalitet/{APP}Posisjonskvalitet/{APP}nøyaktighetEUREF89')
    if q is not None and q.text:
        try:
            acc_mm = float(q.text)
        except ValueError:
            pass
    h_ortho = [h for h in (height(_t(el, 'høydeNormalNN2000'), 'NN2000', _t(el, 'høydeNormalNN2000')),
                           height(_t(el, 'høydeNN1954'), 'NN1954', _t(el, 'høydeNN1954'))) if h]
    ell = _t(el, 'høydeEllipsoidisk')
    type_ = TYPE.get(kind, 'u')
    if type_ == 'h' and ell:
        type_ = '3d'
    st = el.find(f'{APP}fastmerkestatus/{APP}Fastmerkestatus')
    status_raw = _t(st, 'typeStatus') if st is not None else None
    verified = _t(st, 'verifiseringsdato') if st is not None else None
    sentrum, base, desc = _t(el, 'fastmerkeSentrumRef'), _t(el, 'fastmerkeUnderlag'), _t(el, 'punktBeskrivelse')
    mon_text = '; '.join(x for x in (desc, ' i '.join(y for y in (sentrum, base) if y)) if x)
    zone = _t(el, 'sone')
    g = grid(f'EUREF89 UTM {zone}', _t(el, 'østKoordinat'), _t(el, 'nordKoordinat')) if zone else None
    name = _t(el, 'fastmerkeNavn')
    return record(
        SRC, num, float(lat_s), float(lng_s), type_, 'etrs89',
        name=name,
        aliases=[x for x in {name} if x],
        geo=f'{lat_s}, {lng_s}',
        grids=[g] if g else [],
        posAcc=acc_mm / 1000 if acc_mm and acc_mm >= 1000 else None,
        status=STATUS.get(status_raw, 'unknown') if status_raw else 'unknown',
        statusRaw=status_raw,
        hEll=float(ell) if ell else None, hEllText=ell,
        hOrtho=h_ortho,
        monument={'code': monument_from_words(f'{sentrum or ""} {desc or ""}', MONUMENT), 'text': mon_text}
        if mon_text else None,
        lastVisit=date_of(verified),
    )


def rows(path):
    with zipfile.ZipFile(path) as z:
        inner = next(n for n in z.namelist() if n.lower().endswith('.gml'))
        with z.open(inner) as f:
            for _ev, el in ET.iterparse(f, events=('end',)):
                if el.tag == APP + 'Fastmerke':
                    rec = _mark(el)
                    el.clear()
                    if rec:
                        yield rec


def normalize(raw_dir):
    n = 0
    seen = set()
    for name in ('stam', 'trekant', 'hoyde'):
        path = os.path.join(raw_dir, f'{name}.zip')
        if not os.path.exists(path):
            continue
        for rec in rows(path):
            if rec['uid'] in seen:
                continue
            seen.add(rec['uid'])
            n += 1
            yield rec
    log(f'{SRC}: {n} marks')
