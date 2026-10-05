"""Great Britain — Ordnance Survey benchmark archive (SOURCES.md #7; frozen 2022).

517k levelling benchmarks. Positions are given only to 10 m (4-digit E/N in
the 100 km square): the mark sits somewhere in that 10 m square, so we place
it at the square's centre and say ±10 m (posAcc 10 → drawn from z15 only).
Heights: only DATUM 'N' (Newlyn = ODN, 98.6 % of rows) is published as a
height; the island / historical datum codes are undocumented and not guessed.
The archive's description is kept verbatim (e.g. "NBM RIVET ROCK SE SIDE RD").
"""
import csv
import io
import os
import zipfile

from common import download, fnum, log, record
from src_util import date_of, fetch_ostn15, grid, height, monument_from_words, osgb_to_wgs84

SRC = 'uk-os-bm'
URL = 'https://www.ordnancesurvey.co.uk/documents/resources/CompleteBenchMarkArchive.zip'
# 100 km grid squares: letter pair → (E, N) of the square's SW corner in metres.
_L = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
MONUMENT = (
    (('rivet', 'pa bolt', 'stud bolt', 'bolt', 'pivot'), 'bolt'), (('fl br', 'bracket', 'fbm'), 'disk'),
    (('brass rod',), 'rod'), (('cut',), 'cut'),
)


def square_origin(letters):
    letters = letters.strip().upper()
    if len(letters) != 2 or any(c not in _L for c in letters):
        return None
    l1, l2 = _L.index(letters[0]), _L.index(letters[1])
    e100 = ((l1 - 2) % 5) * 5 + (l2 % 5)
    n100 = (19 - (l1 // 5) * 5) - (l2 // 5)
    return e100 * 100000, n100 * 100000


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    download(URL, os.path.join(raw_dir, 'CompleteBenchMarkArchive.zip'))
    fetch_ostn15(raw_dir)


def rows(raw_dir):
    """The archive is Deflate64-compressed, which stdlib zipfile can't read:
    use zipfile-deflate64 when the image has it, else the CSV extracted next to
    the zip (`7z e CompleteBenchMarkArchive.zip` on the NAS host; frozen since 2022)."""
    csv_path = os.path.join(raw_dir, 'CompleteBenchMarkArchive.csv')
    zpath = os.path.join(raw_dir, 'CompleteBenchMarkArchive.zip')
    try:
        import zipfile_deflate64  # noqa: F401, PLC0415 — patches zipfile
    except ImportError:
        pass
    try:
        with zipfile.ZipFile(zpath) as z:
            name = next(n for n in z.namelist() if n.lower().endswith('.csv'))
            with z.open(name) as f:
                yield from csv.DictReader(io.TextIOWrapper(f, 'utf-8-sig', errors='replace'))
            return
    except NotImplementedError:
        if not os.path.exists(csv_path):
            raise RuntimeError(f'{zpath} is Deflate64: extract it (7z e) to {csv_path}') from None
    with open(csv_path, encoding='utf-8-sig', errors='replace') as f:
        yield from csv.DictReader(f)


def normalize(raw_dir):
    conv = osgb_to_wgs84(raw_dir)
    seen = {}
    n_out = 0
    for r in rows(raw_dir):
        sq = square_origin(r.get('NG LETTERS') or '')
        e4, n4 = (r.get('EASTING') or '').strip(), (r.get('NORTHING') or '').strip()
        if sq is None or not e4.isdigit() or not n4.isdigit():
            continue
        e = sq[0] + int(e4) * 10 + 5
        n = sq[1] + int(n4) * 10 + 5
        lat, lng, _acc = conv(e, n)
        base = f"{r['NG LETTERS'].strip()}{e4}{n4}"
        k = seen.get(base, 0) + 1
        seen[base] = k
        ident = base if k == 1 else f'{base}-{k}'
        h_ortho = []
        if fnum(r.get('HEIGHT')) is not None and (r.get('DATUM') or '').strip() == 'N':
            h_ortho.append(height(r['HEIGHT'], 'ODN', r['HEIGHT'].strip()))
        # As published: the 100 km square + a 4-digit (10 m) easting / northing.
        g = grid(f"British National Grid {r['NG LETTERS'].strip()} (10 m)", e4, n4)
        desc = ' '.join((r.get('DESCRIPTION') or '').split())
        mark = (r.get('TYPE OF MARK') or '').strip()
        monument = None
        if desc or mark:
            monument = {'code': monument_from_words(f'{mark} {desc}', MONUMENT, 'cut'),
                        'text': desc or mark}
        n_out += 1
        # OS stopped maintaining benchmarks in 1989: whether a mark survives is
        # unknown, except where the archive's own note says it was destroyed.
        destroyed = 'DESTROYED' in desc.upper() and 'TO BE DESTROYED' not in desc.upper()
        yield record(
            SRC, ident, lat, lng, 'v', 'osgb36',
            posAcc=10.0,
            status='destroyed' if destroyed else 'unknown',
            statusRaw='Archive (not maintained since 1989)',
            hOrtho=h_ortho,
            grids=[g] if g else [],
            monument=monument,
            lastVisit=date_of(r.get('VERIFIED DATE')),
        )
    log(f'{SRC}: {n_out} benchmarks')
