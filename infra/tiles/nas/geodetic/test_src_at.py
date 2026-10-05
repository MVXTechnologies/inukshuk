"""Tests for src_at_bev.py.

Levelling benchmarks (AT_HP) publish MGI Gauss-Krüger E/N only; we convert
them with BEV's GIS-Grid. Validation: 12 benchmarks that BEV also lists as a
mark of a trig point (IDENT_PUNKT 'TP7-41H1'), whose ETRS89 lat/lon BEV
publishes in AT_ETRS89_TP. Needs pyproj and the grid: set GEODETIC_BEV_GRID_DIR
(e.g. /work/raw/at-bev on the NAS); skipped otherwise.
"""
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import src_at_bev as at  # noqa: E402

try:
    import pyproj  # noqa: F401

    HAVE_PYPROJ = True
except ImportError:
    HAVE_PYPROJ = False
GRID_DIR = os.environ.get('GEODETIC_BEV_GRID_DIR', '')
HAVE_GRID = bool(GRID_DIR) and os.path.exists(os.path.join(GRID_DIR, 'at_bev_AT_GIS_GRID_2021_09_28.tif'))
with open(os.path.join(HERE, 'fixtures', 'at_bev_hp_vs_tp.json'), encoding='utf-8') as _f:
    FIX = json.load(_f)


def metres(lat1, lng1, lat2, lng2):
    return math.hypot((lat1 - lat2) * 111320, (lng1 - lng2) * 111320 * math.cos(math.radians(lat1)))


@unittest.skipUnless(HAVE_PYPROJ and HAVE_GRID, 'needs pyproj + BEV grid (GEODETIC_BEV_GRID_DIR)')
class HpAgainstPublishedEtrs89(unittest.TestCase):
    def test_positions(self):
        from src_util import mgi_gk_to_etrs89  # noqa: PLC0415

        conv = mgi_gk_to_etrs89(GRID_DIR)
        self.assertGreaterEqual(len(FIX), 10)
        worst = {}
        for f in FIX:
            rec = at.hoehe(f['hp'], conv)
            d = metres(rec['lat'], rec['lng'], float(f['tp']['BREITE']), float(f['tp']['LAENGE']))
            cls = f['hp']['KOORD_LAGE_BEST']
            worst[cls] = max(worst.get(cls, 0), d)
            self.assertEqual(rec['hOrtho'][0], {'value': float(f['hp']['HOEHE']), 'datum': 'GHA (Adria)',
                                                'text': f['hp']['HOEHE']})
            self.assertEqual(rec['grids'][0]['e'], f['hp']['RECHTSWERT'])
            if cls == 'T':
                self.assertIsNone(rec.get('posAcc'))
            else:
                self.assertGreaterEqual(rec['posAcc'], d)
        print('\nBEV HP (MGI GK + GIS-Grid) vs BEV ETRS89 of the same mark: max deviation ' +
              ', '.join(f'class {k} {v:.3f} m' for k, v in sorted(worst.items())))
        self.assertLess(worst.get('T', 0), 0.1)


class Designation(unittest.TestCase):
    def test_ident(self):
        self.assertEqual(at._ident({'PUNKTTYP': 'TP', 'OeK50_BMN_NR': '40', 'PUNKTNUMMER': '497'}), 'TP 497-40')


if __name__ == '__main__':
    unittest.main()
