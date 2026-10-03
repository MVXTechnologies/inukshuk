"""Tests for peaks_geojson.py:  python3 -m unittest infra/tiles/nas/test_peaks_geojson.py"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from peaks_geojson import (  # noqa: E402
    CELL_KEEP,
    CELL_ZOOM_SHIFT,
    MAX_ZOOM,
    PEAK_MAX_LEAD,
    apply_density,
    cell_of,
    convert,
    dense_rank,
    density_zooms,
    feature,
    minzoom_for,
    parse_ele,
    query_for,
    split4,
    tile_minzoom,
)


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
                # Rank z10 on the ladder, tiled PEAK_MAX_LEAD (2) zooms earlier.
                'tippecanoe': {'minzoom': 8},
                'properties': {'name': 'Mont Sainte-Anne', 'kind': 'peak', 'ele': 808, 'rank': 10},
                'geometry': {'type': 'Point', 'coordinates': [-70.932024, 47.087437]},
            },
        )

    def test_rounds_ele_and_keeps_only_differing_translations(self):
        f = feature(node(1, natural='volcano', name='Fuji', ele='3776.24', **{'name:en': 'Mount Fuji', 'name:fr': 'Fuji'}))
        self.assertEqual(f['properties'], {'name': 'Fuji', 'kind': 'volcano', 'ele': 3776, 'name:en': 'Mount Fuji', 'rank': 6})
        # Never before the tileset's own minzoom.
        self.assertEqual(f['tippecanoe'], {'minzoom': 5})

    def test_zero_or_bad_ele_is_dropped(self):
        for ele in ['0', 'high']:
            f = feature(node(1, natural='peak', name='X', ele=ele))
            self.assertNotIn('ele', f['properties'])
            self.assertEqual(f['properties']['rank'], 12)
            self.assertEqual(f['tippecanoe'], {'minzoom': 10})

    def test_unusable_elements(self):
        self.assertIsNone(feature(node(1, natural='peak')))
        self.assertIsNone(feature(node(1, natural='peak', name='  ')))
        self.assertIsNone(feature(node(1, natural='saddle', name='Col')))
        self.assertIsNone(feature({'id': 1, 'tags': {'natural': 'peak', 'name': 'X'}}))


class TileMinzoom(unittest.TestCase):
    def test_leads_the_rank_by_the_max_lead(self):
        self.assertEqual(PEAK_MAX_LEAD, 2)  # = PEAK_MAX_LEAD in src/core/map/terrainOptions.ts
        self.assertEqual(tile_minzoom(12), 10)
        self.assertEqual(tile_minzoom(10), 8)
        self.assertEqual(tile_minzoom(7), 5)
        self.assertEqual(tile_minzoom(5), 5)


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


class Density(unittest.TestCase):
    """A crowded range hands the map no more summits than its labels have room for."""

    @staticmethod
    def massif(n, lon=7.75, lat=46.02, span=0.2):
        """n summits of 3000–3999 m (all ladder rank 6) scattered over `span` degrees."""
        out = []
        for i in range(n):
            # A fixed scatter (golden-ratio sequence): no randomness in tests.
            out.append((lon + span * ((i * 0.6180339887) % 1), lat + span * ((i * 0.7548776662) % 1), 6, 3000 + (i * 37) % 1000))
        return out

    def test_cell_of_matches_the_tile_grid(self):
        self.assertEqual(cell_of(0, 0, 1), (1, 1))
        self.assertEqual(cell_of(-180, 85, 2), (0, 0))
        self.assertEqual(cell_of(179.999, -85, 2), (3, 3))
        # Zermatt's z12 tile.
        self.assertEqual(cell_of(7.7491, 46.0207, 12), (2136, 1456))
        # Past the mercator limit: clamped, never out of range.
        self.assertEqual(cell_of(10, 89.9, 3)[1], 0)

    def test_a_lone_summit_keeps_its_ladder_rank(self):
        zooms = density_zooms([(-70.93, 47.08, 10, 808)])
        self.assertEqual(zooms, [0])
        self.assertEqual(dense_rank(10, zooms[0]), 10)

    def test_a_sparse_region_is_unchanged(self):
        # CELL_KEEP summits side by side: each among the best of its cell at once.
        summits = [(-70.9 + i * 0.001, 47.0, 10, 800 + i) for i in range(CELL_KEEP)]
        self.assertEqual([dense_rank(10, z) for z in density_zooms(summits)], [10] * CELL_KEEP)

    def test_a_crowded_cell_keeps_its_best_and_holds_the_rest_back(self):
        summits = self.massif(400)
        zooms = density_zooms(summits)
        ranks = [dense_rank(s[2], z) for s, z in zip(summits, zooms)]
        # Every summit still gets in by the tiles' last zoom.
        self.assertTrue(all(6 <= r <= MAX_ZOOM for r in ranks))
        self.assertLess(sum(1 for r in ranks if r == 6), 100)
        # At any zoom, at the widest lead, no cell hands the map more than CELL_KEEP.
        for zoom in range(5, MAX_ZOOM - PEAK_MAX_LEAD):
            per_cell = {}
            for s, r in zip(summits, ranks):
                if zoom >= r - PEAK_MAX_LEAD:
                    cell = cell_of(s[0], s[1], zoom + CELL_ZOOM_SHIFT)
                    per_cell[cell] = per_cell.get(cell, 0) + 1
            self.assertLessEqual(max(per_cell.values()), CELL_KEEP, zoom)
        # The highest summits are the ones that come first.
        best = sorted(range(400), key=lambda i: -summits[i][3])[:3]
        self.assertTrue(all(zooms[i] == min(zooms) for i in best))

    def test_a_summit_once_in_stays_in(self):
        summits = self.massif(300)
        zooms = density_zooms(summits)
        for zoom in range(0, MAX_ZOOM):
            order = sorted(range(300), key=lambda i: (summits[i][2], -summits[i][3], i))
            seen = {}
            for i in order:
                cell = cell_of(summits[i][0], summits[i][1], zoom + CELL_ZOOM_SHIFT)
                seen[cell] = seen.get(cell, 0) + 1
                if zooms[i] <= zoom:
                    self.assertLessEqual(seen[cell], CELL_KEEP)

    def test_a_better_ladder_rank_beats_height(self):
        # A prominent 2900 m summit (promoted to rank 6) among 3000ers of rank 7.
        summits = [(7.75 + i * 1e-4, 46.02, 7, 3000 + i) for i in range(CELL_KEEP + 3)]
        summits.append((7.7501, 46.0201, 6, 2900))
        zooms = density_zooms(summits)
        self.assertEqual(zooms[-1], min(zooms))

    def test_unknown_heights_rank_last_and_ties_keep_input_order(self):
        summits = [(7.75, 46.02, 12, None)] * (CELL_KEEP + 2)
        zooms = density_zooms(summits)
        self.assertEqual(zooms[:CELL_KEEP], [0] * CELL_KEEP)
        self.assertGreater(zooms[CELL_KEEP], 0)

    def test_dense_rank_never_precedes_the_ladder_nor_exceeds_the_last_zoom(self):
        self.assertEqual(dense_rank(6, 0), 6)
        self.assertEqual(dense_rank(6, 7), 9)  # in from z7 at lead 2
        self.assertEqual(dense_rank(6, MAX_ZOOM), MAX_ZOOM)
        self.assertEqual(dense_rank(12, 3), 12)

    def test_apply_density_rewrites_rank_and_tile_minzoom(self):
        features = [
            feature(node(i, natural='peak', name=f'P{i}', ele=str(3000 + i), lat=46.02 + i * 1e-5, lon=7.75))
            for i in range(CELL_KEEP + 4)
        ]
        apply_density(features)
        ranks = [f['properties']['rank'] for f in features]
        # The CELL_KEEP highest keep the ladder's rank 6; the others wait.
        self.assertEqual(sorted(ranks)[:CELL_KEEP], [6] * CELL_KEEP)
        self.assertEqual(ranks[-CELL_KEEP:], [6] * CELL_KEEP)
        self.assertTrue(all(r > 6 for r in ranks[:4]))
        for f in features:
            self.assertEqual(f['tippecanoe'], {'minzoom': tile_minzoom(f['properties']['rank'])})

    def test_empty(self):
        self.assertEqual(density_zooms([]), [])
        self.assertEqual(apply_density([]), [])


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
