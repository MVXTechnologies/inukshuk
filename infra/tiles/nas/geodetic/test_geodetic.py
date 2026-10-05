"""Tests for the geodetic-points pipeline (wave 1: Québec, NRCan, NGS, OSM; the
build steps).

    python3 -m unittest discover -s infra/tiles/nas/geodetic -p 'test_*.py'

The VALIDATION cases compare our normalized values with the agency's own
published values on real rows (fixtures/): the card shows agency values
verbatim, and the only thing we compute — the display lat/lng — must land on
the agency's published position. Each prints its max deviation.
"""
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
FX = os.path.join(HERE, 'fixtures')
APP_CATALOG = os.path.join(HERE, '..', '..', '..', '..', 'src', 'core', 'geodetic', 'catalog-v1.json')

import catalog  # noqa: E402
import nrcan  # noqa: E402
import ngs  # noqa: E402
import qc  # noqa: E402
from common import haversine_m, record  # noqa: E402
from dedupe import dedupe, jaro_winkler  # noqa: E402
from ladder import CELL_PX, LADDER_MAX, assign_minzoom, world_px  # noqa: E402
from tiles import feature_line, props  # noqa: E402


def tm_forward(lat, lon, lon0, k0, fe, fn=0.0, a=6378137.0, f=1 / 298.257222101):
    """Transverse Mercator (Krüger n-series, mm-exact within a zone) — an
    independent check of the grid values we read off the Québec sheets."""
    n = f / (2 - f)
    big_a = a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64)
    alpha = (n / 2 - 2 * n ** 2 / 3 + 5 * n ** 3 / 16, 13 * n ** 2 / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240)
    phi, lam = math.radians(lat), math.radians(lon - lon0)
    c = 2 * math.sqrt(n) / (1 + n)
    t = math.sinh(math.atanh(math.sin(phi)) - c * math.atanh(c * math.sin(phi)))
    xi = math.atan2(t, math.cos(lam))
    eta = math.atanh(math.sin(lam) / math.sqrt(1 + t * t))
    e = eta + sum(al * math.cos(2 * j * xi) * math.sinh(2 * j * eta) for j, al in enumerate(alpha, 1))
    nn = xi + sum(al * math.sin(2 * j * xi) * math.cosh(2 * j * eta) for j, al in enumerate(alpha, 1))
    return fe + k0 * big_a * e, fn + k0 * big_a * nn


def dms_text_to_deg(s):
    """'43 57 56.12345 (N)' / '073 07 00.     (W)' → signed degrees."""
    parts = s.replace('(', ' ').replace(')', ' ').split()
    d, m, sec, hemi = parts[0], parts[1], parts[2], parts[3]
    v = int(d) + int(m) / 60 + float(sec) / 3600
    return -v if hemi in ('S', 'W') else v


class CatalogSync(unittest.TestCase):
    def test_app_bundles_the_same_catalogue(self):
        with open(APP_CATALOG, encoding='utf-8') as f:
            app = json.load(f)
        self.assertEqual(app, catalog.catalog(), 'run: build.py catalog src/core/geodetic/catalog-v1.json')

    def test_indices_are_unique(self):
        for table in (catalog.SOURCES, catalog.DATUMS, catalog.VDATUMS):
            keys = [row[0] for row in table]
            self.assertEqual(len(keys), len(set(keys)))


class QuebecBulkValidation(unittest.TestCase):
    """Bulk layer: published Québec Lambert x/y → our display lat/lng, against
    the agency's own lon/lat product for the same marks."""

    def test_lambert_inverse_matches_agency_lonlat(self):
        rows = json.load(open(os.path.join(FX, 'qc_bulk.json')))
        self.assertGreaterEqual(len(rows), 10)
        worst = 0.0
        for r in rows:
            lat, lng = qc.lambert_to_wgs84(r['x'], r['y'])
            worst = max(worst, haversine_m(lat, lng, r['lat'], r['lon']))
        print(f'\n  qc-mrnf bulk: max |display − agency lon/lat| = {worst * 1000:.3f} mm over {len(rows)} marks')
        self.assertLess(worst, 0.001)


class QuebecSheetValidation(unittest.TestCase):
    """Datasheets: everything read off the sheet is the sheet's own digits, and
    the published UTM / SCOPQ pair belongs to the published lat/lon."""

    @classmethod
    def setUpClass(cls):
        cls.sheets = json.load(open(os.path.join(FX, 'qc_fiches.json'), encoding='utf-8'))

    def test_grids_and_heights_are_verbatim_and_consistent(self):
        with_grid = 0
        worst = 0.0
        for s in self.sheets:
            f = qc.parse_fiche(s['text'])
            for key in ('hCGVD2013', 'hCGVD28', 'hEll'):
                if key in f:
                    self.assertIsInstance(f[key], str)
                    # the same digits, decimal comma and all, are on the sheet
                    self.assertIn(f[key].replace('.', ','), s['text'].replace(' ', ''), (s['m'], key))
            if 'grids' not in f:
                continue
            with_grid += 1
            self.assertIn('geo', f)
            utm, mtm = f['grids']
            self.assertTrue(utm['system'].startswith('UTM zone '), utm)
            self.assertTrue(mtm['system'].startswith('MTM zone '), mtm)
            uz = int(utm['system'].split()[2].rstrip('N'))
            mz = int(mtm['system'].split()[2])
            for g, (lon0, k0, fe) in ((utm, (uz * 6 - 183, 0.9996, 500000.0)),
                                      (mtm, (-(49.5 + 3 * mz), 0.9999, 304800.0))):
                e, n = tm_forward(f['lat'], f['lng'], lon0, k0, fe)
                worst = max(worst, abs(e - float(g['e'])), abs(n - float(g['n'])))
                # verbatim: '5 186 200,480' keeps its trailing zero
                self.assertIn(g['n'].replace('.', ','), s['text'].replace(' ', ''))
        print(f'\n  qc-mrnf sheets: published lat/lon vs published UTM/SCOPQ: max {worst * 1000:.2f} mm '
              f'over {with_grid} sheets')
        self.assertGreaterEqual(with_grid, 9)
        self.assertLess(worst, 0.01)

    def test_display_position_is_the_published_dms(self):
        worst = 0.0
        for s in self.sheets:
            f = qc.parse_fiche(s['text'])
            if 'geo' not in f:
                continue
            la, lo = f['geo'].split(', ')
            # '46° 48' 47.36926" N'
            def deg(t):
                d, m, sec = t.replace('°', '').replace("'", '').replace('"', '').split()[:3]
                return int(d) + int(m) / 60 + float(sec) / 3600
            worst = max(worst, haversine_m(deg(la), -deg(lo), f['lat'], f['lng']))
        print(f'\n  qc-mrnf sheets: display vs published DMS: max {worst * 1000:.3f} mm')
        self.assertLess(worst, 0.001)

    def test_vertical_only_sheet(self):
        vert = [s for s in self.sheets if 'SCOPQ' not in s['text']]
        self.assertTrue(vert)
        for s in vert:
            f = qc.parse_fiche(s['text'])
            self.assertNotIn('grids', f)
            self.assertIn('hCGVD2013', f)

    def test_monument_wording_is_verbatim(self):
        f = qc.parse_fiche(self.sheets[0]['text'])
        self.assertIn(f['monument'].split()[0], self.sheets[0]['text'])
        self.assertEqual(qc.monument_code('Médaillon plat ancré(e) sur un trottoir de béton'), 'disk')
        self.assertEqual(qc.monument_code('Boulon de cuivre ancré(e) dans paroi'), 'bolt')

    def test_status(self):
        self.assertEqual(qc.status_of('En bon état', 'Planimétrie'), 'ok')
        self.assertEqual(qc.status_of('Remplacé par 12345', 'Planimétrie'), 'destroyed')
        self.assertEqual(qc.status_of('En bon état', 'Détruit'), 'destroyed')
        self.assertEqual(qc.status_of('Non retrouvé', 'Altimétrie'), 'notFound')


class NgsValidation(unittest.TestCase):
    """NGS: our display lat/lng (DEC_LAT/DEC_LON) against NGS's own DMS text."""

    def test_rows(self):
        rows = json.load(open(os.path.join(FX, 'ngs_rows.json')))
        self.assertGreaterEqual(len(rows), 10)
        worst = 0.0
        for r in rows:
            rec = ngs.row_to_record(r)
            self.assertIsNotNone(rec)
            lat, lng = dms_text_to_deg(r['LATITUDE']), dms_text_to_deg(r['LONGITUDE'])
            # the DMS text carries as many decimals as NGS publishes: allow two
            # units of its last digit (both axes, and NGS's own rounding of DEC_*)
            # (+ 1 mm: the display position is kept to 1e-8°)
            sec = r['LATITUDE'].split('(')[0].split()[2]
            decimals = len(sec.split('.')[1]) if '.' in sec else 0
            tol = 2 * 10 ** -decimals / 3600 * 111320 + 1e-3
            d = haversine_m(rec['lat'], rec['lng'], lat, lng)
            self.assertLessEqual(d, tol, r['PID'])
            worst = max(worst, d)
            self.assertEqual(rec['geo'], ngs.published_geo(r))
            for h in rec['hOrtho']:
                self.assertEqual(h['text'], r['ORTHO_HT'].strip())
        print(f'\n  us-ngs: display vs published DMS text: max {worst * 1000:.2f} mm over {len(rows)} marks')

    def test_datums(self):
        self.assertEqual(ngs.datum_of('NAD 83', '(2011)'), 'nad83-2011')
        self.assertEqual(ngs.datum_of('NAD 83', '(1986)'), 'nad83-1986')
        self.assertEqual(ngs.datum_of('NAD 83', '(1996)'), 'nad83-harn')
        self.assertEqual(ngs.datum_of('NAD 27', ''), 'nad27')

    def test_monument_words(self):
        m = ngs.monument_of('DB = BENCH MARK DISK', '7 = SET IN TOP OF CONCRETE MONUMENT')
        self.assertEqual(m['code'], 'disk')
        self.assertEqual(m['text'], 'Bench mark disk, set in top of concrete monument')


class NrcanValidation(unittest.TestCase):
    """NRCan: the CSV export IS the published product; we must reproduce it."""

    def test_rows(self):
        recs = list(nrcan.normalize(os.path.join(FX, 'nrcan')))
        self.assertGreaterEqual(len(recs), 10)
        import csv  # noqa: PLC0415

        rows = {r['Unique Number']: r for r in csv.DictReader(open(os.path.join(FX, 'nrcan', 'details.csv'),
                                                                  encoding='utf-8'))}
        worst = 0.0
        for rec in recs:
            r = rows[rec['id']]
            d = haversine_m(rec['lat'], rec['lng'], float(r['Latitude']), -abs(float(r['Longitude'])))
            worst = max(worst, d)
            self.assertLess(rec['lng'], 0, 'west longitudes come back positive')
            self.assertIn(r['Latitude'].strip(), rec['geo'])
            for h in rec['hOrtho']:
                self.assertEqual(h['text'], r[h['datum']].strip())
            self.assertEqual(rec['datum'], nrcan.datum_of(r['Reference system']))
            if rec['datum'] != 'nad83csrs':
                self.assertEqual(rec['posAcc'], 10.0)
        print(f'\n  ca-nrcan: display vs published CSV: max {worst * 1000:.3f} mm over {len(recs)} marks')
        self.assertLess(worst, 0.001)


def rec(src, ident, lat, lng, type_='h', **kw):
    return record(src, ident, lat, lng, type_, kw.pop('datum', 'nad83csrs'), **kw)


class Dedupe(unittest.TestCase):
    def test_id_match_beats_distance(self):
        # NRCan publishes benchmarks tens of metres off their MRNF twin.
        a = rec('qc-mrnf', '82H0380', 46.733, -71.370, 'v')
        b = rec('ca-nrcan', '0023010', 46.7333, -71.3703, 'v', aliases=['82H0380'])
        stats = {}
        kept = dedupe([b, a], stats)
        self.assertEqual([k['uid'] for k in kept], ['qc-mrnf:82H0380'])
        self.assertEqual(stats, {'ca-nrcan->qc-mrnf:id': 1})

    def test_benchmark_never_merges_into_trig_on_distance(self):
        a = rec('qc-mrnf', 'A1', 46.8, -71.2, 'h')
        b = rec('ca-nrcan', 'B2', 46.80001, -71.2, 'v')  # ~1 m away
        self.assertEqual(len(dedupe([a, b])), 2)

    def test_same_type_within_3m_merges(self):
        a = rec('qc-mrnf', 'A1', 46.8, -71.2, 'h')
        b = rec('us-ngs', 'PQ1234', 46.80001, -71.2, 'h')
        self.assertEqual([k['src'] for k in dedupe([a, b])], ['qc-mrnf'])

    def test_osm_twin_never_revives_a_destroyed_mark(self):
        a = rec('qc-mrnf', '81KM003', 46.851, -71.238, '3d', status='destroyed')
        o = rec('osm', '123', 46.85105, -71.23805, 'u', datum='wgs84', aliases=['81KM003'])
        kept = dedupe([o, a])
        self.assertEqual([k['src'] for k in kept], ['qc-mrnf'])
        self.assertEqual(kept[0]['status'], 'destroyed')

    def test_osm_far_away_survives(self):
        a = rec('qc-mrnf', 'A1', 46.8, -71.2, 'h')
        o = rec('osm', '9', 46.81, -71.2, 'u', datum='wgs84')
        self.assertEqual(len(dedupe([a, o])), 2)

    def test_jaro_winkler(self):
        self.assertGreater(jaro_winkler('MARTHA', 'MARHTA'), 0.95)
        self.assertLess(jaro_winkler('ABC', 'XYZ'), 0.5)


class Ladder(unittest.TestCase):
    def test_one_mark_per_cell_and_deterministic(self):
        recs = [rec('us-ngs', f'P{i}', 46.0 + i * 0.0003, -71.0, 'v' if i % 2 else 'h') for i in range(200)]
        hist = assign_minzoom(recs)
        self.assertEqual(sum(hist.values()), 200)
        again = [dict(r) for r in recs]
        assign_minzoom(again)
        self.assertEqual([r['minzoom'] for r in recs], [r['minzoom'] for r in again])
        for z in range(5, LADDER_MAX + 1):
            div = 2 ** (LADDER_MAX - z) * CELL_PX
            cells = [tuple(int(c // div) for c in world_px(r['lat'], r['lng'], LADDER_MAX))
                     for r in recs if r['minzoom'] <= z]
            self.assertEqual(len(cells), len(set(cells)), z)

    def test_low_precision_marks_enter_late(self):
        a = rec('ca-nrcan', 'X', 46.0, -71.0, 'v', posAcc=10.0)
        b = rec('us-ngs', 'Y', 47.0, -71.0, 'h', datum='nad27')  # NAD27 drawn as WGS 84: ±100 m
        assign_minzoom([a, b])
        self.assertEqual((a['minzoom'], b['minzoom']), (14, 14))


class Tiles(unittest.TestCase):
    def test_published_text_in_tile(self):
        r = rec('qc-mrnf', 'M15KM007', 46.813158128, -71.207627042, '3d', datum='nad83csrs-qc',
                hOrtho=[{'value': 51.158, 'text': '51.158', 'datum': 'CGVD2013'},
                        {'value': 51.54, 'text': '51.54', 'datum': 'CGVD28'}],
                hEll=23.393, hEllText='23.393', geo='46° 48\' 47.36926" N, 71° 12\' 27.45735" W',
                grids=[{'system': 'UTM zone 19N', 'e': '331582.278', 'n': '5186767.681'},
                       {'system': 'MTM zone 7 (SCOPQ)', 'e': '250798.875', 'n': '5186200.480'}],
                monument={'code': 'disk', 'text': 'Médaillon convexe ancré(e) sur un trottoir de béton'},
                lastVisit='2018-04-26')
        p = props(r)
        self.assertEqual((p['H'], p['hd'], p['H2'], p['hd2'], p['h']), ('51.158', 0, '51.54', 1, '23.393'))
        self.assertEqual(p['g2'], 'MTM zone 7 (SCOPQ);250798.875;5186200.480')
        self.assertEqual(p['s'], catalog.SOURCE_INDEX['qc-mrnf'])
        self.assertNotIn('l', p)
        r['minzoom'] = 14
        f = json.loads(feature_line(r))
        self.assertEqual(f['tippecanoe']['minzoom'], 13)
        self.assertEqual(f['properties']['z'], 14)

    def test_legacy_flag_and_precision(self):
        r = rec('ca-nrcan', 'B', 46.0, -71.0, 'v', datum='nad83-approx', posAcc=10.0)
        p = props(r)
        self.assertEqual((p['l'], p['p']), (1, 100))


if __name__ == '__main__':
    unittest.main()
