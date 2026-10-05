"""Great Britain — Ordnance Survey trig archive (SOURCES.md #7; frozen 2015).

One CSV, OSGB36 E/N to the centimetre, reprojected with OSTN15. A station can
have several rows (pillar, bolt, centre…): one mark per station, the best
surviving monument. No per-point datasheet (archived).
Heights: only those levelled on Newlyn (LEVELLING DATUM 'N' = ODN); the other
datum codes are not documented in the archive, so they are not guessed.
"""
import csv
import io
import os
import zipfile

from common import download, fnum, log, record
from src_util import date_of, fetch_ostn15, grid, height, monument_from_words, osgb_to_wgs84

SRC = 'uk-os-trig'
URL = 'https://www.ordnancesurvey.co.uk/documents/gps/CompleteTrigArchive.zip'
MONUMENT = (
    (('pillar',), 'pillar'), (('bolt', 'rivet', 'fbm'), 'bolt'), (('block', 'blk'), 'block'),
    (('spire', 'flagstaff', 'vane', 'chimney', 'mast', 'tower', 'cross', 'church', 'lightning',
      'finial', 'ball', 'turret', 'pinnacle', 'apex', 'beacon', 'lantern'), 'structure'),
    (('cut', 'mark'), 'cut'), (('pipe',), 'pipe'), (('rod',), 'rod'), (('stone', 'cairn'), 'stone'),
)
PREFER = ('PILLAR', 'BOLT', 'BLOCK', 'BURIED BLK', 'CENTRE', 'RIVET')


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    download(URL, os.path.join(raw_dir, 'CompleteTrigArchive.zip'))
    fetch_ostn15(raw_dir)


def rows(raw_dir):
    with zipfile.ZipFile(os.path.join(raw_dir, 'CompleteTrigArchive.zip')) as z:
        name = next(n for n in z.namelist() if n.lower().endswith('.csv'))
        with z.open(name) as f:
            yield from csv.DictReader(io.TextIOWrapper(f, 'utf-8-sig', errors='replace'))


def _pref(r):
    mark = (r.get('TYPE OF MARK') or '').strip().upper()
    live = (r.get('DESTROYED MARK INDICATOR') or '0').strip() == '0'
    return (0 if live else 1, PREFER.index(mark) if mark in PREFER else len(PREFER))


def normalize(raw_dir):
    conv = osgb_to_wgs84(raw_dir)
    stations = {}
    for r in rows(raw_dir):
        key = (r.get('New Name') or r.get('STATION NAME') or '').strip()
        if not key:
            continue
        if key not in stations or _pref(r) < _pref(stations[key]):
            stations[key] = r
    for key, r in stations.items():
        e, n = fnum(r.get('EASTING')), fnum(r.get('NORTHING'))
        if not e or not n:
            continue
        lat, lng, acc = conv(e, n)
        destroyed = (r.get('DESTROYED MARK INDICATOR') or '0').strip() != '0'
        mark = (r.get('TYPE OF MARK') or '').strip()
        h_ortho = []
        if fnum(r.get('HEIGHT')) and (r.get('LEVELLING DATUM') or '').strip() == 'N':
            h_ortho.append(height(r['HEIGHT'], 'ODN', r['HEIGHT'].strip()))
        g = grid('British National Grid', r.get('EASTING'), r.get('NORTHING'))
        name = (r.get('Trig Name') or '').strip()
        if name.isdigit():
            name = ''
        yield record(
            SRC, key, lat, lng, 'h', 'osgb36',
            name=name or None,
            aliases=[a for a in {(r.get('STATION NAME') or '').strip()} if a and a != key],
            posAcc=acc,
            status='destroyed' if destroyed else 'ok',
            statusRaw=(r.get('COMMENTS') or '').strip()[:80] or None,
            hOrtho=h_ortho,
            grids=[g] if g else [],
            monument={'code': monument_from_words(mark, MONUMENT), 'text': mark.capitalize()} if mark else None,
            lastVisit=date_of(r.get('Maintained')) or date_of(r.get('Computing Date')),
        )
    log(f'{SRC}: {len(stations)} stations')
