"""Tests for src_uk_os_trig.py / src_uk_os_bm.py.

    python3 -m unittest discover -s infra/tiles/nas/geodetic -p 'test_src_*.py'

The OSTN15 validation needs pyproj and the grid (both in the pipeline image):
set GEODETIC_OSTN15_DIR to a directory holding OSTN15_NTv2_OSGBtoETRS.tif
(e.g. /work/raw/uk-os-trig on the NAS); it is skipped otherwise.
"""
import csv
import math
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import src_uk_os_bm  # noqa: E402
import src_uk_os_trig  # noqa: E402
from src_util import osgb_to_wgs84  # noqa: E402

try:
    import pyproj  # noqa: F401

    HAVE_PYPROJ = True
except ImportError:
    HAVE_PYPROJ = False
GRID_DIR = os.environ.get('GEODETIC_OSTN15_DIR', '')
HAVE_GRID = bool(GRID_DIR) and os.path.exists(os.path.join(GRID_DIR, 'OSTN15_NTv2_OSGBtoETRS.tif'))
FIX = os.path.join(HERE, 'fixtures')


def metres(lat1, lng1, lat2, lng2):
    dy = (lat1 - lat2) * 111320.0
    dx = (lng1 - lng2) * 111320.0 * math.cos(math.radians(lat1))
    return math.hypot(dx, dy)


class Squares(unittest.TestCase):
    def test_origins(self):
        self.assertEqual(src_uk_os_bm.square_origin('SV'), (0, 0))
        self.assertEqual(src_uk_os_bm.square_origin('TQ'), (500000, 100000))
        self.assertEqual(src_uk_os_bm.square_origin('HP'), (400000, 1200000))
        self.assertEqual(src_uk_os_bm.square_origin('NN'), (200000, 700000))
        self.assertIsNone(src_uk_os_bm.square_origin('I'))


@unittest.skipUnless(HAVE_PYPROJ and HAVE_GRID, 'needs pyproj + the OSTN15 grid (GEODETIC_OSTN15_DIR)')
class Ostn15AgainstOrdnanceSurvey(unittest.TestCase):
    """OS's own OSTN15 test points (OSTN15/OSGM15 developer pack): published
    OSGB36 E/N and the ETRS89 lat/lon OS gives for them."""

    def test_published_pairs(self):
        conv = osgb_to_wgs84(GRID_DIR)
        worst = 0.0
        rows = list(csv.DictReader(open(os.path.join(FIX, 'os_ostn15_testpoints.csv'))))
        self.assertGreaterEqual(len(rows), 10)
        for r in rows:
            lat, lng, acc = conv(float(r['osgb_e']), float(r['osgb_n']))
            self.assertIsNone(acc)
            worst = max(worst, metres(lat, lng, float(r['etrs89_lat']), float(r['etrs89_lon'])))
        print(f'\nOSTN15 vs OS published ETRS89: max deviation {worst:.4f} m over {len(rows)} points')
        self.assertLess(worst, 0.02)


def _zip(src_csv, inner, dst_zip):
    with zipfile.ZipFile(dst_zip, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(src_csv, inner)


@unittest.skipUnless(HAVE_PYPROJ, 'needs pyproj')
class Normalize(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        if HAVE_GRID:
            shutil.copy(os.path.join(GRID_DIR, 'OSTN15_NTv2_OSGBtoETRS.tif'), self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_trig(self):
        _zip(os.path.join(FIX, 'uk_os_trig_rows.csv'), 'CompleteTrigArchive.csv',
             os.path.join(self.tmp, 'CompleteTrigArchive.zip'))
        recs = {r['id']: r for r in src_uk_os_trig.normalize(self.tmp)}
        pillar = recs['NN96S001']
        self.assertEqual(pillar['name'], "A' Bhuideaneach Bheag")
        self.assertEqual(pillar['monument'], {'code': 'pillar', 'text': 'Pillar'})
        self.assertEqual(pillar['hOrtho'], [{'value': 936.345, 'datum': 'ODN', 'text': '936.345'}])
        self.assertEqual(pillar['grids'], [{'system': 'British National Grid', 'e': '266068.401', 'n': '777600.466'}])
        self.assertNotIn('geo', pillar)  # OS publishes no lat/lon for trigs
        # No levelled height → no height (a '0' is not a height).
        self.assertEqual(recs['NM52H283']['hOrtho'], [])
        # Two rows for one station (bolt + centre): one mark, destroyed.
        self.assertEqual(recs['SD80T150']['status'], 'destroyed')
        self.assertEqual(sum(1 for k in recs if k == 'SD80T150'), 1)

    def test_benchmarks(self):
        shutil.copy(os.path.join(FIX, 'uk_os_bm_rows.csv'),
                    os.path.join(self.tmp, 'CompleteBenchMarkArchive.csv'))
        _zip(os.path.join(FIX, 'uk_os_bm_rows.csv'), 'CompleteBenchMarkArchive.csv',
             os.path.join(self.tmp, 'CompleteBenchMarkArchive.zip'))
        recs = {r['id']: r for r in src_uk_os_bm.normalize(self.tmp)}
        first = recs['HP51970035']
        self.assertEqual(first['posAcc'], 10.0)
        self.assertEqual(first['monument']['text'], 'NBM RIVET ROCK SE SIDE RD')
        # Datum code B (undocumented island datum): no height rather than a guessed label.
        self.assertEqual(first['hOrtho'], [])
        self.assertEqual(first['grids'][0]['e'], '5197')
        destroyed = recs['NH51282909']
        self.assertEqual(destroyed['status'], 'destroyed')
        self.assertEqual(destroyed['hOrtho'], [{'value': 36.0274, 'datum': 'ODN', 'text': '36.0274'}])
        self.assertEqual(recs['HU18655782']['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
