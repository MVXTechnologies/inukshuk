"""Tests for src_no_kartverket.py on real GML features (fixtures/no_*.zip).

Kartverket publishes EUREF89 lat/lon: the display position and `geo` must be
the published `gml:pos` values, heights the published text.
"""
import os
import re
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import src_no_kartverket as no  # noqa: E402

FIX = os.path.join(HERE, 'fixtures')


class Normalize(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        for name in ('hoyde', 'trekant', 'stam'):
            shutil.copy(os.path.join(FIX, f'no_{name}.zip'), os.path.join(self.tmp, f'{name}.zip'))
        self.recs = {r['id']: r for r in no.normalize(self.tmp)}

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def published(self):
        """(punktNummer, 'lat lon', NN2000 text) straight from the fixture GML."""
        out = []
        for name in ('hoyde', 'trekant', 'stam'):
            with zipfile.ZipFile(os.path.join(FIX, f'no_{name}.zip')) as z:
                text = z.read(z.namelist()[0]).decode('utf-8')
            for m in re.findall(r'<gml:featureMember>.*?</gml:featureMember>', text, re.S):
                num = re.search(r'<app:punktNummer>([^<]+)', m).group(1)
                pos = re.search(r'<gml:pos>([^<]+)', m).group(1)
                nn2000 = re.search(r'<app:høydeNormalNN2000>([^<]+)', m)
                out.append((num, pos, nn2000.group(1) if nn2000 else None, name))
        return out

    def test_published_values_verbatim(self):
        pub = self.published()
        self.assertGreaterEqual(len(pub), 10)
        for num, pos, nn2000, name in pub:
            r = self.recs[num]
            lat, lng = pos.split()
            self.assertEqual(r['geo'], f'{lat}, {lng}')
            self.assertEqual((r['lat'], r['lng']), (float(lat), float(lng)))
            if nn2000:
                self.assertEqual(r['hOrtho'][0], {'value': float(nn2000), 'datum': 'NN2000', 'text': nn2000})
            self.assertEqual(r['type'], {'hoyde': 'v', 'stam': '3d'}.get(name, r['type']))

    def test_status_and_visit(self):
        with_status = [r for r in self.recs.values() if r.get('statusRaw')]
        self.assertTrue(with_status)
        for r in with_status:
            if r['statusRaw'] == 'funnetIOrden':
                self.assertEqual(r['status'], 'ok')
                self.assertRegex(r['lastVisit'], r'^\d{4}-\d{2}-\d{2}$')


if __name__ == '__main__':
    unittest.main()
