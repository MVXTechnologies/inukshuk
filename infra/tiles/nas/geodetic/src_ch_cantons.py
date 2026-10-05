"""Switzerland — cantonal fixed points LFP2 / HFP2 via geodienste.ch (SOURCES.md #6).

One CSV zip per canton (+ Liechtenstein), LV95. geodienste.ch lists each
canton's terms; every canton is "Frei erhältlich" with no contract, and all
but two state "Freie Nutzung (Quellenangabe ist Pflicht)". GR and SG state no
terms ("keine Angabe"): they are left out until the owner decides
(CH_CANTONS_INCLUDE_UNSTATED=1 includes them).

Positions: LV95 → WGS 84 with pyproj (validated against swisstopo REFRAME in
test_src_ch.py). Heights `hoehe_geom_m` are the cantonal survey heights (LN02).
"""
import csv
import io
import json
import os
import time
import zipfile

from common import download, fnum, http_get, log, record
from src_util import grid, height, monument_from_words, to_wgs84

SRC = 'ch-cantons'
SERVICES = 'https://geodienste.ch/info/services.json?base_topics=fixpunkte&language=de'
CSV_URL = 'https://geodienste.ch/downloads/csv/fixpunkte/{c}/deu/{topic}_{c}_csv_lv95.zip'
MONUMENT = (
    (('nivellementsbolzen', 'bolzen', 'niete'), 'bolt'), (('stein',), 'stone'),
    (('turm', 'kirch', 'antenne', 'kamin', 'blitzableiter'), 'structure'),
    (('rohr',), 'pipe'), (('kreuz', 'meissel'), 'cut'), (('pfeiler',), 'pillar'),
    (('platte', 'scheibe'), 'disk'),
)
TYPE = {'LFP2': 'h', 'HFP2': 'v', 'LFP1': 'h', 'HFP1': 'v'}


def cantons():
    services = json.loads(http_get(SERVICES))['services']
    out = []
    for s in services:
        stated = (s.get('opendata_terms_data') or '').strip()
        free = s.get('publication_data') == 'Frei erhältlich' and not s.get('contract_required_data')
        if not free:
            continue
        if stated in ('', 'keine Angabe') and os.environ.get('CH_CANTONS_INCLUDE_UNSTATED') != '1':
            log(f"{SRC}: {s['canton']} states no terms of use; skipped")
            continue
        out.append((s['canton'], s['topic']))
    return out


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    keep = []
    for c, topic in cantons():
        path = os.path.join(raw_dir, f'{c}.zip')
        try:
            download(CSV_URL.format(c=c, topic=topic), path)
            keep.append(c)
        except Exception as e:  # noqa: BLE001 — one canton failing keeps the others
            log(f'{SRC}: {c}: {e}')
        time.sleep(1)
    json.dump(keep, open(os.path.join(raw_dir, 'cantons.json'), 'w'))
    log(f'{SRC}: {len(keep)} cantons')
    if not keep:
        raise RuntimeError(f'{SRC}: no canton could be fetched')


def rows(raw_dir):
    for name in sorted(os.listdir(raw_dir)):
        if not name.endswith('.zip'):
            continue
        with zipfile.ZipFile(os.path.join(raw_dir, name)) as z:
            inner = next((n for n in z.namelist() if n.endswith('fixpunkt.csv')), None)
            if inner is None:
                continue
            with z.open(inner) as f:
                yield from csv.DictReader(io.TextIOWrapper(f, 'utf-8-sig'), delimiter=';')


def fixpoint(r):
    e, n = fnum(r.get('koordinate_e') or r.get('E')), fnum(r.get('koordinate_n') or r.get('N'))
    if e is None or n is None:
        return None
    lat, lng = to_wgs84(2056, e, n)
    art = (r.get('art') or '').strip()
    gone = bool((r.get('untergegangen_am') or '').strip())
    status_raw = (r.get('status') or '').strip()
    status = 'destroyed' if gone else ('ok' if status_raw == 'verifiziert' else 'unknown')
    h_ortho = []
    h = height(r.get('hoehe_geom_m'), 'LN02', r.get('hoehe_geom_m'))
    if h:
        h_ortho.append(h)
    mon = (r.get('punktzeichen') or '').replace('_', ' ').strip()
    desc = (r.get('punktzeichenbeschreibung') or '').strip()
    acc = fnum(r.get('lage_gen_m'))
    ident = f"{(r.get('nbident') or '').strip()}_{(r.get('nummer') or '').strip()}"
    g = grid('LV95', r.get('koordinate_e') or r.get('E'), r.get('koordinate_n') or r.get('N'))
    return record(
        SRC, ident, lat, lng, TYPE.get(art, 'u'), 'lv95',
        name=(r.get('nummer') or '').strip() or None,
        aliases=[a for a in {(r.get('inschrift') or '').strip()} if len(a) >= 3],
        posAcc=acc if acc is not None and acc >= 1 else None,
        status=status,
        statusRaw=f"{art} · {status_raw}".strip(' ·') or None,
        hOrtho=h_ortho,
        grids=[g] if g else [],
        monument={'code': monument_from_words(mon, MONUMENT), 'text': f'{mon} — {desc}' if desc else mon}
        if mon else None,
        url=(r.get('url_punktprotokoll') or '').strip() or None,
        sheet=ident,
    )


def normalize(raw_dir):
    n = 0
    for r in rows(raw_dir):
        rec = fixpoint(r)
        if rec:
            n += 1
            yield rec
    log(f'{SRC}: {n} points')
