"""Tests for the climbing-crags pipeline.

    python3 -m unittest discover -s infra/tiles/nas/climbing -p 'test_*.py'

Fixtures (fixtures/README.md): real OpenBeta rows (Lac Long, Weir,
Val-Bélair, Portneuf ice), the real Overpass answer for Weir, and a made-up
camptocamp waypoint. Standard library only (the OpenBeta Parquet reader is
not exercised here).
"""
import json
import math
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
FX = os.path.join(HERE, 'fixtures')

import c2c  # noqa: E402
import grades  # noqa: E402
import ladder  # noqa: E402
import merge  # noqa: E402
import openbeta  # noqa: E402
import order  # noqa: E402
import osm  # noqa: E402
import partners  # noqa: E402
import publish  # noqa: E402
from common import STYLE_BITS, fold, jaro_winkler, name_key  # noqa: E402


def load(name):
    with open(os.path.join(FX, name), encoding='utf-8') as f:
        return json.load(f)


def ob_crags():
    return openbeta.normalize(load('openbeta_quebec_sample.json'))


def osm_crags():
    return osm.normalize(load('osm_weir.json')['elements'])


def by_name(crags, name):
    return [c for c in crags if c['name'] == name]


class Grades(unittest.TestCase):
    def test_yds_ladder(self):
        self.assertEqual(grades.yds_index('5.7'), 7)
        self.assertEqual(grades.yds_index('5.9+'), 9)
        self.assertEqual(grades.yds_index('5.10a'), 10)
        self.assertEqual(grades.yds_index('5.10d'), 13)
        self.assertEqual(grades.yds_index('5.11a/b'), 14)
        self.assertEqual(grades.yds_index('5.12A'), 18)
        self.assertEqual(grades.yds_index('5.15d'), 33)
        self.assertEqual(grades.yds_index('Easy 5th'), 0)
        self.assertIsNone(grades.yds_index('4th'))
        self.assertIsNone(grades.yds_index('V3'))

    def test_letterless_yds_reads_like_openbeta_french(self):
        # OpenBeta's export pairs 5.10- / 5.10 / 5.10+ with 6a / 6b / 6b+.
        for yds, fr in (('5.10-', '6a'), ('5.10', '6b'), ('5.10+', '6b+'), ('5.12', '7b+')):
            self.assertEqual(grades.ROPE_FRENCH[grades.yds_index(yds)], fr, yds)

    def test_french_and_uiaa(self):
        self.assertEqual(grades.french_index('6a'), 10)
        self.assertEqual(grades.french_index('7a'), 17)
        self.assertEqual(grades.french_index('8a'), 23)
        self.assertEqual(grades.french_index('6c+'), 16)
        self.assertEqual(grades.french_index('7b+/7c'), 20)
        self.assertEqual(grades.uiaa_index('6+'), 10)
        self.assertEqual(grades.uiaa_index('9+'), 20)
        self.assertEqual(grades.uiaa_index('10-'), 21)
        self.assertEqual(grades.uiaa_index('VI+'), 10)
        self.assertIsNone(grades.uiaa_index('hard'))

    def test_boulder_and_ice(self):
        self.assertEqual(grades.v_index('V-easy'), -1)
        self.assertEqual(grades.v_index('V0+'), 0)
        self.assertEqual(grades.v_index('V2-3'), 2)
        self.assertEqual(grades.v_index('v10'), 10)
        self.assertEqual(grades.font_index('7a'), 6)
        self.assertEqual(grades.font_index('6B+'), 4)
        self.assertEqual(grades.wi_index('WI4+'), 4)
        self.assertEqual(grades.wi_index('WI3-4'), 3)

    def test_bands(self):
        self.assertEqual([grades.band('r', i) for i in (7, 8, 13, 14, 17, 18)], [0, 1, 1, 2, 2, 3])
        self.assertEqual([grades.band('b', i) for i in (-1, 2, 3, 6, 9)], [0, 0, 1, 2, 3])
        self.assertEqual([grades.band('i', i) for i in (3, 4, 5, 6)], [0, 1, 2, 3])
        self.assertIsNone(grades.band('r', None))

    def test_osm_grade_keys(self):
        g = grades.from_osm({'climbing:grade:uiaa': '7-', 'climbing:grade:french': '6a+'})
        self.assertEqual(g, {'g': '7-', 'gs': 'uiaa', 'k': 'r', 'x': 11})
        self.assertEqual(grades.from_osm({'climbing:grade:saxon': 'VIIb'}), {'g': 'VIIb', 'gs': 'saxon'})
        self.assertEqual(grades.from_osm({'climbing:grade:ice': 'WI4'})['k'], 'i')
        self.assertEqual(grades.from_osm({}), {})

    def test_openbeta_grades(self):
        self.assertEqual(
            grades.from_openbeta({'grade_yds': '5.9', 'grade_vscale': None}, boulder=True),
            {'g': '5.9', 'gs': 'yds', 'k': 'r', 'x': 9},
        )
        self.assertEqual(
            grades.from_openbeta({'grade_yds': 'V3', 'grade_vscale': 'V3'}, boulder=True)['k'], 'b'
        )
        self.assertEqual(grades.from_openbeta({'grade_french': '6b'}, boulder=False)['x'], 12)


class Names(unittest.TestCase):
    def test_fold_and_keys(self):
        self.assertEqual(fold('Mur de l’Ouest!'), 'mur de l ouest')
        self.assertEqual(name_key('Mont Pinacle'), 'pinacle')
        self.assertGreater(jaro_winkler('far west', 'far ouest'), 0.85)
        self.assertLess(jaro_winkler('weir', 'lac long'), 0.6)


class OpenBeta(unittest.TestCase):
    def test_lac_long_is_one_crag_with_its_areas_as_sectors(self):
        [lac] = by_name(ob_crags(), 'Lac Long')
        names = [s['n'] for s in lac['sectors']]
        self.assertEqual(names[:3], ['Southern Area', 'Central Area', 'Northern Area'])
        self.assertEqual(lac['region'], 'Quebec City, Charlevoix, Portneuf')
        self.assertTrue(lac['uid'].startswith('ob-'))
        self.assertTrue(all(not s['ordered'] for s in lac['sectors']))
        # Unordered sectors list easiest first.
        xs = [r['x'] for r in lac['sectors'][0]['routes'] if r.get('k') == 'r']
        self.assertEqual(xs, sorted(xs))

    def test_facts_only(self):
        for c in ob_crags():
            for s in c['sectors']:
                for r in s['routes']:
                    self.assertTrue(r['id'].startswith('ob:'))
                    self.assertFalse({'fa', 'first_ascent', 'description', 'd'} & set(r))

    def test_open_projects_have_no_grade(self):
        routes = [r for c in ob_crags() for s in c['sectors'] for r in s['routes'] if 'Open Project' in r['n']]
        self.assertTrue(routes)
        for r in routes:
            self.assertEqual(r['g'], 'Project')
            self.assertNotIn('x', r)

    def test_closed_in_name_is_closed_and_cleaned(self):
        [vb] = by_name(ob_crags(), 'Val-Bélair')
        self.assertEqual(vb['access']['status'], 'closed')
        self.assertEqual(openbeta.display_name('Edge (Closed), The'), 'The Edge')

    def test_unknown_access_is_never_open(self):
        for c in ob_crags():
            self.assertNotEqual((c.get('access') or {}).get('status'), 'open')

    def test_unflagged_climbs_under_ice_areas_are_ice(self):
        ice = [c for c in ob_crags() if c['path'][2] == 'Quebec Ice, Mixed & Alpine']
        styles = {r.get('st') for c in ice for s in c['sectors'] for r in s['routes']}
        self.assertIn(STYLE_BITS['ice'], styles)

    def test_takedowns(self):
        rows = load('openbeta_quebec_sample.json')
        lac = [r for r in rows if r['area'] == 'Lac Long']
        one = lac[0]['climb_id']
        crags = openbeta.normalize(rows, {'ob': [one]})
        ids = {r['id'] for c in crags for s in c['sectors'] for r in s['routes']}
        self.assertNotIn(f'ob:{one}', ids)
        crags = openbeta.normalize(rows, {'ob_paths': ['Canada/Quebec/Laurentides/Weir']})
        self.assertEqual([c['path'] for c in by_name(crags, 'Weir')], [
            ['Canada', 'Quebec', 'Quebec Ice, Mixed & Alpine', 'Laurentians Ice', 'Weir']
        ] if by_name(crags, 'Weir') else [])


class Order(unittest.TestCase):
    def test_facing(self):
        self.assertEqual(order.facing_azimuth('S'), 180)
        self.assertEqual(order.facing_azimuth('south-west'), 225)
        self.assertEqual(order.facing_azimuth('200'), 200)
        self.assertIsNone(order.facing_azimuth('N;S'))
        self.assertIsNone(order.facing_azimuth(''))

    def test_south_facing_wall_reads_west_to_east(self):
        starts = [(45.0, -74.0001), (45.0, -74.0003), (45.0, -74.0002)]
        self.assertEqual(order.order_routes(starts, facing=180), [1, 2, 0])
        # North-facing: the viewer looks south, their right is west.
        self.assertEqual(order.order_routes(starts, facing=0), [0, 2, 1])

    def test_cliff_convention_and_side(self):
        line = [(45.0, -74.001), (45.0, -73.999)]  # drawn west → east
        on_line = [(45.0, -74.0002), (45.0, -73.9995)]
        self.assertEqual(order.order_routes(on_line, line_ll=line), [0, 1])
        # Starts clearly NORTH of a west→east line: the base is north, so the
        # viewer faces south and reads east to west.
        north = [(45.0002, -74.0002), (45.0002, -73.9995)]
        self.assertEqual(order.order_routes(north, line_ll=line), [1, 0])

    def test_unknown_without_facing_or_line(self):
        self.assertIsNone(order.order_routes([(45, -74), (45, -74.001)]))
        self.assertIsNone(order.order_routes([(45, -74)], facing=180))
        # All starts on one spot: no spread, no order.
        self.assertIsNone(order.order_routes([(45, -74), (45, -74)], facing=180))


class Osm(unittest.TestCase):
    def test_weir_walls_are_ordered_sectors(self):
        crags = osm_crags()
        [bw] = by_name(crags, 'Black and White')
        sec = bw['sectors'][0]
        self.assertTrue(sec['ordered'])
        self.assertEqual(sec['src'], 'osm')
        self.assertGreaterEqual(len(sec['routes']), 25)
        lngs = [r['pos'][0] for r in sec['routes']]
        self.assertLess(lngs[0], lngs[-1])  # south-facing: west to east
        self.assertIn("L'aiguillette 2", [r['n'] for r in sec['routes'][:4]])
        # The cliff way and the site relation are one sector.
        self.assertIn('osm-w871469140', bw['alias'])

    def test_route_fields(self):
        r = next(
            r for c in osm_crags() for s in c['sectors'] for r in s['routes'] if r['n'] == '3D'
        )
        self.assertEqual((r['g'], r['gs'], r['k'], r['x'], r['len'], r['bolts']), ('8+', 'uiaa', 'r', 17, 20, 6))
        self.assertTrue(r['id'].startswith('osm:n'))

    def test_gyms_are_dropped(self):
        els = [
            {'type': 'node', 'id': 1, 'lat': 45, 'lon': -73,
             'tags': {'sport': 'climbing', 'leisure': 'sports_centre', 'name': 'Gym'}},
            {'type': 'node', 'id': 2, 'lat': 45.1, 'lon': -73,
             'tags': {'climbing': 'crag', 'name': 'Real crag'}},
        ]
        self.assertEqual([c['name'] for c in osm.normalize(els)], ['Real crag'])

    def test_access_tags_restrict_but_never_open(self):
        els = [
            {'type': 'node', 'id': 3, 'lat': 45, 'lon': -73,
             'tags': {'climbing': 'crag', 'name': 'A', 'access': 'no'}},
            {'type': 'node', 'id': 4, 'lat': 46, 'lon': -73,
             'tags': {'climbing': 'crag', 'name': 'B', 'access': 'yes'}},
        ]
        out = {c['name']: c.get('access') for c in osm.normalize(els)}
        self.assertEqual(out['A']['status'], 'closed')
        self.assertIsNone(out['B'])


class C2c(unittest.TestCase):
    def test_record(self):
        rec = c2c.record(load('c2c_waypoint.json'))
        self.assertEqual(rec['uid'], 'c2c-999001')
        self.assertEqual(rec['name'], 'Palissades de Charlevoix')
        self.assertEqual(rec['names'], {'en': 'Charlevoix Palisades'})
        self.assertAlmostEqual(rec['lng'], math.degrees(-7789168.0 / 6378137.0), places=5)
        self.assertEqual(rec['approach']['min'], 45)
        self.assertEqual(rec['approach']['text']['fr'], 'Depuis le stationnement, suivre le sentier 15 min.\n\nTexte inventé.')
        self.assertEqual(rec['approach']['url'], 'https://www.camptocamp.org/waypoints/999001')
        self.assertEqual((rec['min'], rec['max'], rec['declared']), ('5a', '7a', 40))
        self.assertEqual(rec['rock'], 'anorthosite')

    def test_access_time(self):
        self.assertEqual(c2c.access_minutes('1h30'), 90)
        self.assertEqual(c2c.access_minutes('1h'), 60)
        self.assertIsNone(c2c.access_minutes('min'))


class Merge(unittest.TestCase):
    def test_weir_osm_walls_fold_into_openbeta_weir(self):
        ob = ob_crags()
        crags = merge.assemble(ob, osm_crags(), [])
        weirs = [c for c in crags if c['name'] == 'Weir' and 'Laurentides' in c['path']]
        self.assertEqual(len(weirs), 1)
        weir = weirs[0]
        self.assertTrue(weir['uid'].startswith('ob-'))
        srcs = {s['src'] for s in weir['sectors']}
        self.assertIn('osm', srcs)
        names = [s['n'] for s in weir['sectors']]
        # OSM's ordered Black and White replaces OpenBeta's
        # "Black&White - Club Sandwich" (their routes overlap).
        self.assertIn('Black and White', names)
        self.assertNotIn('Black&White - Club Sandwich', names)
        # No OSM wall of Weir is left standing as a crag of its own.
        self.assertFalse([c for c in crags if c['uid'].startswith('osm-') and c['name'] == 'Black and White'])
        self.assertIn('osm-r11876741', weir['alias'])

    def test_one_source_per_sector(self):
        crags = merge.assemble(ob_crags(), osm_crags(), [])
        for c in crags:
            for s in c['sectors']:
                srcs = {r['id'].split(':')[0] for r in s['routes']}
                self.assertLessEqual(len(srcs), 1, s['n'])

    def test_c2c_enriches_the_match_or_stands_alone(self):
        rec = c2c.record(load('c2c_waypoint.json'))
        crag = {'uid': 'ob-x', 'name': 'Palissades de Charlevoix', 'lat': rec['lat'] + 0.002,
                'lng': rec['lng'], 'sectors': []}
        left = merge.attach_c2c([crag], [rec])
        self.assertEqual(left, [])
        self.assertEqual(crag['c2c'], rec['url'])
        self.assertEqual(crag['approach']['min'], 45)
        far = dict(rec, lat=rec['lat'] + 1)
        self.assertEqual(len(merge.attach_c2c([{**crag, 'c2c': None}], [far])), 1)

    def test_most_restrictive_access(self):
        a = merge._restrictive({'status': 'restricted'}, None, {'status': 'closed'})
        self.assertEqual(a['status'], 'closed')
        self.assertIsNone(merge._restrictive(None, None))

    def test_crag_takedown(self):
        ob = ob_crags()
        [lac] = by_name(ob, 'Lac Long')
        crags = merge.assemble(ob, [], [], [lac['uid']])
        self.assertFalse(by_name(crags, 'Lac Long'))


class Partners(unittest.TestCase):
    def test_nothing_read_without_a_signed_agreement(self):
        tmp = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(tmp, 'fqme'))
            with open(os.path.join(tmp, 'fqme', 'sites.json'), 'w') as f:
                json.dump([{'id': 1, 'name': 'X', 'lat': 0, 'lng': 0, 'status': 'banned'}], f)
            os.environ.pop('CLIMBING_FQME_AGREEMENT', None)
            self.assertEqual(partners.load_fqme(tmp), [])
            os.environ['CLIMBING_FQME_AGREEMENT'] = 'signed'
            self.assertEqual(len(partners.load_fqme(tmp)), 1)
        finally:
            os.environ.pop('CLIMBING_FQME_AGREEMENT', None)
            shutil.rmtree(tmp)

    def test_partner_status_wins(self):
        crag = {'name': 'Mont Synthétique', 'lat': 46.0, 'lng': -73.0,
                'access': {'status': 'closed', 'src': 'ob'}}
        site = {'name': 'Mont Synthetique', 'lat': 46.001, 'lng': -73.0, 'status': 'restricted',
                'url': 'https://example.org/site'}
        self.assertEqual(partners.apply_access([crag], [site]), 1)
        self.assertEqual(crag['access'], {'status': 'restricted', 'src': 'fqme', 'url': 'https://example.org/site'})
        self.assertEqual(crag['links'][0]['src'], 'fqme')


class Publish(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        crags = merge.assemble(ob_crags(), osm_crags(), [c2c.record(load('c2c_waypoint.json'))])
        self.report = publish.publish(crags, self.tmp, 'test')
        with open(os.path.join(self.tmp, 'climbing-test.offsets.json')) as f:
            self.offsets = json.load(f)
        with open(os.path.join(self.tmp, 'climbing-test.details.bin'), 'rb') as f:
            self.bin = f.read()
        with open(os.path.join(self.tmp, 'crags.geojsonl')) as f:
            self.tiles = [json.loads(line) for line in f]
        with open(os.path.join(self.tmp, 'route_starts.geojsonl')) as f:
            self.starts = [json.loads(line) for line in f]
        with open(os.path.join(self.tmp, 'climbing-v1.index.json')) as f:
            self.index = json.load(f)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def doc(self, uid):
        o, n = self.offsets[uid]
        return json.loads(self.bin[o:o + n])

    def test_every_crag_has_a_detail_and_a_tile(self):
        self.assertEqual(len(self.offsets), len(self.tiles))
        self.assertEqual(self.report['crags'], len(self.tiles))
        self.assertEqual(len(self.index['rows']), len(self.tiles))
        self.assertEqual(self.index['details'], 'test')

    def test_weir_detail_and_tile(self):
        tile = next(t for t in self.tiles if t['properties']['n'] == 'Weir' and t['properties'].get('ord'))
        p = tile['properties']
        d = self.doc(p['i'])
        self.assertEqual(d['schema'], 1)
        self.assertEqual(p['v'], d['v'])
        self.assertEqual(p['r'], d['routeCount'])
        self.assertEqual(p['src'] & 3, 3)  # OpenBeta + OSM
        self.assertNotIn('a', p)  # access unknown: absent, never "open"
        self.assertEqual(d['access'], {'status': 'unknown'})
        self.assertEqual(sum(int(x) for x in p['b'].split(',')), sum(d['bands']))
        self.assertGreaterEqual(p['g1'], p['g0'])
        roles = {s['src']: s['licence'] for s in d['sources']}
        self.assertEqual(roles, {'ob': 'CC0-1.0', 'osm': 'ODbL-1.0'})
        bw = next(s for s in d['sectors'] if s['n'] == 'Black and White')
        nums = [f['properties'].get('o') for f in self.starts
                if f['properties']['c'] == p['i'] and f['properties']['n'] in {r['n'] for r in bw['routes']}]
        self.assertIn(1, nums)
        self.assertTrue(all(f['tippecanoe']['minzoom'] == 14 for f in self.starts))

    def test_links_never_mountain_project_and_fqme_first_in_quebec(self):
        crag = {'uid': 'x', 'c2c': 'https://www.camptocamp.org/waypoints/1',
                'website': 'https://www.mountainproject.com/area/1'}
        links = publish.links_for(crag, 'CA', 'Québec')
        self.assertEqual([l['src'] for l in links], ['fqme', 'c2c'])
        self.assertEqual(publish.links_for(crag, 'US', 'Vermont')[0]['src'], 'c2c')

    def test_closed_crag_code(self):
        tile = next(t for t in self.tiles if t['properties']['n'] == 'Val-Bélair')
        self.assertEqual(tile['properties']['a'], 2)
        self.assertEqual(self.doc(tile['properties']['i'])['access']['status'], 'closed')

    def test_versions_are_stable(self):
        tmp2 = tempfile.mkdtemp()
        try:
            crags = merge.assemble(ob_crags(), osm_crags(), [c2c.record(load('c2c_waypoint.json'))])
            publish.publish(crags, tmp2, 'test')
            with open(os.path.join(tmp2, 'crags.geojsonl')) as f:
                again = {json.loads(line)['properties']['i']: json.loads(line)['properties']['v'] for line in f}
            self.assertEqual(again, {t['properties']['i']: t['properties']['v'] for t in self.tiles})
        finally:
            shutil.rmtree(tmp2)

    def test_description_is_one_line(self):
        d = publish.description(self.report)
        self.assertNotIn('\n', d)
        self.assertEqual(json.loads(d)['crags'], self.report['crags'])


class Ladder(unittest.TestCase):
    def test_biggest_crag_wins_its_cell_and_everyone_is_in_by_z10(self):
        crags = [
            {'uid': 'a', 'lat': 46.0, 'lng': -74.0, 'sectors': [{'routes': [{}] * 3}]},
            {'uid': 'b', 'lat': 46.0001, 'lng': -74.0001, 'sectors': [{'routes': [{}] * 30}]},
        ]
        ladder.assign_minzoom(crags)
        self.assertEqual(crags[1]['minzoom'], ladder.LADDER_MIN)
        self.assertGreater(crags[0]['minzoom'], crags[1]['minzoom'])
        self.assertLessEqual(crags[0]['minzoom'], ladder.FULL_ZOOM)


if __name__ == '__main__':
    unittest.main()
