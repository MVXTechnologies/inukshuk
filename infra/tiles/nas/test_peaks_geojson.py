"""Tests for peaks_geojson.py:  python3 -m unittest infra/tiles/nas/test_peaks_geojson.py"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from peaks_geojson import convert, feature, minzoom_for, parse_ele, query_for, split4  # noqa: E402


class ParseEle(unittest.TestCase):
    def test_plain_and_metres(self):
        self.assertEqual(parse_ele('1234'), 1234)
        self.assertEqual(parse_ele('1234 m'), 1234)
        self.assertEqual(parse_ele('1234m'), 1234)
        self.assertEqual(parse_ele(' 808 M '), 808)
        self.assertEqual(parse_ele('673.5'), 673.5)
        self.assertEqual(parse_ele('2500 metres'), 2500)
        self.assertEqual(parse_ele('2500 m a.s.l.'), 2500)

    def test_thousands_separators_and_decimal_comma(self):
        self.assertEqual(parse_ele('1,234'), 1234)
        self.assertEqual(parse_ele('1 234'), 1234)
        self.assertEqual(parse_ele('1234,5'), 1234.5)

    def test_feet(self):
        self.assertAlmostEqual(parse_ele('4000ft'), 1219.2)
        self.assertAlmostEqual(parse_ele('13,123 ft'), 3999.89, places=2)
        self.assertAlmostEqual(parse_ele("5280'"), 1609.34, places=2)
        self.assertAlmostEqual(parse_ele('1000 feet'), 304.8)

    def test_approximations_and_lists(self):
        self.assertEqual(parse_ele('~1200'), 1200)
        self.assertEqual(parse_ele('ca. 900'), 900)
        self.assertEqual(parse_ele('1234;1240'), 1234)
        self.assertEqual(parse_ele('-12'), -12)

    def test_garbage_is_none(self):
        for raw in [None, '', 'unknown', 'm', '12 km', 'approx high', '99999', '1.2.3', 'nan', '1e5']:
            self.assertIsNone(parse_ele(raw), raw)


class Ladder(unittest.TestCase):
    def test_elevation_ladder(self):
        self.assertEqual(minzoom_for(8849), 5)
        self.assertEqual(minzoom_for(4000), 5)
        self.assertEqual(minzoom_for(3999), 6)
        self.assertEqual(minzoom_for(3000), 6)
        self.assertEqual(minzoom_for(2000), 7)
        self.assertEqual(minzoom_for(1500), 8)
        self.assertEqual(minzoom_for(1000), 9)
        self.assertEqual(minzoom_for(808), 10)
        self.assertEqual(minzoom_for(500), 10)
        self.assertEqual(minzoom_for(499), 11)
        self.assertEqual(minzoom_for(1), 11)

    def test_unknown_or_non_positive_elevation_comes_last(self):
        self.assertEqual(minzoom_for(None), 12)
        self.assertEqual(minzoom_for(0), 12)
        self.assertEqual(minzoom_for(-20), 12)

    def test_prominence_promotes(self):
        self.assertEqual(minzoom_for(900, 400), 10)
        self.assertEqual(minzoom_for(900, 600), 9)
        self.assertEqual(minzoom_for(2100, 1600), 5)
        self.assertEqual(minzoom_for(None, 800), 11)

    def test_never_below_the_tileset_minzoom(self):
        self.assertEqual(minzoom_for(8849, 8849), 5)


def node(osm_id, **tags):
    return {'type': 'node', 'id': osm_id, 'lat': 47.087437, 'lon': -70.932024, 'tags': tags}


class Feature(unittest.TestCase):
    def test_mont_sainte_anne(self):
        f = feature(node(1, natural='peak', name='Mont Sainte-Anne', ele='808'))
        self.assertEqual(
            f,
            {
                'type': 'Feature',
                'tippecanoe': {'minzoom': 10},
                'properties': {'name': 'Mont Sainte-Anne', 'kind': 'peak', 'ele': 808},
                'geometry': {'type': 'Point', 'coordinates': [-70.932024, 47.087437]},
            },
        )

    def test_rounds_ele_and_keeps_only_differing_translations(self):
        f = feature(node(1, natural='volcano', name='Fuji', ele='3776.24', **{'name:en': 'Mount Fuji', 'name:fr': 'Fuji'}))
        self.assertEqual(f['properties'], {'name': 'Fuji', 'kind': 'volcano', 'ele': 3776, 'name:en': 'Mount Fuji'})
        self.assertEqual(f['tippecanoe'], {'minzoom': 6})

    def test_zero_or_bad_ele_is_dropped(self):
        for ele in ['0', 'high']:
            f = feature(node(1, natural='peak', name='X', ele=ele))
            self.assertNotIn('ele', f['properties'])
            self.assertEqual(f['tippecanoe'], {'minzoom': 12})

    def test_unusable_elements(self):
        self.assertIsNone(feature(node(1, natural='peak')))
        self.assertIsNone(feature(node(1, natural='peak', name='  ')))
        self.assertIsNone(feature(node(1, natural='saddle', name='Col')))
        self.assertIsNone(feature({'id': 1, 'tags': {'natural': 'peak', 'name': 'X'}}))


class Query(unittest.TestCase):
    def test_overpass_bbox_is_south_west_north_east(self):
        q = query_for([-71.2, 46.9, -70.6, 47.4])
        self.assertIn('node["natural"~"^(peak|volcano)$"]["name"](46.9,-71.2,47.4,-70.6);', q)
        self.assertTrue(q.startswith('[out:json][timeout:'))

    def test_split4_covers_the_bbox(self):
        self.assertEqual(
            split4([0, 0, 10, 20]),
            [[0, 0, 5, 10], [5, 0, 10, 10], [0, 10, 5, 20], [5, 10, 10, 20]],
        )


class Convert(unittest.TestCase):
    def test_dedupes_by_osm_id_across_pieces(self):
        with tempfile.TemporaryDirectory() as d:
            a = {'elements': [node(1, natural='peak', name='A', ele='900'), node(2, natural='peak', name='B')]}
            b = {'elements': [node(2, natural='peak', name='B'), node(3, natural='saddle', name='C')]}
            for name, data in (('a.json', a), ('b.json', b)):
                with open(os.path.join(d, name), 'w') as f:
                    json.dump(data, f)
            out = os.path.join(d, 'out.geojsonl')
            self.assertEqual(convert(d, out), 2)
            with open(out) as f:
                lines = [json.loads(line) for line in f]
            self.assertEqual([f['properties']['name'] for f in lines], ['A', 'B'])


if __name__ == '__main__':
    unittest.main()
