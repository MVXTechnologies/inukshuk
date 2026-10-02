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
    haversine_m,
    is_candidate,
    join_gaps,
    level_of,
    line_length_m,
    main_parts,
    merge_duplicates,
    merge_shared_ends,
    order_pieces,
    order_stages,
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


def line(lon, lat0, lat1, steps=4):
    """A north-south line at `lon` from lat0 to lat1 (either way), `steps` segments."""
    return [(lon, round(lat0 + (lat1 - lat0) * k / steps, 6)) for k in range(steps + 1)]


def biggest_jump_m(parts):
    """The longest end→start hop between consecutive parts (0 for one part)."""
    return max((haversine_m(a[-1], b[0]) for a, b in zip(parts, parts[1:])), default=0.0)


def stage_rel(rid, ways, **tags):
    return rel(
        rid,
        {'type': 'route', 'route': 'hiking', **tags},
        [way(rid * 100 + k, g) for k, g in enumerate(ways)],
    )


def super_rel(rid, stage_ids, **tags):
    return rel(
        rid,
        {'type': 'superroute', 'route': 'hiking', 'network': 'nwn', 'name': 'Long Trail', **tags},
        [{'type': 'relation', 'ref': s, 'role': ''} for s in stage_ids],
    )


class SegmentOrder(unittest.TestCase):
    """The mixed-up segments of the 2026-09 pilot, one fixture per bug."""

    # Six consecutive ~11 km ways of one north-going line.
    W = [line(-70.7, 47.0 + 0.1 * k, 47.1 + 0.1 * k) for k in range(6)]

    def test_unsorted_way_members_chain_into_one_line(self):
        # The Cross Vermont Trail: members listed in no particular order, some
        # drawn backwards → 15 parts scattered back and forth. Now one line.
        w = self.W
        shuffled = [w[3], w[0][::-1], w[5], w[1], w[4][::-1], w[2]]
        parts = chain_ways(shuffled)
        self.assertEqual(len(parts), 1)
        self.assertAlmostEqual(line_length_m(parts[0]) / 1000, 66.7, delta=0.3)
        # The direction is the first member's (w[3] runs north).
        self.assertLess(parts[0][0][1], parts[0][-1][1])
        old_style = [list(g) for g in shuffled]  # what a member-order-only chain kept
        self.assertGreater(biggest_jump_m(old_style), 20000)

    def test_first_member_reversed_keeps_its_direction(self):
        parts = chain_ways([self.W[1][::-1], self.W[0][::-1]])
        self.assertEqual(len(parts), 1)
        self.assertGreater(parts[0][0][1], parts[0][-1][1])  # runs south, as listed

    def test_disjoint_pieces_stay_separate_and_in_order(self):
        # Two unmapped gaps (a 2 km and a 5 km hole), pieces listed out of
        # order and one reversed: separate parts — no made-up connector —
        # ordered so each hop is the real gap, never across the whole trail.
        a = line(-70.7, 47.0, 47.1)
        b = line(-70.7, 47.118, 47.2)  # 2 km after a
        c = line(-70.7, 47.245, 47.3)  # 5 km after b
        parts = chain_ways([c, a, b[::-1]])
        self.assertEqual(len(parts), 3)
        self.assertLess(biggest_jump_m(parts), 5100)
        hops = [haversine_m(p[-1], q[0]) for p, q in zip(parts, parts[1:])]
        self.assertEqual(len(hops), 2)
        self.assertAlmostEqual(sum(hops), 7000, delta=200)
        # Runs south (the first member, c, is the north end and comes first).
        self.assertGreater(parts[0][0][1], parts[-1][-1][1])

    def test_member_order_kept_when_it_is_fine(self):
        # A correctly listed relation with small gaps is not reshuffled.
        a = line(-70.7, 47.0, 47.1)
        b = line(-70.7, 47.11, 47.2)
        c = line(-70.7, 47.21, 47.3)
        parts = chain_ways([a, b, c])
        self.assertEqual([p[0] for p in parts], [a[0], b[0], c[0]])

    def test_order_pieces(self):
        ends = [((0, 0), (0, 1)), ((0, 3), (0, 2)), ((0, 1.01), (0, 1.99))]
        # Stored order 0,1,2 jumps 0→3→1; the chaining is 0, 2, 1 (1 flipped).
        self.assertEqual(order_pieces(ends), [(0, False), (2, False), (1, True)])
        # Already in order: kept, only the reversed piece turned.
        ends = [((0, 0), (0, 1)), ((0, 2), (0, 1)), ((0, 2), (0, 3))]
        self.assertEqual(order_pieces(ends), [(0, False), (1, True), (2, False)])
        self.assertEqual(order_pieces([((0, 0), (0, 1))]), [(0, False)])
        self.assertEqual(order_pieces([]), [])

    def test_t_junction_is_not_merged_blindly(self):
        # A spur off the middle of the line shares a node with two ways:
        # never glued into a zig-zag, all geometry kept.
        main1 = [(-70.7, 47.0), (-70.7, 47.1)]
        main2 = [(-70.7, 47.1), (-70.7, 47.2)]
        spur = [(-70.7, 47.1), (-70.6, 47.1)]
        parts = chain_ways([main1, spur, main2])
        total = sum(line_length_m(p) for p in parts)
        self.assertAlmostEqual(total, sum(line_length_m(g) for g in (main1, main2, spur)), delta=1)
        for p in parts:  # no part doubles back on itself
            self.assertEqual(len(set(p)), len(p))

    def test_merge_shared_ends_closes_rings_and_keeps_order(self):
        ring = [[(0, 0), (1, 0)], [(1, 1), (1, 0)], [(1, 1), (0, 0)]]
        out = merge_shared_ends(ring)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0][0], out[0][-1])
        self.assertEqual(out[0][:2], [(0, 0), (1, 0)])  # the first member's direction

    def test_reversed_stage_is_turned_round(self):
        # The Appalachian Trail's Virginia (and the Balcon du Léman stages the
        # GR 5 walks the other way): a section mapped backwards drew its
        # stage-join marker at the wrong end and a 450 km hop.
        w = self.W
        rels = {
            1: stage_rel(1, [w[0], w[1]], name='Georgia'),
            2: stage_rel(2, [w[3][::-1], w[2][::-1]], name='Virginia', **{'from': 'North', 'to': 'South'}),
            3: stage_rel(3, [w[4], w[5]], name='Maine'),
            9: super_rel(9, [1, 2, 3]),
        }
        _, detail, _ = build_trail(rels[9], rels, {}, Regions(None))
        stages = detail['stages']
        self.assertEqual([s['id'] for s in stages], ['r1', 'r2', 'r3'])
        geoms = [[decode_polyline(g) for g in s['geom']] for s in stages]
        whole = [p for g in geoms for p in g]
        self.assertLess(biggest_jump_m(whole), 5)
        # Virginia now runs north like the rest, its from/to with it.
        self.assertLess(geoms[1][0][0][1], geoms[1][-1][-1][1])
        self.assertEqual((stages[1]['from'], stages[1]['to']), ('South', 'North'))

    def test_stages_out_of_order_are_reordered(self):
        w = self.W
        rels = {
            1: stage_rel(1, [w[0], w[1]], name='A'),
            2: stage_rel(2, [w[2], w[3]], name='B'),
            3: stage_rel(3, [w[4], w[5]], name='C'),
            9: super_rel(9, [1, 3, 2]),  # listed A, C, B
        }
        _, detail, _ = build_trail(rels[9], rels, {}, Regions(None))
        self.assertEqual([s['name'] for s in detail['stages']], ['A', 'B', 'C'])

    def test_stage_order_kept_when_member_order_is_right(self):
        # Correct order with a 3 km unmapped hole between stages: untouched.
        a = line(-70.7, 47.0, 47.2)
        b = line(-70.7, 47.227, 47.5)
        c = line(-70.7, 47.5, 47.8)
        rels = {
            1: stage_rel(1, [a], name='A'),
            2: stage_rel(2, [b], name='B'),
            3: stage_rel(3, [c], name='C'),
            9: super_rel(9, [1, 2, 3]),
        }
        _, detail, _ = build_trail(rels[9], rels, {}, Regions(None))
        self.assertEqual([s['name'] for s in detail['stages']], ['A', 'B', 'C'])

    def test_side_trail_stages_stay_after_the_main_sections(self):
        # The Bruce / Rideau Trail pattern: main sections in order, then side
        # trails that branch off mid-section. Re-chaining by distance would
        # interleave them; only stages that hand over to each other move.
        w = self.W
        side1 = [(-70.7, 47.05), (-70.6, 47.05)]  # off the middle of A
        side2 = [(-70.7, 47.45), (-70.8, 47.45)]  # off the middle of C
        rels = {
            1: stage_rel(1, [w[0], w[1]], name='A'),
            2: stage_rel(2, [w[2], w[3]], name='B'),
            3: stage_rel(3, [w[4], w[5]], name='C'),
            4: stage_rel(4, [side2], name='C side trails'),
            5: stage_rel(5, [side1], name='A side trails'),
            9: super_rel(9, [1, 2, 3, 4, 5]),
        }
        _, detail, _ = build_trail(rels[9], rels, {}, Regions(None))
        self.assertEqual(
            [s['name'] for s in detail['stages']], ['A', 'B', 'C', 'C side trails', 'A side trails']
        )

    def test_order_stages(self):
        a, b, c = ((0, 0), (0, 1)), ((0, 1.001), (0, 2)), ((0, 2), (0, 3))
        # Listed C, A, B: the run A-B-C, C (the earliest) kept nearest the start → C, B, A.
        self.assertEqual(order_stages([c, a, b]), [(0, True), (2, True), (1, True)])
        # Two stages whose ends are nowhere near: member order, as mapped.
        self.assertEqual(order_stages([a, ((5, 5), (5, 6))]), [(0, False), (1, False)])
        # A side loop starting next to the trail's start (the Rideau Trail's
        # K&P Blue Loop) is not pulled in front of stage 1.
        loop = ((0, -0.001), (0.001, -0.001))
        self.assertEqual(order_stages([a, b, loop]), [(0, False), (1, False), (2, False)])

    def test_reversed_superroute_order_still_starts_at_the_first_member(self):
        # Stages listed south→north but each mapped north→south and shuffled:
        # the trail runs the way its first stage sits (first half of the line).
        w = self.W
        rels = {
            1: stage_rel(1, [w[1][::-1], w[0][::-1]], name='A'),
            2: stage_rel(2, [w[5][::-1], w[4][::-1]], name='C'),
            3: stage_rel(3, [w[3][::-1], w[2][::-1]], name='B'),
            9: super_rel(9, [1, 2, 3]),
        }
        _, detail, _ = build_trail(rels[9], rels, {}, Regions(None))
        self.assertEqual([s['name'] for s in detail['stages']], ['A', 'B', 'C'])

    def test_way_shared_by_two_child_routes_is_drawn_once(self):
        # Two sections of a wrapper overlap on one way (the Trans Canada
        # Trail's): chained twice it ran out and back over itself and its
        # length counted double. A way repeated in ONE relation (a spur out
        # and back) is deliberate and kept.
        w = self.W
        shared = way(77, w[2])
        rels = {
            1: rel(1, {'type': 'route', 'route': 'hiking'}, [way(10, w[0]), way(11, w[1]), shared]),
            2: rel(2, {'type': 'route', 'route': 'hiking'}, [shared, way(12, w[3])]),
            9: rel(
                9,
                {'type': 'route', 'route': 'hiking', 'network': 'rwn', 'name': 'Wrapper'},
                [{'type': 'relation', 'ref': 1, 'role': ''}, {'type': 'relation', 'ref': 2, 'role': ''}],
            ),
        }
        parts = main_parts(rels[9], rels)
        self.assertEqual(len(parts), 1)
        self.assertAlmostEqual(line_length_m(parts[0]) / 1000, 44.5, delta=0.3)
        spur = [(-70.7, 47.1), (-70.6, 47.1)]
        out_and_back = rel(
            3,
            {'type': 'route', 'route': 'hiking'},
            [way(10, w[0]), way(13, spur), way(13, spur), way(11, w[1])],
        )
        parts = main_parts(out_and_back, {3: out_and_back})
        self.assertEqual(len(parts), 1)
        total = line_length_m(w[0]) + line_length_m(w[1]) + 2 * line_length_m(spur)
        self.assertAlmostEqual(line_length_m(parts[0]), total, delta=1)

    def test_thumbnail_follows_the_ordered_line(self):
        w = self.W
        shuffled = [w[3], w[0][::-1], w[5], w[1], w[4][::-1], w[2]]
        rels = {
            1: rel(
                1,
                {'type': 'route', 'route': 'hiking', 'network': 'rwn', 'name': 'Cross Trail'},
                [way(k, g) for k, g in enumerate(shuffled)],
            )
        }
        row, detail, _ = build_trail(rels[1], rels, {}, Regions(None))
        self.assertEqual(len(detail['geom']), 1)
        thumb = [decode_polyline(t, 4) for t in row['t']]
        self.assertEqual(len(thumb), 1)
        pts = thumb[0]
        lats = [p[1] for p in pts]
        self.assertTrue(lats == sorted(lats) or lats == sorted(lats, reverse=True))


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
