"""Tests for parks_geojson.py:  python3 -m unittest infra/tiles/nas/test_parks_geojson.py"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parks_geojson import (  # noqa: E402
    AREA_LEAD,
    MAX_ZOOM,
    MIN_ZOOM,
    assemble,
    bounds_area_km2,
    classify,
    convert,
    inside,
    label_point,
    national_features,
    national_query,
    rank_for,
    reserve_label,
    reserve_query,
    ring_area_km2,
    rings_of,
)


def geom(points):
    """[(lon, lat), …] → the Overpass `geometry` list."""
    return [{'lon': lon, 'lat': lat} for lon, lat in points]


def square(w, s, size):
    """A closed square ring, `size` degrees a side."""
    return [(w, s), (w + size, s), (w + size, s + size), (w, s + size), (w, s)]


# About 0.2° × 0.2° at 47°N: 22.3 km × 15.2 km ≈ 338 km².
JACQUES = {
    'type': 'relation',
    'id': 15421717,
    'tags': {
        'boundary': 'national_park',
        'leisure': 'nature_reserve',
        'name': 'Parc national de la Jacques-Cartier',
        'name:en': 'Jacques-Cartier National Park',
        'name:fr': 'Parc national de la Jacques-Cartier',
    },
    'bounds': {'minlat': 47.0, 'minlon': -71.4, 'maxlat': 47.2, 'maxlon': -71.2},
    'members': [
        # Two ways, the second drawn backwards, that close one ring.
        {'type': 'way', 'role': 'outer', 'geometry': geom([(-71.4, 47.0), (-71.2, 47.0), (-71.2, 47.2)])},
        {'type': 'way', 'role': 'outer', 'geometry': geom([(-71.4, 47.0), (-71.4, 47.2), (-71.2, 47.2)])},
        # A private enclave.
        {'type': 'way', 'role': 'inner', 'geometry': geom(square(-71.31, 47.09, 0.02))},
        {'type': 'node', 'role': 'label', 'lat': 47.1, 'lon': -71.3},
    ],
}


class Classify(unittest.TestCase):
    def test_national(self):
        self.assertEqual(classify({'boundary': 'national_park', 'name': 'Banff'}), 'national')
        # Jacques-Cartier: no protect_class at all — the case Protomaps files under `park`.
        self.assertEqual(classify(JACQUES['tags']), 'national')
        self.assertEqual(
            classify({'boundary': 'protected_area', 'protect_class': '2', 'name': 'X'}), 'national'
        )

    def test_reserve(self):
        for protect_class in (None, '1a', '1b', '4', '5', '7'):
            tags = {'boundary': 'protected_area', 'name': 'Zec Batiscan-Neilson'}
            if protect_class:
                tags['protect_class'] = protect_class
            self.assertEqual(classify(tags), 'reserve', protect_class)
        self.assertEqual(classify({'leisure': 'nature_reserve', 'name': 'Marais'}), 'reserve')

    def test_not_nature(self):
        # Heritage districts, military land, Natura 2000 overlays.
        for protect_class in ('22', '25', '97', '98'):
            self.assertIsNone(
                classify({'boundary': 'protected_area', 'protect_class': protect_class, 'name': 'X'})
            )
        self.assertIsNone(classify({'leisure': 'park', 'name': 'Parc Chauveau'}))

    def test_unnamed(self):
        self.assertIsNone(classify({'boundary': 'national_park'}))
        self.assertIsNone(classify({'boundary': 'national_park', 'name': '  '}))


class Rank(unittest.TestCase):
    def test_ladder(self):
        self.assertEqual(rank_for(45000, 'national'), 4)  # Wood Buffalo
        self.assertEqual(rank_for(8983, 'national'), 5)  # Yellowstone
        self.assertEqual(rank_for(6641, 'national'), 5)  # Banff
        self.assertEqual(rank_for(670, 'national'), 7)  # Jacques-Cartier
        self.assertEqual(rank_for(170, 'national'), 8)  # Swiss National Park
        self.assertEqual(rank_for(0.4, 'national'), 11)

    def test_reserves_come_later(self):
        self.assertEqual(rank_for(7861, 'reserve'), 7)  # Réserve faunique des Laurentides
        self.assertEqual(rank_for(670, 'reserve'), 9)

    def test_always_inside_the_tile_range(self):
        for area in (0, 0.01, 3, 1e7):
            for tier in ('national', 'reserve'):
                self.assertTrue(MIN_ZOOM <= rank_for(area, tier) <= MAX_ZOOM)


class Geometry(unittest.TestCase):
    def test_area_of_a_degree_square_shrinks_with_latitude(self):
        self.assertAlmostEqual(ring_area_km2(square(0, -0.5, 1)), 111.32**2, delta=10)
        self.assertAlmostEqual(ring_area_km2(square(-71, 46.5, 1)), 111.32**2 * 0.682, delta=60)
        self.assertEqual(ring_area_km2([(0, 0), (1, 1)]), 0.0)

    def test_bounds_area_is_a_filled_fraction(self):
        bounds = {'minlat': 46.5, 'minlon': -71.0, 'maxlat': 47.5, 'maxlon': -70.0}
        self.assertAlmostEqual(bounds_area_km2(bounds), 111.32**2 * 0.682 * 0.6, delta=40)

    def test_assemble_stitches_unordered_reversed_ways(self):
        a = [(0, 0), (1, 0)]
        b = [(1, 1), (1, 0)]  # reversed
        c = [(1, 1), (0, 1)]
        d = [(0, 0), (0, 1)]  # reversed
        rings = assemble([c, a, d, b])
        self.assertEqual(len(rings), 1)
        self.assertEqual(rings[0][0], rings[0][-1])
        self.assertEqual(set(rings[0]), {(0, 0), (1, 0), (1, 1), (0, 1)})
        self.assertAlmostEqual(ring_area_km2(rings[0]), 111.32**2, delta=10)

    def test_assemble_keeps_closed_ways_and_drops_open_chains(self):
        closed = square(5, 5, 1)
        dangling = [(0, 0), (1, 0), (2, 0)]
        self.assertEqual(assemble([closed, dangling]), [closed])
        self.assertEqual(assemble([]), [])

    def test_rings_of_a_way_and_a_relation(self):
        way = {'type': 'way', 'geometry': geom(square(0, 0, 1))}
        self.assertEqual(rings_of(way), ([square(0, 0, 1)], []))
        outers, inners = rings_of(JACQUES)
        self.assertEqual((len(outers), len(inners)), (1, 1))

    def test_inside(self):
        ring = square(0, 0, 1)
        self.assertTrue(inside((0.5, 0.5), ring))
        self.assertFalse(inside((1.5, 0.5), ring))

    def test_label_point_of_a_square_is_near_its_centre(self):
        x, y = label_point(square(10, 46, 1))
        self.assertAlmostEqual(x, 10.5, delta=0.1)
        self.assertAlmostEqual(y, 46.5, delta=0.1)

    def test_label_point_stays_inside_a_crescent(self):
        # A "C": its centroid and its bounding-box centre both fall in the gap.
        c = [(0, 0), (3, 0), (3, 1), (1, 1), (1, 2), (3, 2), (3, 3), (0, 3), (0, 0)]
        self.assertFalse(inside((2.0, 1.5), c))
        point = label_point(c)
        self.assertTrue(inside(point, c), point)


class NationalFeatures(unittest.TestCase):
    def test_polygon_and_label(self):
        polygon, label = national_features(JACQUES)
        self.assertEqual(polygon['geometry']['type'], 'MultiPolygon')
        (rings,) = polygon['geometry']['coordinates']
        self.assertEqual(len(rings), 2)  # the outer ring and its enclave
        self.assertEqual(rings[0][0], rings[0][-1])
        # ~338 km² less the enclave: rank 8, in the tiles two zooms earlier.
        self.assertEqual(polygon['properties']['rank'], 8)
        self.assertEqual(polygon['tippecanoe'], {'minzoom': 8 - AREA_LEAD})
        self.assertEqual(label['tippecanoe'], {'minzoom': 8})
        self.assertEqual(
            label['properties'],
            {
                'name': 'Parc national de la Jacques-Cartier',
                'name:en': 'Jacques-Cartier National Park',  # name:fr equals name: dropped
                'class': 'national',
                'rank': 8,
            },
        )
        lon, lat = label['geometry']['coordinates']
        self.assertTrue(-71.4 < lon < -71.2 and 47.0 < lat < 47.2)

    def test_a_closed_way(self):
        polygon, label = national_features(
            {
                'type': 'way',
                'id': 7,
                'tags': {'boundary': 'protected_area', 'protect_class': '2', 'name': 'Petit parc'},
                'geometry': geom(square(6, 45, 0.01)),
            }
        )
        self.assertEqual(polygon['properties'], {'name': 'Petit parc', 'class': 'national', 'rank': 11})
        self.assertEqual(polygon['tippecanoe'], {'minzoom': 9})
        self.assertEqual(label['tippecanoe'], {'minzoom': 11})

    def test_unclosed_relation_keeps_a_label_from_its_bounds(self):
        broken = {
            **JACQUES,
            'members': [JACQUES['members'][0]],  # half the ring
        }
        polygon, label = national_features(broken)
        self.assertIsNone(polygon)
        self.assertEqual(label['geometry']['coordinates'], [-71.3, 47.1])
        self.assertEqual(label['properties']['class'], 'national')

    def test_other_tiers_and_junk(self):
        self.assertEqual(national_features({'type': 'way', 'tags': {'leisure': 'park', 'name': 'X'}}), (None, None))
        self.assertEqual(national_features({'type': 'relation', 'tags': JACQUES['tags']}), (None, None))


class ReserveLabel(unittest.TestCase):
    ZEC = {
        'type': 'relation',
        'id': 8330967,
        'tags': {
            'boundary': 'protected_area',
            'leisure': 'nature_reserve',
            'protect_class': '7',
            'name': 'Zec Batiscan-Neilson',
        },
        'bounds': {'minlat': 47.0, 'minlon': -72.3, 'maxlat': 47.45, 'maxlon': -71.6},
    }

    def test_label_at_the_centre_of_its_bounds_ranked_by_them(self):
        label = reserve_label(self.ZEC)
        self.assertEqual(label['geometry'], {'type': 'Point', 'coordinates': [-71.95, 47.225]})
        # ~53 km × 50 km × 0.6 ≈ 1 600 km²: rank 6 as a park, 8 as a reserve.
        self.assertEqual(label['properties'], {'name': 'Zec Batiscan-Neilson', 'class': 'reserve', 'rank': 8})
        self.assertEqual(label['tippecanoe'], {'minzoom': 8})

    def test_skips_the_national_tier_and_incomplete_elements(self):
        self.assertIsNone(reserve_label({**self.ZEC, 'tags': JACQUES['tags']}))
        self.assertIsNone(reserve_label({k: v for k, v in self.ZEC.items() if k != 'bounds'}))


class Queries(unittest.TestCase):
    def test_national_asks_for_geometry_in_overpass_bbox_order(self):
        q = national_query([-72.0, 46.0, -70.0, 48.0])
        self.assertIn('relation["boundary"="national_park"]["name"](46.0,-72.0,48.0,-70.0);', q)
        self.assertIn('way["boundary"="protected_area"]["protect_class"="2"]["name"]', q)
        self.assertTrue(q.endswith('out geom qt;'))

    def test_reserve_asks_for_tags_and_bounds_only(self):
        q = reserve_query([-72.0, 46.0, -70.0, 48.0])
        self.assertIn('way["leisure"="nature_reserve"]["name"](46.0,-72.0,48.0,-70.0);', q)
        self.assertIn('relation["boundary"="protected_area"]["name"]', q)
        # One geometry mode per `out`: `center bb` would return the bounds alone.
        self.assertTrue(q.endswith('out tags bb qt;'))
        self.assertNotIn('geom', q)
        self.assertNotIn('center', q)


class Convert(unittest.TestCase):
    def test_merges_tiers_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as d:
            raw = os.path.join(d, 'raw')
            os.mkdir(raw)
            way_same_id = {
                'type': 'way',
                'id': JACQUES['id'],  # a way may share a relation's number
                'tags': {'leisure': 'nature_reserve', 'name': 'Marais du Nord'},
                'bounds': {'minlat': 46.9, 'minlon': -71.4, 'maxlat': 46.95, 'maxlon': -71.35},
            }
            # The reserve query returns Jacques-Cartier too (leisure=nature_reserve).
            jacques_as_reserve = {
                'type': 'relation',
                'id': JACQUES['id'],
                'tags': JACQUES['tags'],
                'bounds': JACQUES['bounds'],
            }
            # OSM's double: the same reserve as a way with the same outline.
            zec_twin = {**ReserveLabel.ZEC, 'type': 'way', 'id': 999}
            files = {
                'a.national.json': [JACQUES],
                'b.national.json': [JACQUES],  # pieces overlap
                'a.reserve.json': [ReserveLabel.ZEC, jacques_as_reserve, way_same_id, zec_twin],
                'b.reserve.json': [ReserveLabel.ZEC],
                'notes.txt': [],
            }
            for name, elements in files.items():
                with open(os.path.join(raw, name), 'w', encoding='utf-8') as f:
                    json.dump({'elements': elements}, f)
            areas, labels = os.path.join(d, 'areas.geojsonl'), os.path.join(d, 'labels.geojsonl')
            self.assertEqual(convert(raw, areas, labels), (1, 3))
            with open(areas, encoding='utf-8') as f:
                polygons = [json.loads(line) for line in f]
            with open(labels, encoding='utf-8') as f:
                points = [json.loads(line) for line in f]
            self.assertEqual([p['properties']['class'] for p in polygons], ['national'])
            self.assertEqual(
                sorted((p['properties']['name'], p['properties']['class']) for p in points),
                [
                    ('Marais du Nord', 'reserve'),
                    ('Parc national de la Jacques-Cartier', 'national'),
                    ('Zec Batiscan-Neilson', 'reserve'),
                ],
            )


if __name__ == '__main__':
    unittest.main()
