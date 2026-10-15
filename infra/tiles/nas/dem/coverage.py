"""Where we serve Mapterhorn: the LiDAR mask (README "DEM" section, DEM-VALIDATION.md).

Mapterhorn blends every source it has into one surface; where no LiDAR-grade
terrain model exists it fills in with Copernicus GLO-30, a *surface* model
(tree tops, roofs) that reads 10–25 m high in forests. We serve a tile only
where every pixel comes from an allow-listed terrain model (regions.json).
Two of Mapterhorn's own published files say where that is:

- `coverage-index.pmtiles`: per z12 "macrotile", the sources whose footprint
  (buffered by 1 km) touches it — a fast first cut;
- `coverage.pmtiles`: each source's footprint as vector polygons (layer
  "coverage", property "source") — the exact cut.

Per candidate macrotile the allow-listed polygons are rasterised (RASTER px a
side), minus the footprints of every *blocked* source — a fine (≤ 2.5 m)
source that is not allow-listed (pending validation): Mapterhorn takes the
finest source covering a pixel, so where a blocked one overlaps an allowed
one the pixels are the blocked one's. Each of the macrotile's 16 × 16 z16
cells (one 256-px output tile at z16 = a quadrant of a 512-px Mapterhorn
z15 tile) qualifies only if the cell grown by INSET_3857_M on every side is
fully covered. The inset covers Mapterhorn's
seam blending (macrotile_buffer_3857 = 150 m, aggregation_merge.py) and the
polygons' simplification at z12. A tile at a lower zoom qualifies when every
z16 cell under it does. Everything else is answered by the Worker from AWS
Terrarium (the app's former source), never by GLO-30.
"""
import json
import math
from collections import OrderedDict

from PIL import Image, ImageDraw

from mvt_lite import decode_layer, ring_area
from pmtiles_lite import Reader, tileid_to_zxy

MACRO_Z = 12
CELL_Z = 16
CELLS = 1 << (CELL_Z - MACRO_Z)  # 16 cells a side
FULL = (1 << (CELLS * CELLS)) - 1
RASTER = 512
CELL_PX = RASTER // CELLS
WORLD_3857 = 2 * math.pi * 6378137.0
INSET_3857_M = 200.0


def inset_px(inset_m=INSET_3857_M, raster=RASTER):
    return math.ceil(inset_m / (WORLD_3857 / 2 ** MACRO_Z / raster))


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat = max(min(lat, 85.0511287798066), -85.0511287798066)
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return min(int(x), n - 1), min(int(y), n - 1)


def tile_bounds(z, x, y):
    """(west, south, east, north) in degrees."""
    n = 2 ** z

    def lat(j):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * j / n))))

    return x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)


def macrotiles_in_bbox(bbox):
    w, s, e, n = bbox
    x0, y0 = lonlat_to_tile(w, n, MACRO_Z)
    x1, y1 = lonlat_to_tile(e, s, MACRO_Z)
    return x0, y0, x1, y1


def candidates(index_path, bbox, allowed, pad=1):
    """Macrotiles (x, y) in bbox — grown by `pad` macrotiles, the neighbours a cell's
    inset reaches into — whose coverage-index entry names an allowed source, plus
    {source id: metadata} for every source seen there (for the review log)."""
    x0, y0, x1, y1 = macrotiles_in_bbox(bbox)
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    out, seen, blobs = set(), {}, {}
    with Reader(index_path) as r:
        if r.header['max_zoom'] != MACRO_Z:
            raise ValueError(f'coverage index max zoom {r.header["max_zoom"]}, expected {MACRO_Z}')
        for tile_id, off, length in r.entries():
            z, x, y = tileid_to_zxy(tile_id)
            if z != MACRO_Z or not (x0 <= x <= x1 and y0 <= y <= y1):
                continue
            if off not in blobs:
                blobs[off] = json.loads(r.source.read(r.header['data_offset'] + off, length))
            sources = blobs[off]
            for k, v in sources.items():
                seen.setdefault(k, v)
            if any(k in allowed for k in sources):
                out.add((x, y))
    return out, seen


def _feature_layer(rings, scale, raster):
    layer = Image.new('L', (raster, raster), 0)
    draw = ImageDraw.Draw(layer)
    for ring in rings:
        if len(ring) < 3:
            continue
        pts = [(x * scale, y * scale) for x, y in ring]
        # Exterior rings have positive area in tile coordinates; holes negative.
        draw.polygon(pts, fill=255 if ring_area(ring) > 0 else 0)
    return layer


def rasterize(features, allowed, extent, raster=RASTER, blocked=frozenset()):
    """Allowed sources' polygons minus blocked sources' polygons, as an 'L'
    image (255 = served)."""
    union = Image.new('L', (raster, raster), 0)
    scale = raster / extent
    for props, rings in features:
        if props.get('source') in allowed:
            union.paste(255, mask=_feature_layer(rings, scale, raster))
    for props, rings in features:
        if props.get('source') in blocked:
            union.paste(0, mask=_feature_layer(rings, scale, raster))
    return union


def cells_of(neighbourhood, inset):
    """Bitmask of the 16 × 16 cells of the centre macrotile that are covered
    including an `inset`-pixel margin. `neighbourhood(dx, dy)` → 'L' image or None."""
    centre = neighbourhood(0, 0)
    if centre is None:
        return 0
    canvas = Image.new('L', (3 * RASTER, 3 * RASTER), 0)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            img = centre if dx == dy == 0 else neighbourhood(dx, dy)
            if img is not None:
                canvas.paste(img, ((dx + 1) * RASTER, (dy + 1) * RASTER))
    bits = 0
    for cy in range(CELLS):
        for cx in range(CELLS):
            x0 = RASTER + cx * CELL_PX - inset
            y0 = RASTER + cy * CELL_PX - inset
            box = (x0, y0, x0 + CELL_PX + 2 * inset, y0 + CELL_PX + 2 * inset)
            if canvas.crop(box).getextrema()[0] == 255:
                bits |= 1 << (cy * CELLS + cx)
    return bits


class CoverageTiles:
    """Rasterised allowed-source masks of macrotiles, read from coverage.pmtiles (LRU)."""

    def __init__(self, coverage_path, allowed, wanted, cache=2048, blocked=frozenset()):
        self.reader = Reader(coverage_path)
        if self.reader.header['max_zoom'] < MACRO_Z:
            raise ValueError('coverage.pmtiles has no z12 tiles')
        self.allowed = set(allowed)
        self.blocked = set(blocked)
        self.wanted = wanted
        self.cache = OrderedDict()
        self.size = cache
        self.missing = 0

    def mask(self, x, y):
        if (x, y) not in self.wanted:
            return None
        key = (x, y)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        data = self.reader.get(MACRO_Z, x, y)
        if data is None:
            self.missing += 1
            img = None
        else:
            extent, features = decode_layer(data, 'coverage')
            img = rasterize(features, self.allowed, extent, blocked=self.blocked)
            if img.getextrema()[1] == 0:
                img = None
        self.cache[key] = img
        if len(self.cache) > self.size:
            self.cache.popitem(last=False)
        return img


def build_cells(coverage_path, wanted, allowed, bbox=None, inset=None, progress=None,
                blocked=frozenset()):
    """{(x, y): bitmask} for every candidate macrotile (inside bbox, when given) with
    at least one qualifying cell. Candidates outside bbox only lend their coverage
    to their neighbours' insets."""
    inset = inset_px() if inset is None else inset
    tiles = CoverageTiles(coverage_path, allowed, wanted, blocked=blocked)
    if bbox is not None:
        x0, y0, x1, y1 = macrotiles_in_bbox(bbox)
        todo = [(x, y) for x, y in wanted if x0 <= x <= x1 and y0 <= y <= y1]
    else:
        todo = list(wanted)
    cells = {}
    try:
        for i, (x, y) in enumerate(sorted(todo, key=lambda t: (t[1], t[0]))):
            bits = cells_of(lambda dx, dy: tiles.mask(x + dx, y + dy), inset)
            if bits:
                cells[(x, y)] = bits
            if progress and i % 1000 == 0:
                progress(i, len(todo), len(cells))
    finally:
        tiles.reader.close()
    return cells


class Mask:
    """Which output tiles (256 px, z ≤ 16) are served from Mapterhorn."""

    def __init__(self, cells):
        self.cells = dict(cells)
        self.full = {MACRO_Z: {k for k, v in self.cells.items() if v == FULL}}
        for z in range(MACRO_Z - 1, -1, -1):
            children = self.full[z + 1]
            parents = {(x >> 1, y >> 1) for x, y in children}
            self.full[z] = {
                (px, py) for px, py in parents
                if all((2 * px + dx, 2 * py + dy) in children for dx in (0, 1) for dy in (0, 1))
            }

    def qualifies(self, z, x, y):
        if z > CELL_Z:
            return False
        if z <= MACRO_Z:
            return (x, y) in self.full[z]
        shift = CELL_Z - z
        bits = self.cells.get((x >> (z - MACRO_Z), y >> (z - MACRO_Z)))
        if not bits:
            return False
        side = 1 << shift
        cx0 = (x << shift) & (CELLS - 1)
        cy0 = (y << shift) & (CELLS - 1)
        row = ((1 << side) - 1) << cx0
        for cy in range(cy0, cy0 + side):
            if (bits >> (cy * CELLS)) & row != row:
                return False
        return True

    def count(self, z):
        """Qualifying tiles at zoom z."""
        if z <= MACRO_Z:
            return len(self.full[z])
        side = 1 << (z - MACRO_Z)
        n = 0
        for (mx, my) in self.cells:
            for j in range(side):
                for i in range(side):
                    n += self.qualifies(z, mx * side + i, my * side + j)
        return n

    def to_json(self):
        return {
            'macroZoom': MACRO_Z, 'cellZoom': CELL_Z,
            'cells': {f'{x}/{y}': format(v, 'x') for (x, y), v in sorted(self.cells.items())},
        }

    @classmethod
    def from_json(cls, d):
        if d.get('macroZoom') != MACRO_Z or d.get('cellZoom') != CELL_Z:
            raise ValueError('mask zooms differ from this code')
        cells = {}
        for k, v in d['cells'].items():
            x, y = (int(a) for a in k.split('/'))
            cells[(x, y)] = int(v, 16)
        return cls(cells)

    def bbox(self):
        """(w, s, e, n) of the macrotiles with any qualifying cell, or None."""
        if not self.cells:
            return None
        xs = [x for x, _ in self.cells]
        ys = [y for _, y in self.cells]
        w, _, _, n = tile_bounds(MACRO_Z, min(xs), min(ys))
        _, s, e, _ = tile_bounds(MACRO_Z, max(xs), max(ys))
        return [round(w, 6), round(s, 6), round(e, 6), round(n, 6)]

    def region_geojson(self):
        """The macrotiles with any qualifying cell as a MultiPolygon, one rectangle per
        run of adjacent macrotiles in a row — the area `pmtiles extract` downloads."""
        rows = {}
        for x, y in self.cells:
            rows.setdefault(y, []).append(x)
        polys = []
        for y, xs in sorted(rows.items()):
            xs.sort()
            start = prev = xs[0]
            for x in xs[1:] + [None]:
                if x is not None and x == prev + 1:
                    prev = x
                    continue
                w, s, _, n = tile_bounds(MACRO_Z, start, y)
                _, _, e, _ = tile_bounds(MACRO_Z, prev, y)
                polys.append([[[w, s], [e, s], [e, n], [w, n], [w, s]]])
                if x is not None:
                    start = prev = x
        return {'type': 'Feature', 'properties': {},
                'geometry': {'type': 'MultiPolygon', 'coordinates': polys}}
