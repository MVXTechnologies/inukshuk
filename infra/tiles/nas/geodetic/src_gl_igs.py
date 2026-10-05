"""World — IGS network (SOURCES.md #22).

files.igs.org/pub/station/general/IGSNetwork.json: ~535 current stations
keyed by their 9-character ID, XYZ to the centimetre and lat/lon rounded to
3 decimals. Display position from XYZ (an exact conversion); the published
lat/lon/height text is kept as published.
"""
import json
import os

from common import download, fnum, log, record
from src_util import ecef_to_geodetic, text_of

SRC = 'gl-igs'
URL = 'https://files.igs.org/pub/station/general/IGSNetwork.json'


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    download(URL, os.path.join(raw_dir, 'IGSNetwork.json'))


def normalize(raw_dir):
    with open(os.path.join(raw_dir, 'IGSNetwork.json'), encoding='utf-8') as f:
        net = json.load(f)
    n = 0
    for id9, s in net.items():
        x, y, z = fnum(s.get('X')), fnum(s.get('Y')), fnum(s.get('Z'))
        if x is None or y is None or z is None:
            continue
        lat, lng, _h = ecef_to_geodetic(x, y, z)
        n += 1
        yield record(
            SRC, id9, lat, lng, 'gnss', 'itrf',
            aliases=[id9[:4]],
            geo=f"{text_of(s.get('Latitude'))}, {text_of(s.get('Longitude'))}"
            if s.get('Latitude') is not None else None,
            hEll=fnum(s.get('Height')), hEllText=text_of(s.get('Height')),
            monument={'code': 'antenna', 'text': (s.get('Antenna') or {}).get('Name')}
            if (s.get('Antenna') or {}).get('Name') else None,
            status='ok',
            sheet=id9,
        )
    log(f'{SRC}: {n} stations')
