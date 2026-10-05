"""Austria — BEV Festpunkte (SOURCES.md #10), CC BY 4.0, refreshed 1 April / 1 October.

Three Austria-wide CSVs from data.bev.gv.at, the newest "Stichtag" found in
BEV's catalogue:
- AT_ETRS89_TP (trig points) and AT_ETRS89_EP (densification points):
  ETRS89/Austria 2002 lat/lon (BREITE/LAENGE), ellipsoidal height, UTM E/N,
  monument (STABART), measurement date. A trig point lists each of its
  physical marks (main stone, centring bolts, church-tower knob, reference
  marks…) on its own row: one mark per point is kept, the main one.
- AT_HP (levelling benchmarks): MGI Gauss-Krüger E/N only (to the metre for
  most) + height in GHA (Gebrauchshöhen Adria). The display position is
  converted with BEV's own MGI → ETRS89 grid; validated in test_src_at.py
  against the ETRS89 position BEV publishes for the same mark as a trig mark.
No public per-point datasheet (BEV sells them).
"""
import csv
import json
import os
import re
import urllib.request

from common import USER_AGENT, download, fnum, log, record, ssl_context
from src_util import date_of, fetch_bev_grid, grid, height, mgi_gk_to_etrs89, monument_from_words, text_of

SRC = 'at-bev'
SEARCH = 'https://data.bev.gv.at/geonetwork/srv/api/search/records/_search'
KINDS = {
    'TP': r'/AT_ETRS89_TP_(\d{8})\.csv$',
    'EP': r'/AT_ETRS89_EP_(\d{8})\.csv$',
    'HP': r'/AT_HP_(\d{8})\.csv$',
}
MAIN_MARK = ('A1', 'T1', 'E1', 'C1', 'K1', 'J1', 'H1')
MONUMENT = (
    (('bolzen', 'niete', 'hb/', 'nagel'), 'bolt'), (('stein',), 'stone'), (('knauf', 'kreuz', 'turm', 'kirch',
                                                                              'blitz'), 'structure'),
    (('pfeiler',), 'pillar'), (('rohr',), 'pipe'), (('marke', 'platte'), 'disk'), (('rb/',), 'rod'),
)
# AT_HP KENNZEICHEN_HP is a mark-type code; NIV_ZUSATZ carries warnings.
UTM = {'25832': 'ETRS89 UTM 32', '25833': 'ETRS89 UTM 33'}
HP_POSITION_ACC = {'T': None, 'G': 1.0, 'M': 3.0, 'L': 10.0}


def latest_urls():
    body = json.dumps({'query': {'query_string': {'query': 'Festpunkte'}}, 'size': 200,
                       '_source': ['link']}).encode()
    req = urllib.request.Request(SEARCH, data=body, headers={
        'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=120, context=ssl_context()) as r:
        hits = json.load(r)['hits']['hits']
    best = {}
    for h in hits:
        for ln in h['_source'].get('link', []):
            u = (ln.get('urlObject') or {}).get('default') or ''
            for kind, pat in KINDS.items():
                m = re.search(pat, u)
                if m and m.group(1) > best.get(kind, ('', ''))[0]:
                    best[kind] = (m.group(1), u)
    return {k: u for k, (_d, u) in best.items()}


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    urls = latest_urls()
    if set(urls) != set(KINDS):
        raise RuntimeError(f'{SRC}: catalogue lists only {sorted(urls)}')
    for kind, url in urls.items():
        download(url, os.path.join(raw_dir, f'{kind}.csv'))
        log(f'{SRC}: {kind} ← {url.rsplit("/", 1)[-1]}')
    fetch_bev_grid(raw_dir)


def _rows(path):
    with open(path, encoding='utf-8-sig', errors='replace', newline='') as f:
        yield from csv.DictReader(f, delimiter=';')


def _key(r):
    return (r.get('PUNKTTYP') or '').strip(), (r.get('OeK50_BMN_NR') or '').strip(), (r.get('PUNKTNUMMER') or '').strip()


def _ident(r):
    """BEV designation: 'TP 497-40' (number - ÖK50 sheet), 'EP 3544-40'."""
    t, sheet, num = _key(r)
    return f'{t} {num}-{sheet}'


def _pick_main(path):
    best = {}
    for r in _rows(path):
        k = _key(r)
        mark = (r.get('KENNZEICHEN') or '').strip()
        rank = MAIN_MARK.index(mark) if mark in MAIN_MARK else len(MAIN_MARK)
        auflage = fnum(r.get('AUFLAGE')) or 0
        cur = best.get(k)
        if cur is None or (rank, -auflage) < cur[0]:
            best[k] = ((rank, -auflage), r)
    return [r for _k, (_rank, r) in best.items()]


def lage(r, type_):
    lat, lng = fnum(r.get('BREITE')), fnum(r.get('LAENGE'))
    if lat is None or lng is None:
        return None
    zone = UTM.get((r.get('EPSG_PROJ') or '').strip())
    g = grid(zone, r.get('RW'), r.get('HW')) if zone else None
    mon = (r.get('STABART') or '').strip()
    ident = _ident(r)
    hinweis = (r.get('HINWEIS') or '').strip()
    how = (r.get('KOORD_BEST_XYZ') or '')
    if 'GPS' in how or 'APOS' in how:
        type_ = '3d'
    return record(
        SRC, ident, lat, lng, type_, 'etrs89',
        name=(r.get('PUNKTNAME') or '').strip() or None,
        aliases=[x for x in {(r.get('PUNKTNAME') or '').strip()} if x],
        geo=f"{text_of(r.get('BREITE'))}, {text_of(r.get('LAENGE'))}",
        grids=[g] if g else [],
        hEll=fnum(r.get('HOEHE')), hEllText=text_of(r.get('HOEHE')),
        status='ok',
        statusRaw=' · '.join(x for x in (r.get('KOORD_BEST_XYZ') or '', f'Hinweis {hinweis}' if hinweis else '')
                             if x) or None,
        monument={'code': monument_from_words(mon, MONUMENT), 'text': mon} if mon else None,
        lastVisit=date_of(r.get('MESSDATUM')),
    )


def hoehe(r, conv):
    rw, hw = fnum(r.get('RECHTSWERT')), fnum(r.get('HOCHWERT'))
    meridian = (r.get('MERIDIAN') or '').strip()
    if rw is None or hw is None or meridian not in ('M28', 'M31', 'M34'):
        return None
    lat, lng, acc = conv(meridian, rw, hw)
    num = (r.get('PUNKTNUMMER') or '').strip()
    note = (r.get('NIV_ZUSATZ') or '').strip()
    h = height(r.get('HOEHE'), 'GHA (Adria)', r.get('HOEHE'))
    # How the position was determined → how far the published E/N may be off:
    # measured against BEV's own ETRS89 positions of the same marks (2026-04
    # data, 2,611 marks): T (from a trig mark) p90 0.06 m, G 0.7 m, M 2.8 m,
    # L 7.3 m.
    class_acc = HP_POSITION_ACC.get((r.get('KOORD_LAGE_BEST') or '').strip(), 5.0)
    # Coordinates given only to the metre: the mark is somewhere in that metre.
    whole = all(re.fullmatch(r'-?\d+(\.0+)?', (r.get(k) or '').strip()) for k in ('RECHTSWERT', 'HOCHWERT'))
    acc = max(acc or 0, class_acc or 0, 1.0 if whole else 0)
    g = grid(f'MGI Gauss-Krüger {meridian}', r.get('RECHTSWERT'), r.get('HOCHWERT'))
    ident = (r.get('IDENT_PUNKT') or '').strip()
    return record(
        SRC, f"HP {num}-{(r.get('OeK50_BMN_NR') or '').strip()}", lat, lng, 'v', 'mgi',
        aliases=[x for x in {ident, (r.get('IDENT_OESN') or '').strip()} if x],
        grids=[g] if g else [],
        posAcc=acc if acc >= 1 else None,
        status='damaged' if 'beschädigt' in note else 'ok',
        statusRaw=note or None,
        hOrtho=[h] if h else [],
        lastVisit=(r.get('DATUM_H_MESS') or '').strip()[:4] or None,
    )


def normalize(raw_dir):
    n = 0
    for kind, type_ in (('TP', 'h'), ('EP', 'h')):
        path = os.path.join(raw_dir, f'{kind}.csv')
        if not os.path.exists(path):
            continue
        for r in _pick_main(path):
            rec = lage(r, type_)
            if rec:
                n += 1
                yield rec
    path = os.path.join(raw_dir, 'HP.csv')
    if os.path.exists(path):
        conv = mgi_gk_to_etrs89(raw_dir)
        for r in _rows(path):
            rec = hoehe(r, conv)
            if rec:
                n += 1
                yield rec
    log(f'{SRC}: {n} points')
