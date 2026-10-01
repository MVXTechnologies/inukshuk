import {
  buildGridIndex,
  buildHeatGrid,
  CellGrid,
  gridTrailsNear,
  gridTrailsNearWithin,
  HEAT_LINE_CELL_M,
  HeatGridAccumulator,
  HeatGridSync,
  heatGlowPoints,
  heatGridLines,
  MAX_BRIDGE_M,
  MAX_GRID_TAP_RADIUS_M,
  passBucket,
  walkTrackCells,
  type GridTrackInput,
} from './heatGrid';

const LAT = 46.81;
const M_LNG = 111_320 * Math.cos((LAT * Math.PI) / 180);
/** [lng, lat] of a point x metres east, y metres north of a Québec origin. */
const at = (xM: number, yM: number): [number, number] => [-71.2 + xM / M_LNG, LAT + yM / 111_320];
const grid = new CellGrid(HEAT_LINE_CELL_M);

/** A straight trail east from x0 to x1 at y (sparse vertices, like simplified geometry). */
const street = (id: string, y = 0, x0 = 0, x1 = 2000, every = 250): GridTrackInput => {
  const part: [number, number][] = [];
  for (let x = x0; x <= x1; x += every) part.push(at(x, y));
  return { id, parts: [part] };
};

describe('CellGrid', () => {
  it('round-trips keys and rejects silly sizes', () => {
    const k = grid.key(...at(0, 0));
    const { row, col } = CellGrid.unkey(k);
    expect(Number.isInteger(row) && Number.isInteger(col)).toBe(true);
    expect(() => new CellGrid(0)).toThrow(RangeError);
    expect(() => new CellGrid(Number.NaN)).toThrow(RangeError);
  });

  it('isNeighbour agrees with ring()', () => {
    const c = grid.key(...at(0, 0));
    const ring = grid.ring(c);
    expect(ring).toHaveLength(9);
    for (const k of ring) expect(grid.isNeighbour(c, k)).toBe(true);
    const far = grid.key(...at(100, 0));
    expect(grid.isNeighbour(c, far)).toBe(false);
    expect(grid.isNeighbour(c, grid.key(...at(0, 100)))).toBe(false);
  });

  it('wraps neighbourhoods across the dateline', () => {
    const east = grid.key(179.99999, 0);
    const west = grid.key(-179.99999, 0);
    expect(grid.isNeighbour(east, west)).toBe(true);
    expect(grid.key(180, 0)).toBe(grid.key(-180, 0));
  });

  it('neighbourhood(reach) is (2·reach+1)² cells', () => {
    expect(grid.neighbourhood(grid.key(...at(0, 0)), 2)).toHaveLength(25);
  });
});

describe('walkTrackCells', () => {
  it('covers a sparse trail continuously (no gap longer than a cell)', () => {
    const w = walkTrackCells(street('a', 7), grid);
    // Every metre of the real line lands in (or next to) a visited cell.
    for (let x = 0; x <= 2000; x += 5) {
      const k = grid.key(...at(x, 7));
      expect(w.cells.has(k) || grid.ring(k).some((n) => w.cells.has(n))).toBe(true);
    }
    // And the edge path is connected: each edge joins neighbours.
    for (const e of w.edges) {
      const [a, b] = e.split(':').map(Number) as [number, number];
      expect(grid.isNeighbour(a, b)).toBe(true);
    }
  });

  it('paints a long straight simplified segment (a road ride), not a glitch', () => {
    const road = walkTrackCells({ id: 'a', parts: [[at(0, 0), at(5000, 0)]] }, grid);
    expect(road.cells.has(grid.key(...at(2500, 0)))).toBe(true);
    const glitch = walkTrackCells(
      { id: 'a', parts: [[at(0, 0), at(MAX_BRIDGE_M + 1000, 0)]] },
      grid,
    );
    // Only the two ends are painted: nothing in between.
    expect(glitch.cells.size).toBe(2);
    expect(glitch.edges.size).toBe(0);
  });

  it('never bridges a pause between parts', () => {
    const w = walkTrackCells({ id: 'a', parts: [[at(0, 0)], [at(300, 0)]] }, grid);
    expect(w.cells.size).toBe(2);
    expect(w.edges.size).toBe(0);
  });

  it('skips non-finite vertices without joining across them', () => {
    const w = walkTrackCells({ id: 'a', parts: [[at(0, 0), [Number.NaN, 1], at(30, 0)]] }, grid);
    expect(w.edges.size).toBe(0);
  });

  it('turns a wobble across a cell boundary into one line of edges, not a zig-zag', () => {
    // Hug a row boundary, flipping sides every 7 m.
    const boundaryY =
      Math.ceil((LAT * 111_320) / HEAT_LINE_CELL_M) * HEAT_LINE_CELL_M - LAT * 111_320;
    const part: [number, number][] = [];
    for (let x = 0; x <= 600; x += 7) part.push(at(x, boundaryY + ((x / 7) % 2 === 0 ? 2 : -2)));
    const w = walkTrackCells({ id: 'a', parts: [part] }, grid);
    // A path, not a ladder: no cell has more than two edges.
    const degree = new Map<number, number>();
    for (const e of w.edges) {
      for (const c of e.split(':').map(Number)) degree.set(c, (degree.get(c) ?? 0) + 1);
    }
    expect(Math.max(...degree.values())).toBeLessThanOrEqual(2);
    // And both rows still count as visited (tap/glow see them).
    expect(w.cells.size).toBeGreaterThan(degree.size);
  });
});

describe('buildHeatGrid + heatGridLines', () => {
  it('counts distinct trails: a slow walk counts once', () => {
    const slow = street('slow', 0, 0, 1000, 2); // a fix every 2 m
    const fast = street('fast', 3, 0, 1000, 200);
    const g = buildHeatGrid([walkTrackCells(slow, grid), walkTrackCells(fast, grid)], grid);
    expect(Math.max(...g.cellCounts.values())).toBe(2);
  });

  it('weights lines by pass count, monotonically, hot drawn last', () => {
    const passes = (n: number) =>
      buildHeatGrid(
        Array.from({ length: n }, (_, i) => walkTrackCells(street(`t${i}`, (i % 3) - 1), grid)),
        grid,
      );
    const maxCount = (n: number) =>
      Math.max(...heatGridLines(passes(n)).features.map((f) => f.properties.count));
    expect(maxCount(1)).toBe(1);
    expect(maxCount(2)).toBe(2);
    expect(maxCount(5)).toBe(8);
    expect(maxCount(20)).toBe(32);
    const counts = heatGridLines(passes(5)).features.map((f) => f.properties.count);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });

  it('draws a single pass as a continuous line along the trail', () => {
    const lines = heatGridLines(buildHeatGrid([walkTrackCells(street('a', 0), grid)], grid));
    expect(lines.features).toHaveLength(1);
    const coords = lines.features[0]?.geometry.coordinates.flat() ?? [];
    // Consecutive output vertices along each chain are never far apart
    // relative to the trail (straightened, but never cut).
    const xs = coords.map(([lng]) => (lng! + 71.2) * M_LNG).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(HEAT_LINE_CELL_M);
    expect(xs[xs.length - 1]).toBeGreaterThan(2000 - HEAT_LINE_CELL_M);
    const chains = lines.features[0]?.geometry.coordinates ?? [];
    const covered = chains.reduce((sum, chain) => {
      let len = 0;
      for (let i = 1; i < chain.length; i++) {
        len += Math.abs((chain[i]![0]! - chain[i - 1]![0]!) * M_LNG);
      }
      return sum + len;
    }, 0);
    expect(covered).toBeGreaterThan(1900);
  });

  it('keeps one feature per pass bucket', () => {
    const walks = Array.from({ length: 40 }, (_, i) =>
      walkTrackCells(street(`t${i}`, (i % 5) * 60, 0, 500 + i * 40), grid),
    );
    const lines = heatGridLines(buildHeatGrid(walks, grid));
    const buckets = lines.features.map((f) => f.properties.count);
    expect(new Set(buckets).size).toBe(buckets.length);
    expect(buckets.length).toBeLessThanOrEqual(8);
  });

  it('returns an empty collection for no trails', () => {
    expect(heatGridLines(buildHeatGrid([], grid)).features).toEqual([]);
    expect(heatGlowPoints(buildHeatGrid([], grid)).features).toEqual([]);
  });
});

describe('passBucket', () => {
  it('is monotonic and log2-stepped, capped', () => {
    let prev = 0;
    for (let n = 0; n <= 500; n++) {
      const b = passBucket(n);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
    expect([1, 2, 3, 4, 5, 9, 17, 33, 65, 1000].map(passBucket)).toEqual([
      1, 2, 4, 4, 8, 16, 32, 64, 128, 128,
    ]);
  });
});

describe('heatGlowPoints', () => {
  it('emits one weighted point per coarse cell with the max pass count', () => {
    const walks = [street('a', 0), street('b', 4), street('c', 400, 0, 300)].map((t) =>
      walkTrackCells(t, grid),
    );
    const glow = heatGlowPoints(buildHeatGrid(walks, grid));
    const counts = glow.features.map((f) => f.properties.count);
    expect(Math.max(...counts)).toBe(2);
    expect(Math.min(...counts)).toBe(1);
    // A 2 km street at 120 m cells: ~17 cells, not one per fix.
    expect(glow.features.length).toBeLessThan(40);
  });
});

describe('grid tap index', () => {
  const index = (tracks: GridTrackInput[], category = 'run') =>
    buildGridIndex(
      tracks.map((t) => ({ id: t.id, categoryId: category, cells: walkTrackCells(t, grid).cells })),
    );
  const tap = (idx: ReturnType<typeof index>, northM: number, radiusM: number) =>
    gridTrailsNearWithin(idx, grid, ...at(1000, northM), radiusM);

  const one = index([street('a')]);

  it('finds a single-pass trail right under the finger', () => {
    expect(tap(one, 0, 0)).toEqual({ trackIds: ['a'], hot: false });
  });

  it('forgives a finger a few metres off the line with no extra radius', () => {
    expect(tap(one, 30, 0).trackIds).toEqual(['a']);
  });

  it('misses a trail 150 m away without tolerance, finds it with enough', () => {
    expect(tap(one, 150, 0).trackIds).toEqual([]);
    expect(tap(one, 150, 200).trackIds).toEqual(['a']);
    expect(tap(one, 600, 200).trackIds).toEqual([]);
  });

  it('prefers the nearest of two trails', () => {
    const two = index([street('near', 120), street('far', -400)]);
    expect(tap(two, 0, 500).trackIds).toEqual(['near']);
  });

  it('caps the search radius', () => {
    expect(tap(one, MAX_GRID_TAP_RADIUS_M + 800, 1e9).trackIds).toEqual([]);
  });

  it('is hot where two trails of one category overlap, not across categories', () => {
    const same = index([street('a', 0), street('b', 8)]);
    expect(tap(same, 0, 0)).toEqual({ trackIds: ['a', 'b'], hot: true });
    const mixed = buildGridIndex([
      { id: 'a', categoryId: 'run', cells: walkTrackCells(street('a', 0), grid).cells },
      { id: 'b', categoryId: 'bike', cells: walkTrackCells(street('b', 8), grid).cells },
    ]);
    expect(gridTrailsNear(mixed, grid, grid.key(...at(1000, 0))).hot).toBe(false);
  });
});

describe('HeatGridAccumulator / HeatGridSync (#494)', () => {
  const walks = {
    a: walkTrackCells(street('a', 0), grid),
    b: walkTrackCells(street('b', 5), grid),
    c: walkTrackCells(street('c', 400, 0, 1000), grid),
  };
  const sorted = <K, V>(m: Map<K, V>) => [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const same = (x: ReturnType<typeof buildHeatGrid>, y: ReturnType<typeof buildHeatGrid>) => {
    expect(sorted(x.cellCounts)).toEqual(sorted(y.cellCounts));
    expect(sorted(x.edgeCounts)).toEqual(sorted(y.edgeCounts));
    expect(x.centroids.size).toBe(y.centroids.size);
    for (const [k, [lng, lat]] of x.centroids) {
      const other = y.centroids.get(k);
      expect(other?.[0]).toBeCloseTo(lng, 9);
      expect(other?.[1]).toBeCloseTo(lat, 9);
    }
  };

  it('adding walks one by one equals merging them', () => {
    const acc = new HeatGridAccumulator(grid);
    acc.add(walks.a);
    acc.add(walks.b);
    acc.add(walks.c);
    same(acc.heat, buildHeatGrid([walks.a, walks.b, walks.c], grid));
  });

  it('removing a walk undoes its add exactly', () => {
    const acc = new HeatGridAccumulator(grid);
    acc.add(walks.a);
    acc.add(walks.c);
    acc.add(walks.b);
    acc.remove(walks.c);
    same(acc.heat, buildHeatGrid([walks.a, walks.b], grid));
    acc.remove(walks.a);
    acc.remove(walks.b);
    expect(acc.heat.cellCounts.size).toBe(0);
    expect(acc.heat.edgeCounts.size).toBe(0);
    expect(acc.heat.centroids.size).toBe(0);
  });

  it('sync applies only the difference and stamps each change', () => {
    const sync = new HeatGridSync(grid);
    expect(sync.heat).toBeNull();
    expect(sync.stamp).toBe(0);
    expect(
      sync.sync(
        new Map([
          ['a', walks.a],
          ['b', walks.b],
        ]),
      ),
    ).toBe(true);
    const first = sync.stamp;
    expect(sync.size).toBe(2);
    // Same set: nothing to do, same stamp.
    expect(
      sync.sync(
        new Map([
          ['b', walks.b],
          ['a', walks.a],
        ]),
      ),
    ).toBe(false);
    expect(sync.stamp).toBe(first);
    // b re-walked (an edited trail), a gone, c new.
    const b2 = walkTrackCells(street('b', 300), grid);
    expect(
      sync.sync(
        new Map([
          ['b', b2],
          ['c', walks.c],
        ]),
      ),
    ).toBe(true);
    expect(sync.stamp).toBeGreaterThan(first);
    const heat = sync.heat;
    expect(heat).not.toBeNull();
    if (heat) same(heat, buildHeatGrid([b2, walks.c], grid));
    sync.clear();
    expect(sync.heat).toBeNull();
    expect(sync.size).toBe(0);
    const cleared = sync.stamp;
    sync.clear();
    expect(sync.stamp).toBe(cleared);
  });
});
