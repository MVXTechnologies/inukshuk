"""Tests for src_br_ibge.py on real WFS rows (fixtures/br_ibge_features.json).

IBGE publishes lat/lon: the display position must be exactly the published
decimal, and `geo` the published DMS text (decimal comma → dot).
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import src_br_ibge as br  # noqa: E402

with open(os.path.join(HERE, 'fixtures', 'br_ibge_features.json'), encoding='utf-8') as _f:
    FIX = json.load(_f)


class Numbers(unittest.TestCase):
    def test_brazilian_formatting(self):
        self.assertEqual(br.br_text('1.008,77'), '1008.77')
        self.assertEqual(br.br_text('455,5554'), '455.5554')
        self.assertEqual(br.br_text(' 07º 08\' 32,64677"  S'), '07º 08\' 32.64677" S')
        self.assertIsNone(br.br_text(None))


class Normalize(unittest.TestCase):
    def test_published_values(self):
        n = 0
        for layer, feats in FIX.items():
            for f in feats:
                p = f['properties']
                r = br.station(p, layer)
                self.assertEqual((r['lat'], r['lng']), (round(p['LATITUDE'], 8), round(p['LONGITUDE'], 8)))
                self.assertEqual(r['geo'], f"{br.br_text(p['LATGMS'])}, {br.br_text(p['LONGMS'])}")
                self.assertEqual(r['sheet'], p['ESTACAO'])
                normal = p.get('ALT_NORMAL') or p.get('ALT_ORTO')
                if normal and p.get('DATUM_ALT') == 'Imbituba':
                    self.assertEqual(r['hOrtho'][0]['datum'], 'Imbituba')
                    self.assertEqual(r['hOrtho'][0]['text'], br.br_text(normal))
                if 'DESTRU' in p['SITUACAO']:
                    self.assertEqual(r['status'], 'destroyed')
                if 'Carta 1:50000' == p.get('FONTECOORD'):
                    self.assertEqual(r['posAcc'], 25.0)
                n += 1
        self.assertGreaterEqual(n, 10)

    def test_types(self):
        rn = br.station(FIX['RN'][0]['properties'], 'RN')
        self.assertEqual(rn['type'], 'v')
        gps = br.station(FIX['GPS'][0]['properties'], 'GPS')
        self.assertEqual(gps['type'], '3d')
        self.assertEqual(gps['hEllText'], br.br_text(FIX['GPS'][0]['properties']['ALTGEOM']))


if __name__ == '__main__':
    unittest.main()
