"""Tests for src_es_ign.py on real API rows (fixtures/es_ign_features.json).

IGN publishes lat/lon: the normalized position and `geo` must be exactly
the published values.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import src_es_ign as es  # noqa: E402

FIX = json.load(open(os.path.join(HERE, 'fixtures', 'es_ign_features.json'), encoding='utf-8'))


def stage(tmp, layers):
    """Lay out {collection: [features]} as the fetcher's pages."""
    for c, feats in layers.items():
        d = os.path.join(tmp, c, 'pages')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'p00000.json'), 'w', encoding='utf-8') as f:
            json.dump({'cursor': None, 'features': feats}, f)


class Normalize(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        stage(self.tmp, FIX)
        self.recs = list(es.normalize(self.tmp))
        self.by = {r['id']: r for r in self.recs}

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_published_lat_lon_verbatim(self):
        n = 0
        for c, lat_k, lng_k in (('red_roi', 'lat_etrs89', 'long_etrs89'),
                                ('red_nap', 'latitud_etrs89', 'longitud_etrs89'),
                                ('red_ergnss', 'latitud', 'longitud')):
            for f in FIX[c]:
                p = f['properties']
                recs = [r for r in self.recs if r.get('url') == p['resena']]
                self.assertEqual(len(recs), 1, p['resena'])
                r = recs[0]
                self.assertEqual(r['lat'], round(p[lat_k], 8))
                self.assertEqual(r['lng'], round(p[lng_k], 8))
                self.assertEqual(r['geo'], f'{p[lat_k]!r}, {p[lng_k]!r}')
                n += 1
        self.assertGreaterEqual(n, 10)

    def test_heights_and_grids(self):
        f = FIX['red_roi'][0]['properties']
        r = self.by[str(FIX['red_roi'][0]['id'])]
        self.assertEqual(r['hEllText'], repr(f['alt_elip']))
        self.assertEqual(r['hOrtho'][0]['text'], repr(f['alt_orto']))
        self.assertEqual(r['grids'][0], {'system': f"UTM {f['huso']}N", 'e': repr(f['x_etrs89']),
                                         'n': repr(f['y_etrs89'])})
        self.assertEqual(r['type'], '3d')
        self.assertEqual(r['datum'], 'etrs89')

    def test_regente_is_roi_vertex_once(self):
        ids = [r['uid'] for r in self.recs]
        self.assertEqual(len(ids), len(set(ids)))

    def test_islands_not_alicante(self):
        canary = [r for r in self.recs if r['datum'] == 'regcan95']
        for r in canary:
            for h in r['hOrtho']:
                self.assertEqual(h['datum'], 'Local vertical datum')
        self.assertEqual(es._vdatum(35), 'Local vertical datum')
        self.assertEqual(es._vdatum(15), 'REDNAP (Alicante)')
        self.assertEqual(es._vdatum(prov_name='Illes Balears'), 'Local vertical datum')

    def test_colocated_networks_merge(self):
        from src_util import merge_colocated  # noqa: PLC0415

        v = {'uid': 'es-ign:1444', 'id': '1444', 'type': '3d', 'lat': 40.0, 'lng': -3.0,
             'hOrtho': [{'value': 1.0, 'datum': 'REDNAP (Alicante)', 'text': '1.000'}]}
        nap = {'uid': 'es-ign:Lin01401/1401050', 'id': 'Lin01401/1401050', 'type': 'v',
               'lat': 40.000001, 'lng': -3.000001, 'aliases': ['NGW405'],
               'hOrtho': [{'value': 1.0002, 'datum': 'REDNAP (Alicante)', 'text': '1.0002'}]}
        far = dict(nap, uid='es-ign:x', id='x', lat=40.001)
        out = merge_colocated([nap, v, far])
        self.assertEqual([r['id'] for r in out], ['1444', 'x'])
        self.assertEqual(out[0]['aliases'], ['Lin01401/1401050', 'NGW405'])
        self.assertEqual(len(out[0]['hOrtho']), 1)  # same datum: the vertex's own value stays

    def test_nap_ids(self):
        nap = [r for r in self.recs if r['type'] == 'v']
        self.assertTrue(nap)
        for r in nap:
            self.assertRegex(r['id'], r'^Lin\d+/\d+$')
            self.assertEqual(r['url'], f"https://datos-geodesia.ign.es/REDNAP/{r['id']}.pdf")


if __name__ == '__main__':
    unittest.main()
