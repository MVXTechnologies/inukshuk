"""Tests for the Australian states: src_au_{nsw,qld,vic,sa,tas}.py, on real rows.

NSW, QLD, VIC and SA publish GDA2020 lat/lon: the display position and `geo`
must be exactly the published values. Tasmania publishes MGA2020 E/N only:
our inverse projection is compared with the GDA2020 lat/lon theLIST's own
server returns for the same marks (needs pyproj).
"""
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import src_au_nsw  # noqa: E402
import src_au_qld  # noqa: E402
import src_au_sa  # noqa: E402
import src_au_vic  # noqa: E402

try:
    import pyproj  # noqa: F401

    HAVE_PYPROJ = True
except ImportError:
    HAVE_PYPROJ = False


def fixture(name):
    with open(os.path.join(HERE, 'fixtures', name), encoding='utf-8') as f:
        return json.load(f)


def metres(lat1, lng1, lat2, lng2):
    dy = (lat1 - lat2) * 111320.0
    dx = (lng1 - lng2) * 111320.0 * math.cos(math.radians(lat1))
    return math.hypot(dx, dy)


class Nsw(unittest.TestCase):
    def test_published_values(self):
        rows = fixture('au_nsw_marks.json')
        self.assertGreaterEqual(len(rows), 10)
        for f in rows:
            a = f['attributes']
            r = src_au_nsw.mark(a)
            self.assertEqual((r['lat'], r['lng']), (round(a['latitude'], 8), round(a['longitude'], 8)))
            self.assertEqual(r['geo'], f"{a['latitude']!r}, {a['longitude']!r}")
            self.assertEqual(r['id'], f"{a['marktype']}{a['marknumber']}")
            if a['ahdheight_label']:
                self.assertEqual(r['hOrtho'][0], {'value': float(a['ahdheight_label']), 'datum': 'AHD',
                                                  'text': a['ahdheight_label']})
            self.assertEqual(r['grids'][0]['e'], a['mgaeasting_label'])
        destroyed = [src_au_nsw.mark(f['attributes']) for f in rows if f['attributes']['markstatus'] == 'D']
        self.assertTrue(destroyed and all(r['status'] == 'destroyed' for r in destroyed))


class Qld(unittest.TestCase):
    def test_published_values(self):
        fx = fixture('au_qld_marks.json')
        n = 0
        P = src_au_qld.P
        for layer, rows in fx.items():
            for f in rows:
                a = f['attributes']
                r = src_au_qld.mark(a, layer)
                self.assertEqual(r['geo'], f"{a[P + 'gda2020latitude']!r}, {a[P + 'gda2020longitude']!r}")
                self.assertEqual(r['lat'], round(a[P + 'gda2020latitude'], 8))
                # The report name zero-pads the mark id to 6 digits (SCR051848).
                self.assertTrue(r['url'].endswith(f"SCR{a[P + 'mrk_id'].zfill(6)}.pdf"))
                if layer == 'cors':
                    self.assertEqual(r['type'], 'gnss')
                if layer == 'gda_scaled':
                    self.assertGreaterEqual(r['posAcc'], 10)
                if a[P + 'ahdheight'] is not None:
                    self.assertEqual(r['hOrtho'][0]['datum'], 'AHD')
                n += 1
        self.assertGreaterEqual(n, 10)


class Vic(unittest.TestCase):
    def test_published_values(self):
        rows = fixture('au_vic_marks.json')
        self.assertGreaterEqual(len(rows), 10)
        for f in rows:
            a = f['attributes']
            r = src_au_vic.mark(a)
            self.assertEqual(r['geo'], f"{a['gda2020_latitude_dms']!r}, {a['gda2020_longitude_dms']!r}")
            if a.get('ahd_height'):
                self.assertEqual(r['hOrtho'][0]['text'], a['ahd_height'].strip())
            if a.get('gda2020_ellipsoid_height'):
                self.assertEqual(r['hEllText'], a['gda2020_ellipsoid_height'].strip())
        statuses = {src_au_vic.mark(f['attributes'])['status'] for f in rows}
        self.assertIn('ok', statuses)


class Sa(unittest.TestCase):
    def test_published_values(self):
        rows = fixture('au_sa_rows.json')
        self.assertGreaterEqual(len(rows), 10)
        for row in rows:
            r = src_au_sa.mark(row)
            self.assertAlmostEqual(r['lat'], float(row['latitude']), places=8)
            self.assertAlmostEqual(r['lng'], float(row['longitude']), places=8)
            # float noise gone: "-34.915806269999997" → "-34.91580627"
            self.assertLessEqual(len(r['geo'].split(', ')[0].split('.')[1]), 9)
            if row['v_datum'] == 'A':
                self.assertEqual(r['hOrtho'][0]['datum'], 'AHD')
            else:
                self.assertEqual(r['hOrtho'], [])  # 'M' or blank: not guessed
            if row['gone'] == 'Y':
                self.assertEqual(r['status'], 'destroyed')
            if row['h_fixing'] == 'SCA':
                self.assertEqual(r['posAcc'], 30.0)


@unittest.skipUnless(HAVE_PYPROJ, 'needs pyproj')
class TasAgainstTheList(unittest.TestCase):
    """theLIST's server answers geometry from its GDA94 storage (asked for GDA94
    geographic, outSR 4283), so the projection is checked on the same data:
    our MGA94 inverse of the published GDA94 E/N vs the server's lat/lon. The
    display position applies the identical MGA inverse to the GDA2020 E/N."""

    def test_projection_against_server(self):
        import src_au_tas  # noqa: PLC0415
        from src_util import to_wgs84  # noqa: PLC0415

        rows = fixture('au_tas_marks.json')
        self.assertGreaterEqual(len(rows), 10)
        worst = 0.0
        for f in rows:
            a = f['attributes']
            lat, lng = to_wgs84(28300 + int(a['MGA_ZONE']), a['GDA94_E'], a['GDA94_N'])
            worst = max(worst, metres(lat, lng, f['geometry']['y'], f['geometry']['x']))
            r = src_au_tas.mark(a)
            self.assertEqual(r['grids'][0]['e'], repr(a['GDA2020_E']))
            # GDA2020 vs GDA94 for the same mark: the ~1.5–1.8 m continental shift.
            self.assertLess(metres(r['lat'], r['lng'], lat, lng), 2.5)
        print(f'\nTasmania MGA inverse vs theLIST server (GDA94): max deviation {worst:.4f} m over {len(rows)} marks')
        self.assertLess(worst, 0.01)


if __name__ == '__main__':
    unittest.main()
