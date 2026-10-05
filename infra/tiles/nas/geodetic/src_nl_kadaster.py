"""Netherlands — Kadaster / NSGI RDinfo (SOURCES.md #8), Public Domain Mark.

PDOK OGC API `rdinfo`, collection `stations` (~12k): every physical mark
("station") of the ~4.5k RD points, with RD x/y to the millimetre, a
description, the year/month/day of the last description, and — for GNSS
marks — ETRS89 lat/lon (DMS) and ellipsoidal height. One mark per RD point
is kept: the GNSS-measured one when there is one, else the lowest station
number. ETRS89 lat/lon is used as published; otherwise RD → ETRS89 with the
official RDNAPTRANS2018 grid (validated against Kadaster's own pairs in
test_src_nl.py).
"""
import os

from common import fnum, log, record
from src_util import features, fetch_rd_grid, grid, next_link_pages, rd_to_etrs89, dms_to_deg, text_of

SRC = 'nl-kadaster'
API = 'https://api.pdok.nl/kadaster/rdinfo/ogc/v1/collections/stations/items?f=json&limit=1000'


def fetch(raw_dir):
    next_link_pages(raw_dir, API, label=SRC)
    fetch_rd_grid(raw_dir)


def _point_id(p):
    return f"{p.get('blad') or ''}{p.get('punt') or ''}".strip()


def station(p, conv):
    x, y = fnum(p.get('xrd')), fnum(p.get('yrd'))
    pid = _point_id(p)
    if x is None or y is None or not pid:
        return None
    phi, lam = p.get('phi'), p.get('lambda')
    if phi and lam:
        lat, lng, acc = dms_to_deg(phi), dms_to_deg(lam), None
        geo = f"{text_of(phi)}, {text_of(lam)}"
        type_ = '3d'
    else:
        lat, lng, acc = conv(x, y)
        geo = None
        type_ = 'h'
    desc = (p.get('omschrext') or p.get('omschrint') or '').strip()
    year, month, day = p.get('jaar'), p.get('maand'), p.get('dag')
    visit = None
    if year:
        visit = f'{int(year):04d}-{int(month):02d}-{int(day):02d}' if month and day else str(year)
    g = grid('RD', p.get('xrd'), p.get('yrd'))
    ident = f"{pid}-{p.get('station') or ''}".strip('-')
    return record(
        SRC, ident, lat, lng, type_, 'etrs89' if geo else 'rd-bessel',
        name=pid,
        aliases=[a for a in {(p.get('peilmerk') or '').strip(), pid} if a],
        geo=geo,
        grids=[g] if g else [],
        posAcc=acc,
        status='ok',
        hEll=fnum(p.get('h')), hEllText=text_of(p.get('h')),
        monument={'code': 'bolt' if 'bout' in desc.lower() else 'other', 'text': desc} if desc else None,
        lastVisit=visit,
    )


def normalize(raw_dir):
    conv = rd_to_etrs89(raw_dir)
    best = {}
    for f in features(raw_dir):
        p = f.get('properties') or {}
        pid = _point_id(p)
        if not pid:
            continue
        rank = (0 if p.get('phi') else 1, str(p.get('station') or ''))
        if pid not in best or rank < best[pid][0]:
            best[pid] = (rank, p)
    n = 0
    for _pid, (_rank, p) in best.items():
        rec = station(p, conv)
        if rec:
            n += 1
            yield rec
    log(f'{SRC}: {n} RD points')
