"""Tests for src_nl_kadaster.py / src_nl_rws.py.

RD → ETRS89 uses NSGI's RDNAPTRANS2018 grid. Validation: 12 Kadaster RDinfo
GNSS marks for which Kadaster publishes both RD x/y (mm) and ETRS89 lat/lon
(DMS); our conversion of the RD values must land on Kadaster's lat/lon.
Needs pyproj + the grid (GEODETIC_RD_GRID_DIR, e.g. /work/raw/nl-kadaster).
"""
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import src_nl_kadaster as kad  # noqa: E402
import src_nl_rws as rws  # noqa: E402
from src_util import dms_to_deg  # noqa: E402

try:
    import pyproj  # noqa: F401

    HAVE_PYPROJ = True
except ImportError:
    HAVE_PYPROJ = False
GRID_DIR = os.environ.get('GEODETIC_RD_GRID_DIR', '')
HAVE_GRID = bool(GRID_DIR) and os.path.exists(os.path.join(GRID_DIR, 'nl_nsgi_rdtrans2018.tif'))
with open(os.path.join(HERE, 'fixtures', 'nl_kadaster_pairs.json'), encoding='utf-8') as _f:
    PAIRS = json.load(_f)


def metres(lat1, lng1, lat2, lng2):
    return math.hypot((lat1 - lat2) * 111320, (lng1 - lng2) * 111320 * math.cos(math.radians(lat1)))


class Dms(unittest.TestCase):
    def test_parse(self):
        self.assertAlmostEqual(dms_to_deg('53 27 27,04098'), 53 + 27 / 60 + 27.04098 / 3600, places=12)


@unittest.skipUnless(HAVE_PYPROJ and HAVE_GRID, 'needs pyproj + RDNAPTRANS2018 grid (GEODETIC_RD_GRID_DIR)')
class RdAgainstKadaster(unittest.TestCase):
    def test_pairs(self):
        from src_util import rd_to_etrs89  # noqa: PLC0415

        conv = rd_to_etrs89(GRID_DIR)
        self.assertGreaterEqual(len(PAIRS), 10)
        worst = 0.0
        for p in PAIRS:
            lat, lng, acc = conv(p['xrd'], p['yrd'])
            self.assertIsNone(acc)
            worst = max(worst, metres(lat, lng, dms_to_deg(p['phi']), dms_to_deg(p['lambda'])))
        print(f'\nRD → ETRS89 (RDNAPTRANS2018) vs Kadaster ETRS89: max deviation {worst:.4f} m over {len(PAIRS)} marks')
        self.assertLess(worst, 0.01)

    def test_station_uses_published_etrs89(self):
        from src_util import rd_to_etrs89  # noqa: PLC0415

        p = PAIRS[0]
        rec = kad.station(p, rd_to_etrs89(GRID_DIR))
        self.assertEqual(rec['geo'], f"{p['phi'].replace(',', '.')}, {p['lambda'].replace(',', '.')}")
        self.assertEqual(rec['type'], '3d')
        self.assertEqual(rec['grids'][0], {'system': 'RD', 'e': repr(p['xrd']), 'n': repr(p['yrd'])})

    def test_nap_benchmark(self):
        from src_util import rd_to_etrs89  # noqa: PLC0415

        props = {'puntnummer': '002G0023', 'hoogte': 2.8099, 'projectdatum': '2024-02-17T00:00:00+01:00',
                 'x_rd': 208713, 'y_rd': 610420, 'status': 'ACTUEEL', 'type': 'PM', 'omschrijving': 'BDR HEEREWG 8',
                 'bereikbaar': 'J'}
        rec = rws.mark(props, rd_to_etrs89(GRID_DIR))
        self.assertEqual(rec['hOrtho'], [{'value': 2.8099, 'datum': 'NAP', 'text': '2.8099'}])
        self.assertEqual(rec['posAcc'], 1.0)  # RD published to the metre
        self.assertEqual(rec['lastVisit'], '2024-02-17')
        self.assertEqual(rec['monument']['text'], 'BDR HEEREWG 8')


if __name__ == '__main__':
    unittest.main()
