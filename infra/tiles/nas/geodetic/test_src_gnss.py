"""Tests for the GNSS station lists: src_gl_ngl.py, src_gl_igs.py, src_eu_epn.py.

Each publishes XYZ (to the cm) and a rounded lat/lon. The display position is
computed from XYZ; it must agree with the agency's own lat/lon to within that
lat/lon's rounding, and `geo` must be the published text.
"""
import datetime
import math
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import src_eu_epn  # noqa: E402
import src_gl_igs  # noqa: E402
import src_gl_ngl  # noqa: E402

FIX = os.path.join(HERE, 'fixtures')


def metres(lat1, lng1, lat2, lng2):
    dy = (lat1 - lat2) * 111320.0
    dx = (lng1 - lng2) * 111320.0 * math.cos(math.radians(lat1))
    return math.hypot(dx, dy)


def rounding_m(decimals, lat):
    """Worst position error of a lat/lon rounded to `decimals` places."""
    half = 0.5 * 10 ** -decimals
    return math.hypot(half * 111320, half * 111320 * math.cos(math.radians(lat)))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def check(self, recs, decimals, label):
        self.assertGreaterEqual(len(recs), 10)
        worst = 0.0
        for r in recs:
            plat, plng = (float(v) for v in r['geo'].split(', '))
            d = metres(r['lat'], r['lng'], plat, plng)
            self.assertLessEqual(d, rounding_m(decimals, plat) + 0.05, r['id'])
            worst = max(worst, d)
        print(f'\n{label}: XYZ position vs published lat/lon: max deviation {worst:.2f} m '
              f'(published lat/lon has {decimals} decimals)')


class Ngl(Base):
    def test_active_only_and_positions(self):
        shutil.copy(os.path.join(FIX, 'ngl_dataholdings.txt'), os.path.join(self.tmp, 'DataHoldings.txt'))
        recs = list(src_gl_ngl.normalize(self.tmp, today=datetime.date(2026, 10, 5)))
        # The first three fixture rows (00NA…02NA) stopped before 2020: skipped.
        self.assertFalse({'00NA', '01NA', '02NA'} & {r['id'] for r in recs})
        self.assertTrue(all(r['type'] == 'gnss' for r in recs))
        self.check(recs, 4, 'NGL')


class Igs(Base):
    def test_positions(self):
        shutil.copy(os.path.join(FIX, 'igs_network.json'), os.path.join(self.tmp, 'IGSNetwork.json'))
        recs = list(src_gl_igs.normalize(self.tmp))
        self.assertTrue(all(len(r['id']) == 9 and r['aliases'] == [r['id'][:4]] for r in recs))
        self.check(recs, 3, 'IGS')


class Epn(Base):
    def test_positions(self):
        shutil.copy(os.path.join(FIX, 'epn_stationlist.html'), os.path.join(self.tmp, 'stationlist.html'))
        recs = list(src_eu_epn.normalize(self.tmp))
        self.assertEqual(recs[0]['id'], 'AAER00FRA')
        self.assertIn('17916M001', recs[0]['aliases'])
        self.check(recs, 4, 'EPN')


if __name__ == '__main__':
    unittest.main()
