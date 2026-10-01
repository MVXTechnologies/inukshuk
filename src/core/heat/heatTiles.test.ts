import { simplifyTrack } from '@core/geo/track/simplify';

import { largeLibrary } from './__fixtures__/quebecLibrary';
import {
  buildHeatGrid,
  CellGrid,
  gridTrailsNearWithin,
  HEAT_LINE_CELL_M,
  walkTrackCells,
  type TrackCellWalk,
} from './heatGrid';
import {
  aggregateTile,
  deriveTileRenders,
  HEAT_TILE_DEG,
  mergeGlow,
  mergeLineBuckets,
  neighbourTiles,
  parseTileKey,
  renderDirtyTiles,
  StoredTapIndex,
  tapSlots,
  tileBounds,
  tileKeyAt,
  TileGrid,
  TileMapper,
  tilesMeeting,
  tileTap,
  trackContributions,
  type TileKey,
} from './heatTiles';

const grid = new CellGrid(HEAT_LINE_CELL_M);
const lib = largeLibrary(24, { stepSec: 10 });
const walks: TrackCellWalk[] = lib.tracks.map((t, i) =>
  walkTrackCells(
    { id: t.id, parts: simplifyTrack(lib.points(i), lib.segmentStarts(i)).parts },
    grid,
  ),
);

/** A store-like tile set, filled by adding/removing slots (the store's model). */
class Tiles {
  readonly tiles = new Map<TileKey, TileGrid>();
  readonly mapper = new TileMapper(grid);
  add(slot: number, walk: TrackCellWalk) {
    for (const [k, c] of trackContributions(walk, this.mapper)) {
      let t = this.tiles.get(k);
      if (!t) {
        t = new TileGrid();
        this.tiles.set(k, t);
      }
      t.slots.set(slot, c);
    }
  }
  remove(slot: number) {
    for (const [k, t] of this.tiles) {
      t.slots.delete(slot);
      if (t.slots.size === 0) this.tiles.delete(k);
    }
  }
  aggregates() {
    return new Map([...this.tiles].map(([k, t]) => [k, aggregateTile(t, grid)]));
  }
  renders() {
    const aggs = this.aggregates();
    return deriveTileRenders(grid, aggs, [...aggs.keys()].sort());
  }
}

const sortedEntries = <K, V>(m: Map<K, V>) =>
  [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe('tile keys', () => {
  it('maps a point to the tile that contains it', () => {
    const k = tileKeyAt(-71.2, 46.81);
    const b = tileBounds(k);
    expect(b.minLng).toBeLessThanOrEqual(-71.2);
    expect(b.maxLng).toBeGreaterThan(-71.2);
    expect(b.minLat).toBeLessThanOrEqual(46.81);
    expect(b.maxLat).toBeGreaterThan(46.81);
    expect(b.maxLng - b.minLng).toBeCloseTo(HEAT_TILE_DEG);
  });

  it('wraps at the antimeridian and clamps at the poles', () => {
    expect(tileKeyAt(180, 0)).toBe(tileKeyAt(-180, 0));
    expect(parseTileKey(tileKeyAt(0, 90))!.y).toBe(180 * 32 - 1);
    const west = tileKeyAt(-179.99, 0);
    expect(neighbourTiles(west)).toContain(tileKeyAt(179.99, 0));
    expect(neighbourTiles(tileKeyAt(0, -89.99))).toHaveLength(5);
  });

  it('rejects what is not a tile key', () => {
    expect(parseTileKey('nope')).toBeNull();
    expect(parseTileKey('99999_1')).toBeNull();
    expect(neighbourTiles('x')).toEqual([]);
    expect(Number.isNaN(tileBounds('x').minLat)).toBe(true);
  });

  it('selects only the stored tiles that meet a box (antimeridian included)', () => {
    const here = tileKeyAt(-71.2, 46.81);
    const far = tileKeyAt(-73.6, 45.5);
    const dateline = tileKeyAt(179.99, 10);
    const keys = [here, far, dateline];
    expect(
      tilesMeeting(keys, { minLng: -71.3, maxLng: -71.1, minLat: 46.7, maxLat: 46.9 }),
    ).toEqual([here]);
    expect(tilesMeeting(keys, { minLng: 179.9, maxLng: -179.9, minLat: 9, maxLat: 11 })).toEqual([
      dateline,
    ]);
    expect(tilesMeeting(keys, null)).toEqual(keys);
  });
});

describe('one trail split into tiles', () => {
  it('keeps every cell exactly once, with its steps, inside the cell', () => {
    const mapper = new TileMapper(grid);
    const walk = walks[0]!;
    const parts = trackContributions(walk, mapper);
    const cells: number[] = [];
    for (const [k, c] of parts) {
      for (let i = 0; i < c.cells.length; i++) {
        const cell = c.cells[i]!;
        cells.push(cell);
        expect(mapper.tileOf(cell)).toBe(k);
        // Mean position within ~ half a cell of the centre (in 1e-5° units).
        expect(Math.abs(c.dy[i]!)).toBeLessThanOrEqual(12);
      }
    }
    expect(cells.sort((a, b) => a - b)).toEqual([...walk.cells].sort((a, b) => a - b));
    // Its edges come back from the tiles.
    const t = new Tiles();
    t.add(0, walk);
    const edges = new Set<string>();
    for (const agg of t.aggregates().values()) for (const e of agg.edgeCounts.keys()) edges.add(e);
    expect([...edges].sort()).toEqual([...walk.edges].sort());
  });

  it('stores a step that is not a ring neighbour as an extra pair', () => {
    const walk: TrackCellWalk = {
      cells: new Set([grid.key(-71.2, 46.81), grid.key(-71.19, 46.81)]),
      edges: new Set(),
      sums: new Map(),
    };
    const [a, b] = [...walk.cells].sort((x, y) => x - y) as [number, number];
    walk.edges.add(`${a}:${b}`);
    const [c] = [...trackContributions(walk, new TileMapper(grid)).values()];
    expect([...c!.extra]).toEqual([a, b]);
    expect([...c!.mask]).toEqual([0, 0]);
    const tile = new TileGrid();
    tile.slots.set(0, c!);
    expect([...aggregateTile(tile, grid).edgeCounts.keys()]).toEqual([`${a}:${b}`]);
  });
});

describe('tiled heat', () => {
  it('counts exactly what the whole-library grid counts', () => {
    const t = new Tiles();
    walks.forEach((w, i) => t.add(i, w));
    const whole = buildHeatGrid(walks, grid);
    const cellCounts = new Map<number, number>();
    const edges = new Map<string, number>();
    for (const agg of t.aggregates().values()) {
      for (const [c, n] of agg.cellCounts) cellCounts.set(c, n);
      for (const [e, n] of agg.edgeCounts) edges.set(e, n);
    }
    expect(sortedEntries(cellCounts)).toEqual(sortedEntries(whole.cellCounts));
    expect(sortedEntries(edges)).toEqual(sortedEntries(whole.edgeCounts));
  });

  it('incremental adds in any order equal a full rebuild', () => {
    const full = new Tiles();
    walks.forEach((w, i) => full.add(i, w));
    const incremental = new Tiles();
    // Reverse order, different slot numbers, with an extra trail in and out.
    incremental.add(999, walks[3]!);
    [...walks].reverse().forEach((w, i) => incremental.add(100 + i, w));
    incremental.remove(999);
    expect(sortedEntries(incremental.renders())).toEqual(sortedEntries(full.renders()));
  });

  it('removing a trail reverses adding it', () => {
    const base = new Tiles();
    walks.slice(0, 12).forEach((w, i) => base.add(i, w));
    const before = sortedEntries(base.renders());
    const beforeAggs = sortedEntries(base.aggregates());
    base.add(50, walks[20]!);
    expect(sortedEntries(base.renders())).not.toEqual(before);
    base.remove(50);
    expect(sortedEntries(base.renders())).toEqual(before);
    expect(sortedEntries(base.aggregates())).toEqual(beforeAggs);
  });

  it('re-deriving only the render-dirty tiles equals re-deriving everything', () => {
    const t = new Tiles();
    walks.slice(0, 16).forEach((w, i) => t.add(i, w));
    const renders = t.renders();
    for (const [slot, w] of [
      [16, walks[16]!],
      [17, walks[17]!],
    ] as const) {
      t.add(slot, w);
      const dirty = renderDirtyTiles(w.cells, t.mapper);
      const aggs = t.aggregates();
      const partial = deriveTileRenders(
        grid,
        new Map(
          [...aggs].filter(([k]) => dirty.has(k) || neighbourTiles(k).some((n) => dirty.has(n))),
        ),
        [...dirty],
      );
      for (const [k, r] of partial) renders.set(k, r);
    }
    expect(sortedEntries(renders)).toEqual(sortedEntries(t.renders()));
  });

  it('draws pass-count lines and glow per tile', () => {
    const t = new Tiles();
    walks.forEach((w, i) => t.add(i, w));
    const renders = [...t.renders().values()];
    const lines = mergeLineBuckets(renders.map((r) => r.lines));
    const glow = mergeGlow(renders.map((r) => r.glow));
    const counts = lines.features.map((f) => f.properties.count);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBe(counts.length);
    expect(lines.features.length).toBeGreaterThan(1);
    expect(glow.features.length).toBeGreaterThan(0);
    expect(Math.max(...glow.features.map((f) => f.properties.count))).toBeGreaterThan(1);
  });

  it('skips empty tiles and tiles with no aggregate', () => {
    const empty = aggregateTile(new TileGrid(), grid);
    expect(deriveTileRenders(grid, new Map([['1_1', empty]]), ['1_1', '2_2']).size).toBe(0);
  });
});

describe('render-dirty tiles', () => {
  const mapper = new TileMapper(grid);
  it('is only the own tile for a cell well inside it', () => {
    const b = tileBounds(tileKeyAt(-71.2, 46.81));
    const mid = grid.key((b.minLng + b.maxLng) / 2, (b.minLat + b.maxLat) / 2);
    expect([...renderDirtyTiles([mid], mapper)]).toEqual([mapper.tileOf(mid)]);
  });
  it('reaches the neighbour for a cell at the tile edge', () => {
    const b = tileBounds(tileKeyAt(-71.2, 46.81));
    const edge = grid.key(b.maxLng - 1e-5, (b.minLat + b.maxLat) / 2);
    const dirty = renderDirtyTiles([edge], mapper);
    expect(dirty.size).toBe(2);
    expect(dirty.has(tileKeyAt(b.maxLng + 1e-5, (b.minLat + b.maxLat) / 2))).toBe(true);
  });
});

describe('tap lookup from stored tiles', () => {
  const t = new Tiles();
  walks.forEach((w, i) => t.add(i, w));
  const taps = new Map([...t.tiles].map(([k, tile]) => [k, tileTap(tile)]));
  const resolve = (slot: number) => {
    const tr = lib.tracks[slot];
    return tr ? { id: tr.id, categoryId: tr.category ?? 'uncategorized' } : null;
  };
  const index = new StoredTapIndex(t.mapper, taps, resolve);

  it('finds the slots through a cell', () => {
    const cell = [...walks[0]!.cells][5]!;
    const tap = taps.get(t.mapper.tileOf(cell))!;
    expect([...tapSlots(tap, cell)]).toContain(0);
    expect(tapSlots(tap, cell + 0.5)).toHaveLength(0);
  });

  it('answers hot spots like the in-memory index does', () => {
    // Home: every favourite route starts there.
    const hit = gridTrailsNearWithin(index, grid, -71.2, 46.81, 60);
    expect(hit.hot).toBe(true);
    expect(hit.trackIds.length).toBeGreaterThan(2);
    // A re-categorized trail is grouped by its live category.
    const lonely = new StoredTapIndex(t.mapper, taps, (slot) =>
      slot === 0 ? { id: 'x', categoryId: 'only-me' } : null,
    );
    const cell = [...walks[0]!.cells][5]!;
    expect(lonely.get(cell)).toEqual(new Map([['only-me', ['x']]]));
    expect(lonely.get(grid.key(10, 10))).toBeUndefined();
    const nobody = new StoredTapIndex(t.mapper, taps, () => null);
    expect(nobody.get(cell)).toBeUndefined();
  });
});
