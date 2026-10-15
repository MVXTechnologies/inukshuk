"""Tests for the DEM pipeline:  python3 -m unittest discover -s infra/tiles/nas/dem -p 'test_*.py'

Needs Pillow (the pipeline image, ./Dockerfile, has it; dem.sh runs these first).
Fixtures: ./fixtures (make_fixtures.py says how they were made).
"""
import io
import json
import os
import random
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from PIL import Image  # noqa: E402

import coverage  # noqa: E402
import credits  # noqa: E402
import dem  # noqa: E402
import transcode  # noqa: E402
from coverage import CELLS, FULL, Mask  # noqa: E402
from mvt_lite import decode_layer, decode_rings, ring_area  # noqa: E402
from pmtiles_lite import Reader, tileid_to_zxy, zxy_to_tileid  # noqa: E402

FIX = os.path.join(HERE, 'fixtures')
INDEX = os.path.join(FIX, 'coverage-index-edge.pmtiles')
COVER = os.path.join(FIX, 'coverage-edge.pmtiles')
WEBP = os.path.join(FIX, 'webp-sample.pmtiles')


def terrarium(h):
    v = round((h + 32768) * 256)
    return v >> 16, (v >> 8) & 255, v & 255


def webp512(seed=1, alpha_hole=False):
    rng = random.Random(seed)
    img = Image.new('RGBA' if alpha_hole else 'RGB', (512, 512))
    raw = bytearray()
    for j in range(512):
        for i in range(512):
            h = 800 + 40 * ((i * 7 + j * 3) % 97) / 97 + rng.randint(-32768, 32767) / 256
            raw += bytes(terrarium(h)) + (b'\xff' if alpha_hole else b'')
    img.frombytes(bytes(raw))
    if alpha_hole:
        img.putpixel((300, 10), (1, 2, 3, 0))
    out = io.BytesIO()
    img.save(out, 'WEBP', lossless=True, quality=100)
    return out.getvalue(), img


class TileIds(unittest.TestCase):
    def test_spec_values(self):
        # PMTiles v3 spec: z0 → 0, then z1 in Hilbert order, z2 starts at 5.
        self.assertEqual(zxy_to_tileid(0, 0, 0), 0)
        self.assertEqual([zxy_to_tileid(1, *xy) for xy in ((0, 0), (0, 1), (1, 1), (1, 0))],
                         [1, 2, 3, 4])
        self.assertEqual(zxy_to_tileid(2, 0, 0), 5)

    def test_round_trip(self):
        for t in list(range(0, 2000)) + [zxy_to_tileid(16, 19860, 23030)]:
            self.assertEqual(zxy_to_tileid(*tileid_to_zxy(t)), t)
        with self.assertRaises(ValueError):
            zxy_to_tileid(3, 8, 0)


class PMTilesReader(unittest.TestCase):
    def test_reads_the_coverage_index_cut(self):
        with Reader(INDEX) as r:
            self.assertEqual((r.header['min_zoom'], r.header['max_zoom']), (4, 12))
            d = json.loads(r.get(12, 1227, 1411))
            self.assertIn('cahrdem2', d)
            self.assertEqual(d['cahrdem2']['resolution'], 2)
            self.assertIsNone(r.get(12, 0, 0))
            ids = [t for t, _, _ in r.entries()]
            self.assertEqual(ids, sorted(ids))

    def test_reads_webp_tiles(self):
        with Reader(WEBP) as r:
            self.assertEqual(r.header['tile_type'], 'webp')
            tiles = {(z, x, y) for z, x, y, _ in r.tiles()}
            self.assertEqual(tiles, {(15, 9816, 11288), (15, 9817, 11288), (14, 4908, 5644)})


class Mvt(unittest.TestCase):
    def test_rings_and_area(self):
        # MoveTo(0,0) LineTo(10,0)(10,10)(0,10) ClosePath, zigzag-encoded.
        geom = [9, 0, 0, 26, 20, 0, 0, 20, 19, 0, 15]
        rings = decode_rings(geom)
        self.assertEqual(rings, [[(0, 0), (10, 0), (10, 10), (0, 10)]])
        self.assertEqual(ring_area(rings[0]), 100)

    def test_coverage_tile(self):
        with Reader(COVER) as r:
            extent, feats = decode_layer(r.get(12, 1227, 1411), 'coverage')
        self.assertEqual(extent, 4096)
        by = {p['source']: rings for p, rings in feats}
        self.assertEqual(set(by), {'glo30', 'cahrdem2'})
        frac = sum(ring_area(q) for q in by['cahrdem2']) / 4096 ** 2
        self.assertTrue(0.3 < frac < 0.7, frac)


class CoverageMask(unittest.TestCase):
    def test_full_polygon_rasterizes_full(self):
        ring = [(-64, -64), (4160, -64), (4160, 4160), (-64, 4160)]
        img = coverage.rasterize([({'source': 'a'}, [ring])], {'a'}, 4096)
        self.assertEqual(img.getextrema(), (255, 255))
        empty = coverage.rasterize([({'source': 'b'}, [ring])], {'a'}, 4096)
        self.assertEqual(empty.getextrema(), (0, 0))

    def test_blocked_sources_are_carved_out(self):
        full = [(0, 0), (4096, 0), (4096, 4096), (0, 4096)]
        left = [(0, 0), (2048, 0), (2048, 4096), (0, 4096)]
        feats = [({'source': 'a'}, [full]), ({'source': 'fine'}, [left])]
        img = coverage.rasterize(feats, {'a'}, 4096, blocked={'fine'})
        self.assertEqual(img.getpixel((10, 10)), 0)
        self.assertEqual(img.getpixel((500, 10)), 255)

    def test_hole_is_not_covered(self):
        outer = [(0, 0), (4096, 0), (4096, 4096), (0, 4096)]
        hole = [(1024, 1024), (1024, 3072), (3072, 3072), (3072, 1024)]  # negative area
        self.assertLess(ring_area(hole), 0)
        img = coverage.rasterize([({'source': 'a'}, [outer, hole])], {'a'}, 4096)
        self.assertEqual(img.getpixel((256, 256)), 0)
        self.assertEqual(img.getpixel((10, 10)), 255)

    def test_inset_drops_cells_next_to_uncovered_neighbours(self):
        full = Image.new('L', (coverage.RASTER, coverage.RASTER), 255)
        everywhere = coverage.cells_of(lambda dx, dy: full, coverage.inset_px())
        self.assertEqual(everywhere, FULL)
        alone = coverage.cells_of(lambda dx, dy: full if dx == dy == 0 else None,
                                  coverage.inset_px())
        # Only the 14 × 14 cells away from the edges survive a 200 m inset.
        self.assertEqual(bin(alone).count('1'), (CELLS - 2) ** 2)
        self.assertEqual(coverage.cells_of(lambda dx, dy: full, 0), FULL)

    def test_edge_fixture_end_to_end(self):
        wanted, seen = coverage.candidates(INDEX, [-72.2, 48.66, -72.02, 48.78], {'cahrdem2'})
        self.assertIn('glo30', seen)
        cells = coverage.build_cells(COVER, wanted, {'cahrdem2'}, bbox=[-72.2, 48.66, -72.02, 48.78])
        edge = cells[(1227, 1411)]
        self.assertTrue(0 < bin(edge).count('1') < 256)
        # Nothing qualifies where GLO-30 alone is.
        self.assertFalse(coverage.build_cells(COVER, wanted, {'glo30-not-allowed'}))

    def test_mask_zooms(self):
        m = Mask({(10, 20): FULL, (11, 20): FULL, (10, 21): FULL, (11, 21): FULL, (12, 20): 1})
        self.assertTrue(m.qualifies(11, 5, 10))  # all four children full
        self.assertTrue(m.qualifies(12, 10, 20))
        self.assertFalse(m.qualifies(12, 12, 20))
        self.assertTrue(m.qualifies(16, 12 * 16, 20 * 16))  # bit 0
        self.assertFalse(m.qualifies(16, 12 * 16 + 1, 20 * 16))
        self.assertFalse(m.qualifies(13, 24, 40))
        self.assertFalse(m.qualifies(17, 0, 0))
        self.assertEqual(m.count(16), 4 * 256 + 1)
        back = Mask.from_json(json.loads(json.dumps(m.to_json())))
        self.assertEqual(back.cells, m.cells)

    def test_region_geojson_merges_runs(self):
        m = Mask({(1, 5): 1, (2, 5): 1, (3, 5): 1, (7, 5): 1, (2, 6): 1})
        polys = m.region_geojson()['geometry']['coordinates']
        self.assertEqual(len(polys), 3)


class Transcode(unittest.TestCase):
    def test_quadrants_are_bit_exact(self):
        data, img = webp512()
        outs = transcode.quadrants(15, 100, 200, data, lambda z, x, y: True)
        self.assertEqual([(z, x, y) for z, x, y, _, _ in outs],
                         [(16, 200, 400), (16, 201, 400), (16, 200, 401), (16, 201, 401)])
        for z, x, y, png, _ in outs:
            dx, dy = x - 200, y - 400
            want = img.crop((dx * 256, dy * 256, dx * 256 + 256, dy * 256 + 256)).tobytes()
            got = Image.open(io.BytesIO(png))
            self.assertEqual(got.format, 'PNG')
            self.assertEqual(got.mode, 'RGB')
            self.assertEqual(got.tobytes(), want)

    def test_only_wanted_quadrants(self):
        data, _ = webp512()
        outs = transcode.quadrants(15, 100, 200, data, lambda z, x, y: (x, y) == (201, 401))
        self.assertEqual([(x, y) for _, x, y, _, _ in outs], [(201, 401)])
        self.assertEqual(transcode.quadrants(15, 1, 1, b'not read', lambda *a: False), [])

    def test_transparent_tiles_are_skipped(self):
        data, _ = webp512(alpha_hole=True)
        self.assertEqual(transcode.quadrants(15, 1, 1, data, lambda *a: True), [])

    def test_refuses_other_sizes_and_formats(self):
        out = io.BytesIO()
        Image.new('RGB', (256, 256)).save(out, 'WEBP', lossless=True)
        with self.assertRaises(transcode.TranscodeError):
            transcode.decode_webp(out.getvalue())
        out = io.BytesIO()
        Image.new('RGB', (512, 512)).save(out, 'PNG')
        with self.assertRaises(transcode.TranscodeError):
            transcode.decode_webp(out.getvalue())

    def test_run_resumes_and_verifies(self):
        mask = Mask({(1227, 1411): FULL}).to_json()
        mask['bbox'] = [-72.16, 48.69, -72.07, 48.75]
        with tempfile.TemporaryDirectory() as tmp:
            mb = os.path.join(tmp, 'x.mbtiles')
            meta = {'name': 'x', 'format': 'png'}
            n = transcode.run(mask, [WEBP], mb, meta, jobs=2, log=lambda m: None)
            # Two z15 tiles → 8 z16 quadrants; the z14 tile has a transparent pixel
            # (skipped, but done: a rerun reads none of the three again).
            self.assertEqual(n, 8)
            logs = []
            self.assertEqual(transcode.run(mask, [WEBP], mb, meta, jobs=1, log=logs.append), 8)
            self.assertTrue(any('resuming: 3' in m for m in logs))
            db = sqlite3.connect(mb)
            rows = db.execute('SELECT zoom_level, tile_column, tile_row FROM tiles').fetchall()
            db.close()
            self.assertTrue(all(z == 16 for z, _, _ in rows))
            # MBTiles rows count from the south.
            self.assertIn((16, 2 * 9816, (1 << 16) - 1 - 2 * 11288), rows)
            # Another mask (cell 0 dropped): nothing "done" carries over.
            other = Mask({(1227, 1411): FULL - 1}).to_json()
            logs.clear()
            self.assertEqual(transcode.run(other, [WEBP], mb, meta, jobs=1, log=logs.append), 7)
            self.assertTrue(any('starting over' in m for m in logs))


class Verify(unittest.TestCase):
    def _pmtiles_and_mbtiles(self, tmp, tamper=False):
        """png-sample.pmtiles (`pmtiles convert` of a transcode run, make_fixtures.py)
        and the MBTiles it came from, rebuilt from its tiles."""
        pm = os.path.join(FIX, 'png-sample.pmtiles')
        mask = Mask({(1227, 1411): FULL}).to_json()
        mask['bbox'] = [-72.16, 48.69, -72.07, 48.75]
        mb = os.path.join(tmp, 'x.mbtiles')
        db = transcode.open_mbtiles(mb, {'name': 'x', 'format': 'png'})
        with Reader(pm) as r:
            for z, x, y, data in r.tiles():
                row = transcode.tms_row(z, y)
                db.execute('INSERT INTO tiles VALUES (?, ?, ?, ?)', (z, x, row, data))
                db.execute('INSERT INTO pixels VALUES (?, ?, ?, ?)',
                           (z, x, row, '0' * 64 if tamper else dem.pixel_sha(data)))
        db.commit()
        db.close()
        return mb, pm, mask

    def test_verify_accepts_a_faithful_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            mb, pm, mask = self._pmtiles_and_mbtiles(tmp)
            result = dem.verify(mb, pm, mask)
            self.assertEqual(result['tiles'], 8)

    def test_verify_catches_a_tile_outside_the_mask(self):
        with tempfile.TemporaryDirectory() as tmp:
            mb, pm, _ = self._pmtiles_and_mbtiles(tmp)
            elsewhere = Mask({(1, 1): FULL}).to_json()
            with self.assertRaises(SystemExit):
                dem.verify(mb, pm, elsewhere)

    def test_verify_catches_pixel_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            mb, pm, mask = self._pmtiles_and_mbtiles(tmp, tamper=True)
            with self.assertRaises(SystemExit):
                dem.verify(mb, pm, mask)


class PlanIndexCredits(unittest.TestCase):
    def test_plan_picks_planet_and_overlapping_hi_res_archives(self):
        urls = {'items': [
            {'name': 'planet.pmtiles', 'url': 'u/planet', 'min_lon': -180, 'min_lat': -85,
             'max_lon': 180, 'max_lat': 85, 'min_zoom': 0, 'max_zoom': 12},
            {'name': '6-19-22.pmtiles', 'url': 'u/a', 'min_lon': -73.2, 'min_lat': 45.1,
             'max_lon': -67.5, 'max_lat': 48.9, 'min_zoom': 13, 'max_zoom': 16},
            {'name': '6-19-21.pmtiles', 'url': 'u/b', 'min_lon': -73.2, 'min_lat': 48.9,
             'max_lon': -67.5, 'max_lat': 52.4, 'min_zoom': 13, 'max_zoom': 13},
            {'name': '6-0-0.pmtiles', 'url': 'u/c', 'min_lon': 0, 'min_lat': 0,
             'max_lon': 5, 'max_lat': 5, 'min_zoom': 13, 'max_zoom': 15},
        ]}
        geo = Mask({(1241, 1439): 1}).region_geojson()
        self.assertEqual(dem.plan(urls, geo), [('u/planet', 0, 12), ('u/a', 13, 15)])

    def test_index_refuses_empty_or_duplicate_pieces(self):
        m = {'name': 'dem-quebec', 'bbox': [1, 2, 3, 4], 'minzoom': 12, 'maxzoom': 16,
             'bytes': 10, 'sha256': 'ab', 'tiles': 3, 'sources': ['cahrdem2']}
        idx = dem.make_index([m], '0.0.13', 'now')
        self.assertEqual(idx['pieces'][0]['name'], 'dem-quebec')
        with self.assertRaises(SystemExit):
            dem.make_index([{**m, 'tiles': 0}], 'v', 'now')
        with self.assertRaises(SystemExit):
            dem.make_index([m, m], 'v', 'now')

    def test_credits_cover_every_served_source(self):
        conf, _ = dem.load_regions()
        attribution = [{'source': sid, 'name': f'Model {sid}', 'producer': f"Agency {sid}'s",
                        'license': 'CC BY 4.0', 'website': 'https://x', 'license_pdf': 'https://y'}
                       for sid, _ in credits.served_sources(conf)]
        ts = credits.render_ts(conf, attribution)
        self.assertEqual(credits.check_ts(conf, ts), [])
        self.assertIn('Open Government Licence – Canada', ts)
        self.assertIn('DEM_CREDITS_LINE', ts)
        self.assertEqual(credits.check_ts(conf, ts.replace("id: 'cahrdem2'", '')), ['cahrdem2'])

    def test_ts_string_escaping(self):
        self.assertEqual(credits._ts("Valle d'Aosta"), '"Valle d\'Aosta"')
        self.assertEqual(credits._ts('plain'), "'plain'")


if __name__ == '__main__':
    unittest.main()
