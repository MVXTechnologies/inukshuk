"""Tests for src_ch_swisstopo.py (and src_ch_cantons.py when present).

The LV95 → lat/lon validation needs pyproj (the pipeline image); the fixture
holds 12 real LFP1/HFP1 rows and the WGS 84 position swisstopo's own REFRAME
service gives for each (geodesy.geo.admin.ch/reframe/lv95towgs84).
"""
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import src_ch_swisstopo as ch  # noqa: E402

try:
    import pyproj  # noqa: F401

    HAVE_PYPROJ = True
except ImportError:
    HAVE_PYPROJ = False
FIX = json.load(open(os.path.join(HERE, 'fixtures', 'ch_swisstopo_rows.json'), encoding='utf-8'))


def metres(lat1, lng1, lat2, lng2):
    dy = (lat1 - lat2) * 111320.0
    dx = (lng1 - lng2) * 111320.0 * math.cos(math.radians(lat1))
    return math.hypot(dx, dy)


class Ecef(unittest.TestCase):
    def test_round_trip(self):
        # Zimmerwald-ish: lat 46.877, lng 7.465, h 956 m on GRS80.
        a, f = 6378137.0, 1 / 298.257222101
        e2 = f * (2 - f)
        lat, lng, h = math.radians(46.877), math.radians(7.465), 956.0
        n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        x = (n + h) * math.cos(lat) * math.cos(lng)
        y = (n + h) * math.cos(lat) * math.sin(lng)
        z = (n * (1 - e2) + h) * math.sin(lat)
        la, lo, hh = ch.ecef_to_geodetic(x, y, z)
        self.assertAlmostEqual(la, 46.877, places=9)
        self.assertAlmostEqual(lo, 7.465, places=9)
        self.assertAlmostEqual(hh, 956.0, places=3)


@unittest.skipUnless(HAVE_PYPROJ, 'needs pyproj')
class AgainstReframe(unittest.TestCase):
    def test_positions(self):
        self.assertGreaterEqual(len(FIX), 10)
        worst = 0.0
        for f in FIX:
            rec = ch._fixpoint(f['row'], f['layer'], 'h' if f['layer'] == 'lfp1' else 'v')
            d = metres(rec['lat'], rec['lng'], float(f['reframe']['lat']), float(f['reframe']['lon']))
            worst = max(worst, d)
        print(f'\nswisstopo LV95 → WGS 84 vs REFRAME: max deviation {worst:.3f} m over {len(FIX)} marks')
        self.assertLess(worst, 1.0)

    def test_published_values_verbatim(self):
        f = next(x for x in FIX if x['layer'] == 'hfp1')
        rec = ch._fixpoint(f['row'], 'hfp1', 'v')
        self.assertEqual(rec['grids'], [{'system': 'LV95', 'e': f['row']['E95'], 'n': f['row']['N95']}])
        self.assertEqual(rec['hOrtho'][0]['text'], f['row']['H02'])
        self.assertEqual(rec['hOrtho'][0]['datum'], 'LN02')
        self.assertTrue(rec['url'].startswith('https://api3.geo.admin.ch/featureattachments/'))
        self.assertNotIn('geo', rec)  # swisstopo publishes no lat/lon for these


@unittest.skipUnless(HAVE_PYPROJ, 'needs pyproj')
class CantonsAgainstReframe(unittest.TestCase):
    """10 real Aargau LFP2/HFP2 rows (geodienste.ch CSV) + REFRAME positions."""

    def test_positions_and_verbatim(self):
        import src_ch_cantons as cc  # noqa: PLC0415

        fix = json.load(open(os.path.join(HERE, 'fixtures', 'ch_cantons_rows.json'), encoding='utf-8'))
        self.assertGreaterEqual(len(fix), 10)
        worst = 0.0
        for f in fix:
            rec = cc.fixpoint(f['row'])
            worst = max(worst, metres(rec['lat'], rec['lng'], float(f['reframe']['lat']),
                                      float(f['reframe']['lon'])))
            self.assertEqual(rec['grids'][0]['e'], f['row']['koordinate_e'])
            if f['row']['hoehe_geom_m']:
                self.assertEqual(rec['hOrtho'][0]['text'], f['row']['hoehe_geom_m'])
            self.assertIn(rec['type'], ('h', 'v'))
            self.assertTrue(rec['url'].startswith('https://fpds2.ch/protokolle/'))
        print(f'\ngeodienste LV95 → WGS 84 vs REFRAME: max deviation {worst:.3f} m over {len(fix)} marks')
        self.assertLess(worst, 1.0)


if __name__ == '__main__':
    unittest.main()
