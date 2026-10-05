"""Tests for the tide-station pipeline (tides.sh).

    python3 -m unittest discover -s infra/tiles/nas/tides -p 'test_*.py'

Fixtures are real agency responses (fixtures/, copied from the research
folder): NOAA CO-OPS datums + bench-mark sheet for The Battery, all 446 SHOM
RAM sites, Kartverket Bergen, the JMA station table, and the chart-datum
pairs of the validation suite (cd_reference_points.json: VDatum, IGN RAF20,
Kartverket CD grid as oracles, with PROJ's values). The VALIDATION cases print
their max deviation. Standard library only (pyproj is replaced by the
validation suite's own PROJ results), so they run anywhere.
"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.append(os.path.join(HERE, '..', 'geodetic'))  # after ours: geodetic has its own build/catalog
FX = os.path.join(HERE, 'fixtures')
APP_CATALOG = os.path.join(HERE, '..', '..', '..', '..', 'src', 'core', 'tides', 'catalog-v1.json')

import build  # noqa: E402
import catalog  # noqa: E402
import derive  # noqa: E402
import join_geodetic  # noqa: E402
import normalize as N  # noqa: E402
from common import write_ndjson  # noqa: E402


def battery():
    meta = {'id': '8518750', 'name': 'THE BATTERY', 'lat': 40.700554, 'lng': -74.01417}
    return N.coops_station(meta, json.load(open(os.path.join(FX, 'coops_8518750_datums.json'))), {'8518750'}, {})


def ram_sites():
    feats = json.load(open(os.path.join(FX, 'shom_ram.geojson')))['features']
    return [f['properties'] for f in feats]


def ref_pair(pid):
    pairs = json.load(open(os.path.join(FX, 'cd_reference_points.json')))['pairs']
    return next(p for p in pairs if p['pair_id'] == pid)


class Catalogue(unittest.TestCase):
    @unittest.skipUnless(os.path.exists(APP_CATALOG), 'app sources not here (NAS copy)')
    def test_app_bundles_the_same_catalogue(self):
        self.assertEqual(json.load(open(APP_CATALOG)), catalog.catalog(),
                         'run: python3 infra/tiles/nas/tides/catalog.py src/core/tides/catalog-v1.json')

    def test_no_chs_source(self):
        # Owner decision PLAN Q1 = c: CHS stays live-only, never in our files.
        self.assertFalse(any('chs' in s[0] or 'Hydrographic Service' in s[4] for s in catalog.SOURCES))


class Coops(unittest.TestCase):
    def test_battery_levels_above_mllw_match_the_published_sheet(self):
        rec = battery()
        lv = {r['code']: r['text'] for r in rec['levels']}
        # The bench-mark sheet's "Tidal datums ... above MLLW" (published 2012-11-20).
        self.assertEqual(lv['MHHW'], '1.541')
        self.assertEqual(lv['MHW'], '1.443')
        self.assertEqual(lv['MSL'], '0.783')
        self.assertEqual(lv['MLW'], '0.063')
        self.assertEqual(lv['MLLW'], '0.000')
        self.assertEqual(lv['LAT'], '-0.465')
        self.assertEqual(lv['HAT'], '1.976')
        ext = {r['code']: (r['text'], r['date']) for r in rec['extremes']}
        self.assertEqual(ext['LOWL'], ('-1.307', '1976-02-02'))  # sheet: LOWEST OBSERVED (02/02/1976) = -1.307
        # Sign convention: NAVD88 is 0.846 above MLLW → CD_in_NAVD88 = −0.846.
        self.assertEqual(rec['national'], [{'datum': 'NAVD88', 'value': -0.846, 'text': '-0.846'}])
        self.assertEqual((rec['kind'], rec['live'], rec['cd'], rec['published']), ('gauge', 'coops', 'mllw', '2012-11-19'))
        self.assertEqual([r['code'] for r in rec['levels']], ['HAT', 'MHHW', 'MHW', 'MSL', 'DTL', 'MTL', 'MLW', 'MLLW', 'LAT'])

    def test_sheet_marks_and_elevations(self):
        meta, marks = N.parse_coops_sheet(open(os.path.join(FX, 'coops_sheet_8518750.html')).read())
        self.assertEqual(meta, {'published': '2012-11-20', 'navd88AboveMllw': 0.846})
        got = {m['pid']: (m['mllw'], m['mhw']) for m in marks}
        self.assertEqual(got, {'AB6736': ('4.468', '3.025'), 'KV0584': ('4.277', '2.834'), 'AB6737': ('3.556', '2.113'),
                               'KV0579': ('5.719', '4.276'), 'KV0580': ('5.689', '4.246'), 'KV0587': ('2.849', '1.406')})

    def test_great_lakes_station_uses_low_water_datum(self):
        d = {'units': 'meters', 'datums': [{'name': 'GL_LWD', 'value': 173.5}]}
        rec = N.coops_station({'id': '9063020', 'name': 'Buffalo', 'lat': 42.877, 'lng': -78.89}, d, set(), {})
        self.assertEqual(rec['cd'], 'lwd')
        self.assertEqual(rec['national'], [{'datum': 'IGLD85', 'value': 173.5, 'text': '173.50'}])
        self.assertEqual(rec['levels'], [])

    def test_feet_are_refused(self):
        d = json.load(open(os.path.join(FX, 'coops_8518750_datums.json')))
        d['units'] = 'feet'
        self.assertIsNone(N.coops_station({'id': '1', 'name': 'x', 'lat': 0, 'lng': 0}, d, set(), {}))


class Shom(unittest.TestCase):
    def test_all_sites_and_the_published_identity(self):
        sites = ram_sites()
        recs = [N.shom_station(p) for p in sites]
        self.assertEqual(sum(r is not None for r in recs), 446)
        worst, n = 0.0, 0
        for r in recs:
            for nat in r['national']:
                if 'identity' in nat:
                    n += 1
                    worst = max(worst, abs(nat['identity']))
        print(f'\n  SHOM identity rf_ref = rf_zh + zh_ref on {n} sites: max |Δ| {worst * 1000:.1f} mm')
        self.assertGreater(n, 250)
        self.assertLessEqual(worst, 0.0015)

    def test_brest(self):
        p = next(p for p in ram_sites() if p['site'] == 'Brest')
        rec = N.shom_station(p)
        self.assertEqual([(lv['code'], lv['text']) for lv in rec['levels']],
                         [('PHMA', '7.93'), ('PMVE', '7.05'), ('PMME', '5.50'), ('NM', '4.14'), ('BMME', '2.70'),
                          ('BMVE', '1.15'), ('PBMA', '0.25')])
        # Sign convention: NO-47 is 9.541 above ZH and 5.906 IGN69 → ZH = 5.906 − 9.541 = −3.635 IGN69.
        self.assertEqual(rec['national'][0]['text'], '-3.635')
        self.assertAlmostEqual(9.541 + rec['national'][0]['value'], 5.906, places=6)
        self.assertEqual(rec['ellPublished']['text'], '47.033')


class Kartverket(unittest.TestCase):
    def test_bergen(self):
        rec = N.kartverket_station(open(os.path.join(FX, 'kv_BGO_cd.xml'), 'rb').read(),
                                   open(os.path.join(FX, 'kv_BGO_nn2000.xml'), 'rb').read())
        self.assertEqual(rec['national'][0]['text'], '-1.022')
        self.assertEqual(rec['national'][0]['identity'], 0.0)
        lv = {r['code']: r['text'] for r in rec['levels']}
        self.assertEqual((lv['HAT'], lv['MSL'], lv['LAT']), ('1.818', '0.952', '0.000'))
        self.assertEqual(rec['extremes'][1], {'code': 'LOWL', 'value': -0.377, 'text': '-0.377', 'date': '1980-03-18'})
        self.assertEqual((rec['kind'], rec['live'], rec['epoch']), ('gauge', 'kv', '1996–2014'))


class Jma(unittest.TestCase):
    def test_station_table(self):
        recs = N.jma_stations(open(os.path.join(FX, 'jma_station.html'), encoding='utf-8').read())
        self.assertEqual(len(recs), 239)
        with_tp = [r for r in recs if r['national']]
        self.assertEqual(len(with_tp), 92)
        worst = max(abs(r['national'][0].get('identity', 0)) for r in with_tp)
        print(f'\n  JMA identity (MSL−datum = MSL TP − datum TP) on {len(with_tp)} stations: max |Δ| {worst * 1000:.1f} mm')
        self.assertLessEqual(worst, 0.0015)
        wn = recs[0]
        self.assertEqual((wn['id'], wn['levels'][0]['text'], wn['national'][0]['text']), ('WN', '0.180', '-0.218'))


class FakeGeoid:
    def __init__(self, values):
        self.values = values

    def __call__(self, name, lon, lat, h=0.0):
        return self.values.get((name, round(lon, 6), round(lat, 6)))


class Derive(unittest.TestCase):
    """The ellipsoid column's rule on the validation suite's agency oracles."""

    def test_shom_published_zh_elli_shown_only_where_raf20_agrees(self):
        pair = ref_pair('CD-FR-RAM-vs-RAF20')
        by_site = {f"{p['site']} ({p['zone']})": p for p in ram_sites()}
        shown, hidden, worst_shown = 0, 0, 0.0
        for pt in pair['points']:
            rec = N.shom_station(by_site[pt['id']])
            lon, lat, zh_ref = pt['input']
            n = pt['proj_result'][2] - zh_ref  # RAF20 N at the site, from PROJ in the validation run
            ell, check = derive.derive_shom(rec, FakeGeoid({('RAF20', round(lon, 6), round(lat, 6)): n}))
            agrees = abs(pt['expected'][2] - pt['proj_result'][2]) <= derive.TOL_M
            self.assertEqual(ell is not None, agrees, pt['id'])
            if ell:
                shown += 1
                worst_shown = max(worst_shown, abs(check['delta']))
                self.assertEqual(ell['text'], f"{pt['expected'][2]:.3f}")  # the published value, verbatim
            else:
                hidden += 1
        print(f'\n  SHOM zh_elli vs zh_ref+RAF20: {shown} shown (max |Δ| {worst_shown * 100:.1f} cm), {hidden} hidden')
        self.assertGreater(shown, 60)
        self.assertLessEqual(worst_shown, derive.TOL_M)

    def test_kartverket_derived_cd_matches_the_cd_grid(self):
        pair = ref_pair('CD-NO-station-vs-grid')
        worst = 0.0
        for pt in pair['points']:
            lon, lat, _ = pt['input']
            n = 40.0  # any N: the check is (CD_in_NN2000 + N) vs (CD grid) where grid − N is PROJ's value
            rec = {'uid': f"no-kartverket:{pt['id'][:3]}", 'name': pt['id'], 'src': 'no-kartverket', 'flags': [],
                   'lat': lat, 'lng': lon,
                   'national': [{'datum': 'NN2000', 'value': pt['expected'][2], 'text': f"{pt['expected'][2]:.3f}"}]}
            g = FakeGeoid({('HREF2018B', round(lon, 6), round(lat, 6)): n,
                           ('NO_CD_2023B', round(lon, 6), round(lat, 6)): pt['proj_result'][2] + n})
            ell, check = derive.derive_kartverket(rec, g)
            self.assertIsNotNone(ell, pt['id'])
            worst = max(worst, abs(check['delta']))
        print(f"\n  Kartverket station CD vs CD grid v2023b: {len(pair['points'])} stations, max |Δ| {worst * 100:.1f} cm")
        self.assertLessEqual(worst, derive.TOL_M)

    def test_coops_shown_only_with_vdatum_agreement(self):
        rec = battery()
        n = -31.923  # GEOID18 at the gauge: VDatum h (−32.778) − VDatum NAVD88 (−0.855)
        g = FakeGeoid({('GEOID18', -74.01417, 40.700554): n})
        vd = json.load(open(os.path.join(FX, 'vdatum_battery_MLLW_to_NAD83_2011.json')))
        ell, check = derive.derive_coops(rec, g, lambda r: {'h': float(vd['t_z']), 'unc': float(vd['uncertainty'])})
        self.assertEqual(ell['text'], '-32.77')
        self.assertLessEqual(abs(check['delta']), 0.01)
        print(f"\n  The Battery CD ellipsoidal: ours {ell['value']} vs VDatum {vd['t_z']} (Δ {check['delta'] * 100:.1f} cm)")
        # No oracle answer → hidden, never guessed.
        ell2, check2 = derive.derive_coops(rec, g, lambda r: None)
        self.assertIsNone(ell2)
        self.assertIsNone(check2['pass'])
        # Oracle disagrees beyond 5 cm → hidden.
        ell3, _ = derive.derive_coops(rec, g, lambda r: {'h': float(vd['t_z']) + 0.08, 'unc': None})
        self.assertIsNone(ell3)

    def test_coops_navd88_offsets_vs_vdatum(self):
        pair = ref_pair('CD-US-VDatum-vs-COOPS')
        ok = [pt for pt in pair['points'] if pt.get('proj_result')]
        worst = max(abs(pt['expected'][0] - pt['proj_result'][0]) for pt in ok)
        print(f'\n  CO-OPS CD_in_NAVD88 vs VDatum at {len(ok)} gauges: max |Δ| {worst * 100:.1f} cm')
        self.assertLessEqual(worst, derive.TOL_M)


class Join(unittest.TestCase):
    def _norm(self, d, ngs_h=3.431, ign_h=5.906):
        write_ndjson(os.path.join(d, 'us-ngs.ndjson'), [
            # NGS datasheet values for KV0584 (Battery NO 3), as the geodetic build normalized them.
            {'uid': 'us-ngs:KV0584', 'src': 'us-ngs', 'id': 'KV0584', 'lat': 40.70372778, 'lng': -74.01649722,
             'type': 'v', 'hOrtho': [{'value': ngs_h, 'text': f'{ngs_h:.3f}', 'datum': 'NAVD88'}],
             'aliases': ['851 8750 TIDAL 3'], 'status': 'ok'}])
        write_ndjson(os.path.join(d, 'fr-ign.ndjson'), [
            {'uid': 'fr-ign:nivf-200949', 'src': 'fr-ign', 'id': 'nivf-200949', 'lat': 48.38311409, 'lng': -4.49378328,
             'type': 'v', 'hOrtho': [{'value': ign_h, 'datum': 'NGF-IGN69', 'text': f'{ign_h:.3f}'}],
             'aliases': ['NO - 47'], 'name': 'NO - 47', 'status': 'ok'},
            {'uid': 'fr-ign:nivf-200950', 'src': 'fr-ign', 'id': 'nivf-200950', 'lat': 48.382807, 'lng': -4.494735,
             'type': 'v', 'hOrtho': [{'value': 4.832, 'datum': 'NGF-IGN69', 'text': '4.832'}],
             'aliases': ['NO - 47-I'], 'name': 'NO - 47-I', 'status': 'ok'}])

    def _bms(self):
        bms = []
        with tempfile.TemporaryDirectory() as raw:
            os.makedirs(os.path.join(raw, 'datums'))
            os.makedirs(os.path.join(raw, 'sheets'))
            json.dump({'stations': [{'id': '8518750', 'name': 'THE BATTERY', 'lat': 40.700554, 'lng': -74.01417}]},
                      open(os.path.join(raw, 'stations_datums.json'), 'w'))
            json.dump({'stations': [{'id': '8518750'}]}, open(os.path.join(raw, 'stations_waterlevels.json'), 'w'))
            with open(os.path.join(FX, 'coops_8518750_datums.json'), 'rb') as s, \
                    open(os.path.join(raw, 'datums', '8518750.json'), 'wb') as t:
                t.write(s.read())
            with open(os.path.join(FX, 'coops_sheet_8518750.html'), 'rb') as s, \
                    open(os.path.join(raw, 'sheets', '8518750.html'), 'wb') as t:
                t.write(s.read())
            stations, b = N.normalize_coops(raw)
            self.assertEqual(len(stations), 1)
            bms += b
        p = next(p for p in ram_sites() if p['site'] == 'Brest')
        rec = N.shom_station(p)
        bms.append({'src': 'fr-shom', 'station': rec['uid'], 'stationName': 'Brest', 'cd': 'zh', 'name': p['rf'],
                    'cdText': '9.541', 'cdValue': 9.541, 'lat': rec['lat'], 'lng': rec['lng'], 'date': '2010',
                    'joinKey': {'src': 'fr-ign', 'name': p['rf']},
                    'nationalCheck': {'datum': 'NGF-IGN69', 'value': round(9.541 + rec['national'][0]['value'], 3)}})
        return bms

    def test_ids_join_and_heights_check(self):
        with tempfile.TemporaryDirectory() as d:
            self._norm(d)
            joins, rows = join_geodetic.join(self._bms(), d)
        self.assertEqual(joins['us-ngs:KV0584'], {'cd': '4.277', 'cs': 'us-coops:8518750', 'cN': 'THE BATTERY',
                                                  'cn': 'mllw', 'cdt': '2012-11-20', 'cm': '2.834'})
        self.assertEqual(joins['fr-ign:nivf-200949']['cd'], '9.541')
        self.assertNotIn('fr-ign:nivf-200950', joins)  # "NO - 47-I" is another mark
        worst = max(abs(r['delta']) for r in rows if r.get('delta') is not None)
        print(f'\n  tidal BM CD height + offset vs levelled height: {len(rows)} marks, max |Δ| {worst * 1000:.0f} mm')
        self.assertLessEqual(worst, 0.001)  # KV0584 4.277 − 0.846 = 3.431 (NGS); NO-47 9.541 − 3.635 = 5.906 (IGN)

    def test_moved_mark_is_not_joined(self):
        with tempfile.TemporaryDirectory() as d:
            self._norm(d, ngs_h=3.431 + 0.2, ign_h=5.906 - 0.15)
            joins, rows = join_geodetic.join(self._bms(), d)
        self.assertNotIn('us-ngs:KV0584', joins)
        self.assertNotIn('fr-ign:nivf-200949', joins)
        self.assertTrue(any(r['pass'] is False for r in rows))


class Tiles(unittest.TestCase):
    def test_props(self):
        rec = battery()
        rec['ell'] = {'text': '-32.77', 'frame': 'NAD83(2011)', 'epoch': '2010.0', 'how': 'derived',
                      'checkedBy': 'NOAA VDatum', 'deltaM': 0.008, 'basis': 'CO-OPS NAVD88 offset + NGS GEOID18'}
        p = build.props(rec)
        self.assertEqual(p['i'], '8518750')
        self.assertEqual(p['s'], catalog.SOURCE_INDEX['us-coops'])
        self.assertEqual(p['D'], 'NAVD88=-0.846')
        self.assertTrue(p['L'].startswith('HAT=1.976;MHHW=1.541;'))
        self.assertEqual(p['X'], 'HOWL=4.280@2012-10-30;LOWL=-1.307@1976-02-02')
        self.assertEqual(p['E'], '-32.77|NAD83(2011)|2010.0|derived|NOAA VDatum|0.008|CO-OPS NAVD88 offset + NGS GEOID18')
        self.assertEqual((p['k'], p['lv'], p['cn'], p['ep']), ('gauge', 'coops', 'mllw', '1983–2001'))

    def test_inconsistent_national_offset_is_hidden(self):
        rec = battery()
        rec['flags'].append('national-inconsistent')
        self.assertNotIn('D', build.props(rec))

    def test_reference_port_fallback(self):
        sec = battery()
        sec['levels'] = [lv for lv in sec['levels'] if lv['code'] not in ('HAT', 'LAT')]
        self.assertTrue(build._needs_ref(sec))
        p = build.props(sec, battery())
        self.assertEqual(p['rpn'], 'THE BATTERY')
        self.assertIn('LAT=-0.465', p['rL'])


if __name__ == '__main__':
    unittest.main()
