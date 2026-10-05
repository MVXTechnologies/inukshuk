"""Netherlands — Rijkswaterstaat NAP benchmarks (SOURCES.md #8), CC0.

WFS geo.rijkswaterstaat.nl/services/ogc/gdr/nap/ows, layer
nap:punten_actueel (~203k rows), 10,000 per page. Per benchmark: number,
NAP height, RD x/y rounded to the metre, type, description (often carrying
the precise X/Y), accessibility, dates. RD → ETRS89 with the official
RDNAPTRANS2018 grid; the published position is to the metre, so ±1 m.
"""
import os
import urllib.parse

from common import fnum, log, record
from src_util import date_of, features, fetch_rd_grid, grid, height, offset_pages, rd_to_etrs89

SRC = 'nl-rws'
WFS = 'https://geo.rijkswaterstaat.nl/services/ogc/gdr/nap/ows'
PAGE = 10000
TYPE_TEXT = {'PM': 'peilmerk', 'SA': 'ondergronds merk', 'OM': 'ondergronds merk', 'BP': 'bout'}


def fetch(raw_dir):
    def url_for(offset):
        return WFS + '?' + urllib.parse.urlencode({
            'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': 'nap:punten_actueel',
            'outputFormat': 'application/json', 'count': PAGE, 'startIndex': offset, 'sortBy': 'puntnummer'})
    offset_pages(os.path.join(raw_dir, 'nap'), url_for, PAGE, label=SRC)
    fetch_rd_grid(raw_dir)


def mark(p, conv):
    x, y = fnum(p.get('x_rd')), fnum(p.get('y_rd'))
    num = (p.get('puntnummer') or '').strip()
    if x is None or y is None or not num:
        return None
    lat, lng, acc = conv(x, y)
    h = height(p.get('hoogte'), 'NAP')
    desc = ' '.join(x for x in ((p.get('omschrijving') or '').strip(), (p.get('adres') or '').strip()) if x)
    g = grid('RD', p.get('x_rd'), p.get('y_rd'))
    status = (p.get('status') or '').upper()
    return record(
        SRC, num, lat, lng, 'v', 'rd-bessel',
        grids=[g] if g else [],
        posAcc=max(acc or 0, 1.0),
        status='ok' if status == 'ACTUEEL' else 'unknown',
        statusRaw=' · '.join(v for v in (p.get('status'), 'bereikbaar' if p.get('bereikbaar') == 'J' else
                                         'niet bereikbaar' if p.get('bereikbaar') == 'N' else '') if v) or None,
        hOrtho=[h] if h else [],
        monument={'code': 'bolt' if p.get('type') == 'PM' else 'other',
                  'text': desc or TYPE_TEXT.get(p.get('type') or '', p.get('type') or '')} if desc or p.get('type') else None,
        lastVisit=date_of(p.get('projectdatum')),
    )


def normalize(raw_dir):
    conv = rd_to_etrs89(raw_dir)
    seen = set()
    n = 0
    for f in features(os.path.join(raw_dir, 'nap')):
        rec = mark(f.get('properties') or {}, conv)
        if rec is None or rec['uid'] in seen:
            continue  # the layer may repeat a benchmark
        seen.add(rec['uid'])
        n += 1
        yield rec
    log(f'{SRC}: {n} benchmarks')
