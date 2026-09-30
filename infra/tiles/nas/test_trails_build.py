"""Tests for trails_build.py:  python3 -m unittest infra/tiles/nas/test_trails_build.py"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trails_build import (  # noqa: E402
    Regions,
    activities_of,
    batches,
    bbox_iou,
    bridge_parts,
    build,
    build_trail,
    chain_ways,
    decode_polyline,
    encode_polyline,
    geom_query,
    is_candidate,
    join_gaps,
    level_of,
    line_length_m,
    merge_duplicates,
    parse_distance_km,
    popularity,
    simplify,
    split4,
    stage_name,
    stands_alone,
    tags_query,
)


def way(ref, coords, role=''):
    return {
        'type': 'way',
        'ref': ref,
        'role': role,
        'geometry': [{'lon': x, 'lat': y} for x, y in coords],
    }


def rel(rid, tags, members, bounds=None):
    el = {'type': 'relation', 'id': rid, 'tags': tags, 'members': members}
    if bounds:
        el['bounds'] = bounds
    return el


# A ~45 km north-south line near Charlevoix, in three ways (the middle one
# drawn backwards, as OSM members often are).
A = [(-70.7, 47.0), (-70.7, 47.1)]
B = [(-70.7, 47.2), (-70.7, 47.1)]
C = [(-70.7, 47.2), (-70.7, 47.4)]


class Tags(unittest.TestCase):
    def test_distance(self):
        self.assertEqual(parse_distance_km('123'), 123)
        self.assertEqual(parse_distance_km('12,5 km'), 12.5)
        self.assertAlmostEqual(parse_distance_km('50 mi'), 80.4672)
        for raw in (None, '', 'long', '-3', '99999'):
            self.assertIsNone(parse_distance_km(raw))

    def test_levels_and_activities(self):
        self.assertEqual(level_of({'network': 'iwn'}), 'i')
        self.assertEqual(level_of({'network': 'rcn'}), 'r')
        self.assertEqual(level_of({'network': 'lwn'}), 'o')
        self.assertEqual(activities_of({'route': 'hiking;bicycle'}), ['hiking', 'cycling'])
        self.assertEqual(activities_of({'route': 'foot'}), ['hiking'])
        self.assertEqual(activities_of({'route': 'horse'}), [])

    def test_candidates(self):
        big = {'minlon': -71, 'minlat': 47, 'maxlon': -70.5, 'maxlat': 47.5}
        small = {'minlon': -71, 'minlat': 47, 'maxlon': -70.99, 'maxlat': 47.01}
        base = {'type': 'route', 'route': 'hiking', 'name': 'X'}
        self.assertTrue(is_candidate(rel(1, {**base, 'network': 'nwn'}, [], big)))
        self.assertFalse(is_candidate(rel(1, {**base, 'network': 'nwn'}, [], small)))
        self.assertTrue(is_candidate(rel(1, {**base, 'network': 'lwn'}, [], big)))
        self.assertTrue(
            is_candidate(rel(1, {**base, 'network': 'lwn', 'distance': '60'}, [], small))
        )
        self.assertFalse(is_candidate(rel(1, {**base, 'state': 'proposed', 'network': 'iwn'}, [], big)))
        self.assertFalse(is_candidate(rel(1, {'type': 'route', 'route': 'hiking'}, [], big)))
        self.assertFalse(
            is_candidate(rel(1, {**base, 'route': 'bicycle', 'network': 'lcn'}, [], big))
        )
        self.assertTrue(
            is_candidate(rel(1, {**base, 'type': 'superroute', 'route': 'hiking'}, [], big))
        )

    def test_queries(self):
        q = tags_query([-71, 46, -70, 47])
        self.assertIn('(46,-71,47,-70)', q)
        self.assertIn('out tags bb;', q)
        self.assertIn('relation(id:1,2);out geom;', geom_query([1, 2]))
        self.assertEqual(split4([0, 0, 2, 2])[3], [1, 1, 2, 2])


class Geometry(unittest.TestCase):
    def test_chains_ways_whatever_their_direction(self):
        parts = chain_ways([A, B, C])
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0][0], A[0])
        self.assertEqual(parts[0][-1], C[-1])
        # A reversed first way is flipped to meet the second.
        parts = chain_ways([list(reversed(A)), B[::-1]])
        self.assertEqual(len(parts), 1)

    def test_gaps(self):
        far = [(-70.0, 48.0), (-70.0, 48.1)]
        self.assertEqual(len(chain_ways([A, far])), 2)
        near = [(-70.7, 47.1003), (-70.7, 47.15)]  # 33 m gap
        self.assertEqual(len(join_gaps([list(A), near])), 1)

    def test_bridges_small_gaps_only(self):
        near = [(-70.7, 47.105), (-70.7, 47.15)]  # ~550 m after A's end
        self.assertEqual(len(bridge_parts([A, near], 1000)), 1)
        self.assertEqual(len(bridge_parts([A, near], 100)), 2)
        # A part drawn the other way round is flipped to meet.
        self.assertEqual(len(bridge_parts([A, list(reversed(near))], 1000)), 1)

    def test_simplify_keeps_ends_and_shape(self):
        line = [(0, 0), (0.0001, 0.00001), (0.0002, 0), (0.01, 0.01)]
        out = simplify(line, 10)
        self.assertEqual(out[0], line[0])
        self.assertEqual(out[-1], line[-1])
        self.assertLess(len(out), len(line))

    def test_polyline_round_trip(self):
        pts = [(-70.12345, 47.54321), (-70.2, 47.6), (6.8, 45.9)]
        self.assertEqual(encode_polyline([(-120.2, 38.5), (-120.95, 40.7)]), '_p~iF~ps|U_ulLnnqC')
        back = decode_polyline(encode_polyline(pts))
        for (x, y), (bx, by) in zip(pts, back):
            self.assertAlmostEqual(x, bx, places=5)
            self.assertAlmostEqual(y, by, places=5)

    def test_misc(self):
        self.assertAlmostEqual(line_length_m(A) / 1000, 11.12, places=1)
        self.assertEqual(bbox_iou([0, 0, 1, 1], [0, 0, 1, 1]), 1.0)
        self.assertEqual(bbox_iou([0, 0, 1, 1], [2, 2, 3, 3]), 0.0)
        self.assertEqual(batches([1, 2, 3, 4], lambda x: x, 5, 10), [[1, 2], [3], [4]])


class StageNames(unittest.TestCase):
    def test_names(self):
        self.assertEqual(stage_name({'name': 'Étape 1'}, 1, 'Tour'), 'Étape 1')
        self.assertEqual(stage_name({}, 3), 'Stage 3')
        self.assertEqual(stage_name({'from': 'A', 'to': 'B'}, 1), 'A → B')
        # A section named like its trail says where it runs instead.
        at = {'name': 'Appalachian Trail'}
        self.assertEqual(stage_name(at, 2, 'Appalachian Trail', 'Vermont'), 'Vermont')
        self.assertEqual(stage_name(at, 2, 'Appalachian Trail'), 'Appalachian Trail')


class StandsAlone(unittest.TestCase):
    def test_sections_fold_into_their_trail(self):
        rels = {
            1: rel(1, {'name': 'Sentier National', 'website': 'https://a.org'}, []),
            2: rel(2, {'name': 'Sentier National, Charlevoix'}, []),
            3: rel(3, {'name': 'Sentier des Caps', 'website': 'https://caps.org'}, []),
            4: rel(4, {'name': 'SIA, 2', 'wikidata': 'Q9'}, []),
            5: rel(5, {'name': 'IAT', 'wikidata': 'Q9'}, []),
            6: rel(6, {'name': 'Appalachian Trail', 'wikidata': 'Q7'}, []),
        }
        parents = {2: [1], 3: [2], 4: [5], 6: [5]}
        links = {'Q9': 30, 'Q7': 35}
        self.assertFalse(stands_alone(2, rels, parents, links))  # named after its trail
        self.assertTrue(stands_alone(3, rels, parents, links))  # its own website
        self.assertFalse(stands_alone(4, rels, parents, links))  # its trail's Wikidata item
        self.assertTrue(stands_alone(6, rels, parents, links))  # famous in its own right
        self.assertFalse(stands_alone(6, rels, parents, {}))


class Popularity(unittest.TestCase):
    def test_orders_fame_network_and_length(self):
        famous = popularity({'network': 'iwn', 'wikidata': 'Q1'}, 3500, 40, True)
        regional = popularity({'network': 'rwn'}, 50, 0, False)
        local = popularity({'network': 'lwn'}, 40, 0, False)
        self.assertGreater(famous, regional)
        self.assertGreater(regional, local)
        self.assertLessEqual(famous, 1.0)
        self.assertEqual(popularity({'network': 'iwn', 'wikipedia': 'fr:X'}, 2000, 40, True), 1.0)


class Build(unittest.TestCase):
    def relations(self):
        stage1 = rel(11, {'type': 'route', 'route': 'hiking', 'name': 'Étape 1'}, [way(1, A), way(2, B)])
        stage2 = rel(
            12,
            {'type': 'route', 'route': 'hiking', 'from': 'Col', 'to': 'Lac'},
            [way(3, C), way(4, [(-71, 46), (-71.5, 46)], 'alternative')],
        )
        parent = rel(
            10,
            {
                'type': 'superroute',
                'route': 'hiking',
                'network': 'nwn',
                'name': 'Grande Traversée',
                'name:en': 'Great Crossing',
                'wikidata': 'Q42',
                'from': 'Sud',
                'to': 'Nord',
                'website': 'https://example.org',
            },
            [
                {'type': 'relation', 'ref': 11, 'role': ''},
                {'type': 'relation', 'ref': 12, 'role': ''},
            ],
            {'minlon': -70.7, 'minlat': 47.0, 'maxlon': -70.7, 'maxlat': 47.4},
        )
        short = rel(
            20,
            {'type': 'route', 'route': 'hiking', 'network': 'rwn', 'name': 'Petit tour'},
            [way(5, A)],
            {'minlon': -70.7, 'minlat': 47.0, 'maxlon': -70.6, 'maxlat': 47.1},
        )
        return {r['id']: r for r in (stage1, stage2, parent, short)}

    def test_trail_with_stages(self):
        rels = self.relations()
        row, detail, ccs = build_trail(rels[10], rels, {'Q42': 12}, Regions(None))
        self.assertEqual(row['id'], 'r10')
        self.assertEqual(row['n'], 'Grande Traversée')
        self.assertEqual(row['ne'], 'Great Crossing')
        self.assertEqual(row['net'], 'n')
        self.assertEqual(row['st'], 2)
        self.assertAlmostEqual(row['km'], 44.5, delta=0.5)
        self.assertEqual((row['fr'], row['to']), ('Sud', 'Nord'))
        self.assertTrue(row['t'])
        self.assertEqual([s['name'] for s in detail['stages']], ['Étape 1', 'Col → Lac'])
        # The alternative way is not part of stage 2.
        self.assertAlmostEqual(detail['stages'][1]['km'], 22.2, delta=0.3)
        self.assertNotIn('geom', detail)
        self.assertEqual(detail['website'], 'https://example.org')
        self.assertEqual(ccs, [])

    def test_too_short_is_dropped(self):
        rels = self.relations()
        self.assertIsNone(build_trail(rels[20], rels, {}, Regions(None)))

    def test_twins_merge(self):
        rows = [
            {'id': 'r1', 'n': 'Traversée de Charlevoix', 'a': ['hiking'], 'p': 0.5, 'km': 100, 'b': [0, 0, 1, 1]},
            {'id': 'r2', 'n': 'Traversee de Charlevoix', 'a': ['skiing'], 'p': 0.4, 'km': 90, 'b': [0, 0, 1, 0.9]},
            {'id': 'r3', 'n': 'Traversée de Charlevoix', 'a': ['cycling'], 'p': 0.4, 'km': 90, 'b': [5, 5, 6, 6]},
        ]
        out, dropped = merge_duplicates(rows)
        self.assertEqual(dropped, {'r2'})
        self.assertEqual(out[0]['a'], ['hiking', 'skiing'])
        self.assertEqual(len(out), 2)

    def test_regions_from_geojson(self):
        with tempfile.TemporaryDirectory() as d:
            square = {'type': 'Polygon', 'coordinates': [[[-72, 46], [-69, 46], [-69, 48], [-72, 48], [-72, 46]]]}
            with open(os.path.join(d, 'ne_50m_admin_0_countries.geojson'), 'w') as f:
                json.dump({'features': [{'properties': {'ISO_A2': 'CA', 'NAME': 'Canada', 'CONTINENT': 'North America'}, 'geometry': square}]}, f)
            with open(os.path.join(d, 'ne_10m_admin_1_states_provinces.geojson'), 'w') as f:
                json.dump({'features': [{'properties': {'iso_a2': 'CA', 'name': 'Québec'}, 'geometry': square}]}, f)
            regions = Regions(d)
            self.assertEqual(regions.country((-70.7, 47.2)), ('CA', 'Canada', 'North America'))
            self.assertEqual(regions.region((-70.7, 47.2)), 'Québec')
            self.assertIsNone(regions.country((0, 0)))

    def test_build_writes_index_details_and_offsets(self):
        rels = self.relations()
        with tempfile.TemporaryDirectory() as work:
            raw = os.path.join(work, 'raw')
            os.makedirs(os.path.join(raw, 'geom'))
            with open(os.path.join(raw, 'tags-x.json'), 'w') as f:
                json.dump({'elements': [rels[10], rels[20]]}, f)
            with open(os.path.join(raw, 'geom', '00001.json'), 'w') as f:
                json.dump({'elements': list(rels.values())}, f)
            out = os.path.join(work, 'out')
            self.assertEqual(build(work, out, version='t1'), 1)
            with open(os.path.join(out, 'trails-v1.index.json')) as f:
                index = json.load(f)
            self.assertEqual(index['details'], 't1')
            self.assertEqual([t['id'] for t in index['trails']], ['r10'])
            with open(os.path.join(out, 'trails-t1.offsets.json')) as f:
                offsets = json.load(f)
            start, length = offsets['r10']
            with open(os.path.join(out, 'trails-t1.details.bin'), 'rb') as f:
                f.seek(start)
                detail = json.loads(f.read(length))
            self.assertEqual(detail['id'], 'r10')
            self.assertEqual(len(detail['stages']), 2)


if __name__ == '__main__':
    unittest.main()
