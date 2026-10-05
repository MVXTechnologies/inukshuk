"""World — Nevada Geodetic Laboratory GNSS station list (SOURCES.md #21).

DataHoldings.txt (~23k stations, one 2.8 MB file, over HTTPS — the http://
host times out): ID, lat/lon/height, XYZ (IGS frame), first/last data date.
Only stations with data in the last ACTIVE_DAYS are kept (a station that
stopped delivering is usually dismantled). Display position from the
published XYZ (an exact conversion); the published lat/lon text is kept.
No licence; citation requested (Blewitt et al., 2018) — in the credit line.
"""
import datetime
import os

from common import download, fnum, log, record
from src_util import ecef_to_geodetic, text_of

SRC = 'gl-ngl'
URL = 'https://geodesy.unr.edu/NGLStationPages/DataHoldings.txt'
ACTIVE_DAYS = 365


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    download(URL, os.path.join(raw_dir, 'DataHoldings.txt'))


def rows(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        header = f.readline().split()
        for line in f:
            parts = line.split()
            if len(parts) < 10:
                continue
            yield dict(zip(header, parts))


def normalize(raw_dir, today=None):
    today = today or datetime.date.today()
    n = skipped = 0
    for r in rows(os.path.join(raw_dir, 'DataHoldings.txt')):
        try:
            end = datetime.date.fromisoformat(r['Dtend'])
        except (KeyError, ValueError):
            continue
        if (today - end).days > ACTIVE_DAYS:
            skipped += 1
            continue
        x, y, z = fnum(r.get('X(m)')), fnum(r.get('Y(m)')), fnum(r.get('Z(m)'))
        if x is None or y is None or z is None:
            continue
        lat, lng, _h = ecef_to_geodetic(x, y, z)
        sta = r['Sta']
        n += 1
        yield record(
            SRC, sta, lat, lng, 'gnss', 'itrf',
            aliases=[sta],
            geo=f"{text_of(r['Lat(deg)'])}, {text_of(r['Long(deg)'])}",
            hEll=fnum(r.get('Hgt(m)')), hEllText=text_of(r.get('Hgt(m)')),
            status='ok',
            statusRaw=f"data {r.get('Dtbeg')} → {r.get('Dtend')}",
            sheet=sta,
        )
    log(f'{SRC}: {n} active stations ({skipped} without data in {ACTIVE_DAYS} days skipped)')
