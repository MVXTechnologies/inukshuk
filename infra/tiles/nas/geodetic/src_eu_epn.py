"""Europe — EUREF Permanent GNSS Network (SOURCES.md #13).

The EPN Central Bureau's station list page (its CSV is a client-side export
of the same table, `tableoverview`): 9-character ID, DOMES, status
(included / former), lat/lon to 4 decimals, XYZ to the centimetre. Former
stations are left out. Display position from XYZ; the published lat/lon
text is kept.
"""
import os
import re
from html.parser import HTMLParser

from common import download, fnum, log, record
from src_util import ecef_to_geodetic, text_of

SRC = 'eu-epn'
URL = 'https://epncb.oma.be/_networkdata/stationlist.php'


class _Table(HTMLParser):
    """Rows of the table with id `want`."""

    def __init__(self, want):
        super().__init__()
        self.want, self.inside, self.rows, self.row, self.cell = want, False, [], None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'table':
            self.inside = a.get('id') == self.want
        elif self.inside and tag == 'tr':
            self.row = []
            self.rows.append(self.row)
        elif self.inside and tag in ('td', 'th') and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if tag == 'table':
            self.inside = False
        elif tag in ('td', 'th') and self.cell is not None and self.row is not None:
            self.row.append(re.sub(r'\s+', ' ', ''.join(self.cell)).strip())
            self.cell = None

    def handle_data(self, d):
        if self.cell is not None:
            self.cell.append(d)


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    download(URL, os.path.join(raw_dir, 'stationlist.html'))


def rows(html):
    t = _Table('tableoverview')
    t.feed(html)
    if not t.rows:
        return []
    header = t.rows[0]
    return [dict(zip(header, r)) for r in t.rows[1:] if len(r) == len(header)]


def normalize(raw_dir):
    with open(os.path.join(raw_dir, 'stationlist.html'), encoding='utf-8', errors='replace') as f:
        table = rows(f.read())
    n = 0
    for r in table:
        if (r.get('Status') or '').lower() != 'included':
            continue
        x, y, z = fnum(r.get('X')), fnum(r.get('Y')), fnum(r.get('Z'))
        id9 = r.get('Name') or ''
        if x is None or y is None or z is None or len(id9) < 4:
            continue
        lat, lng, _h = ecef_to_geodetic(x, y, z)
        n += 1
        yield record(
            SRC, id9, lat, lng, 'gnss', 'itrf',
            name=(r.get('City') or '').strip() or None,
            aliases=[a for a in (id9[:4], r.get('Domes')) if a],
            geo=f"{text_of(r.get('Latitude'))}, {text_of(r.get('Longitude'))}",
            status='ok',
            statusRaw=f"EPN since {r.get('EPN Inclusion')}" if r.get('EPN Inclusion') else None,
            sheet=id9,
        )
    log(f'{SRC}: {n} included stations')
