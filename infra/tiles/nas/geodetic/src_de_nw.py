"""Germany, North Rhine-Westphalia — Höhenfestpunkte (SOURCES.md #11), dl-de/zero-2.0.

opengeodata.nrw.de …/rb/fd/hfp_pl_csv/hfp_pl.csv (~87.7k levelling
benchmarks, no header): number; location text; ETRS89/UTM zone 32 E with the
zone prefix ("32476176,928", EPSG:4647) and N; DHHN2016 height; gravity.
No lat/lon is published: the display position is the UTM inverse (a pure
projection in ETRS89, no datum shift — the same tmerc inverse validated to
0.1 mm against Tasmania's server in test_src_au.py).
"""
import csv
import io
import os

from common import download, fnum, log, record
from src_util import grid, height, text_of, to_wgs84

SRC = 'de-nw'
URL = 'https://www.opengeodata.nrw.de/produkte/geobasis/rb/fd/hfp_pl_csv/hfp_pl.csv'


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    download(URL, os.path.join(raw_dir, 'hfp_pl.csv'))


def mark(row):
    if len(row) < 5:
        return None
    num, place, e_txt, n_txt, h_txt = (c.strip() for c in row[:5])
    e, n = fnum(e_txt), fnum(n_txt)
    if not num or e is None or n is None:
        return None
    # "32476176,928": zone 32 prefixed to the easting (EPSG:4647).
    lat, lng = to_wgs84(25832, e - 32_000_000 if e > 32_000_000 else e, n)
    h = height(h_txt, 'DHHN2016', text_of(h_txt))
    g = grid('ETRS89 UTM 32 (EPSG:4647)', e_txt, n_txt)
    return record(
        SRC, num, lat, lng, 'v', 'etrs89',
        name=place or None,  # the agency's location label, e.g. "Preuss-Ströhen,Kirche"
        grids=[g] if g else [],
        status='ok',
        hOrtho=[h] if h else [],
    )


def normalize(raw_dir):
    n = 0
    with open(os.path.join(raw_dir, 'hfp_pl.csv'), encoding='utf-8-sig', errors='replace') as f:
        for row in csv.reader(io.StringIO(f.read()), delimiter=';'):
            rec = mark(row)
            if rec:
                n += 1
                yield rec
    log(f'{SRC}: {n} benchmarks')
