/**
 * Runs under the app's jest (the Worker has no test runner of its own):
 * contourGrid.ts is pure, so it needs nothing from the Workers runtime.
 */
import {
  copyDemIntoWindow,
  cornerGrid,
  decodeBudgetFrom,
  DEFAULT_DECODE_BUDGET,
  demPartsFor,
  gridGradient,
  LoadCache,
  newPixelWindow,
  planDemLoads,
  traceIsolines,
  WINDOW_MARGIN,
  type CornerGrid,
  type DemState,
} from './contourGrid';
import { cleanIsolines, encodeContourMvt, type DemPixels } from './contourMath';

/** A DEM tile whose height is `f(x, y)` of its own pixel. */
function dem(size: number, f: (x: number, y: number) => number): DemPixels {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = f(x, y);
  return { width: size, height: size, data };
}

/** A corner grid of `cells` × `cells` cells (+ its buffer) with height `f(cx, cy)`. */
function gridOf(cells: number, f: (cx: number, cy: number) => number): CornerGrid {
  const width = cells + 1;
  const stride = width + 2;
  const data = new Float32Array(stride * stride);
  for (let gy = 0; gy < stride; gy++) {
    for (let gx = 0; gx < stride; gx++) data[gy * stride + gx] = f(gx - 1, gy - 1);
  }
  return { width, stride, data };
}

describe('demPartsFor', () => {
  it('reads the tile’s own DEM first, then the neighbours its border touches', () => {
    // z13 tile in the top-right quadrant of DEM tile 12/1285/1371.
    const { size, parts } = demPartsFor(13, 2571, 2742, 12, 256);
    expect(size).toBe(128);
    expect(parts.map((p) => p.key)).toEqual([
      '12/1285/1371',
      '12/1285/1370',
      '12/1286/1371',
      '12/1286/1370',
    ]);
    expect(parts[0]).toMatchObject({ own: true, offsets: [[-128, 0]] });
    // 130 × 130 of the window from its own tile, two-pixel strips from the others.
    expect(parts.map((p) => p.area)).toEqual([130 * 130, 130 * 2, 2 * 130, 4]);
    expect(parts.reduce((n, p) => n + p.area, 0)).toBe(132 * 132);
    expect(parts.find((p) => p.key === '12/1286/1370')?.offsets).toEqual([[128, -256]]);
  });

  it('needs the three other neighbours from the opposite quadrant', () => {
    const { parts } = demPartsFor(13, 2570, 2743, 12, 256);
    expect(parts.map((p) => p.key).sort()).toEqual(
      ['12/1284/1371', '12/1284/1372', '12/1285/1371', '12/1285/1372'].sort(),
    );
    expect(parts[0]?.key).toBe('12/1285/1371');
  });

  it('wraps around the antimeridian and stops at the poles', () => {
    const west = demPartsFor(8, 0, 0, 7, 256).parts;
    // Left neighbour is the world's last column; nothing above row 0.
    expect(west.map((p) => p.key).sort()).toEqual(['7/0/0', '7/127/0'].sort());
    const east = demPartsFor(8, 255, 255, 7, 256).parts;
    expect(east.map((p) => p.key).sort()).toEqual(['7/0/127', '7/127/127'].sort());
  });

  it('copies the one world tile on both sides at z0', () => {
    const { size, parts } = demPartsFor(0, 0, 0, 0, 256);
    expect(size).toBe(256);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.offsets).toEqual([
      [-256, 0],
      [0, 0],
      [256, 0],
    ]);
  });
});

describe('pixel window and corner grid', () => {
  it('stitches the DEM tiles of a window, validity-checked', () => {
    const { size, parts } = demPartsFor(13, 2571, 2742, 12, 256);
    const win = newPixelWindow(size);
    expect(win.stride).toBe(size + 2 * WINDOW_MARGIN);
    const height = (col: number, row: number) => (col % 512) + (row % 512) / 1000;
    let copied = 0;
    for (const part of parts) {
      // Height from the pixel's world column and row, whatever tile it is read from.
      const tile = dem(256, (x, y) => height(part.x * 256 + x, part.y * 256 + y));
      for (const [ox, oy] of part.offsets) copied += copyDemIntoWindow(win, tile, ox, oy);
    }
    expect(copied).toBe(132 * 132);
    const at = (px: number, py: number) =>
      win.data[(py + WINDOW_MARGIN) * win.stride + px + WINDOW_MARGIN]!;
    const world = (px: number, py: number) => height(2571 * 128 + px, 2742 * 128 + py);
    for (const [px, py] of [
      [0, 0],
      [-2, -2],
      [129, -2],
      [129, 129],
      [-2, 129],
      [64, 64],
    ] as const) {
      expect(at(px, py)).toBeCloseTo(world(px, py), 2);
    }
  });

  it('leaves NaN where a DEM tile is missing, and for out-of-range heights', () => {
    const win = newPixelWindow(4);
    const tile = dem(8, (x, y) => (x === 5 && y === 5 ? 20_000 : 100));
    // The contour tile is the DEM tile's bottom-right quadrant; no neighbours copied.
    copyDemIntoWindow(win, tile, -4, -4);
    const at = (px: number, py: number) =>
      win.data[(py + WINDOW_MARGIN) * win.stride + px + WINDOW_MARGIN]!;
    expect(at(0, 0)).toBe(100);
    expect(at(-2, -2)).toBe(100);
    expect(at(1, 1)).toBeNaN(); // DEM pixel (5, 5): not a height
    expect(at(4, 0)).toBeNaN(); // past the DEM tile: the missing neighbour
    expect(at(0, 5)).toBeNaN();
  });

  it('averages the pixels around each corner, missing ones left out', () => {
    const win = newPixelWindow(4);
    copyDemIntoWindow(
      win,
      dem(8, (x) => x * 10),
      -4,
      -4,
    );
    const grid = cornerGrid(win);
    expect(grid.width).toBe(5);
    expect(grid.stride).toBe(7);
    const corner = (cx: number, cy: number) => grid.data[(cy + 1) * grid.stride + cx + 1]!;
    // Tile pixel p is DEM pixel p + 4 (height 10 × that); a corner is the mean of its two columns.
    expect(corner(0, 0)).toBe(35);
    expect(corner(2, 3)).toBe(55);
    expect(corner(-1, -1)).toBe(25);
    // The right edge has no neighbour: the corner takes its own side's pixels only.
    expect(corner(4, 2)).toBe(70);
    // One past it there is nothing at all.
    expect(corner(5, 2)).toBeNaN();
  });

  it('gives the height change across the cell under a point', () => {
    const grid = gridOf(4, (cx, cy) => cx * 3 + cy * 5);
    const gradientAt = gridGradient(grid, 4096);
    expect(gradientAt(10, 10)).toBe(8);
    expect(gradientAt(4000, 4000)).toBe(8);
    // Clamped to the tile's cells.
    expect(gradientAt(-50, 9999)).toBe(8);
  });
});

// --- Isolines ------------------------------------------------------------------

/**
 * maplibre-contour 0.1.1's `generateIsolines` (BSD-3-Clause), as it is —
 * Maps of fragment ends per level, `splice(0, 0, …)` to prepend — reading
 * the same corner grid: the reference the fast tracer must match exactly.
 */
function referenceIsolines(
  grid: CornerGrid,
  interval: number,
  extent: number,
): Record<string, number[][]> {
  const CASES: number[][][][] = [
    [],
    [[[1, 2], [0, 1]]], // prettier-ignore
    [[[2, 1], [1, 2]]], // prettier-ignore
    [[[2, 1], [0, 1]]], // prettier-ignore
    [[[1, 0], [2, 1]]], // prettier-ignore
    [[[1, 2], [0, 1]], [[1, 0], [2, 1]]], // prettier-ignore
    [[[1, 0], [1, 2]]], // prettier-ignore
    [[[1, 0], [0, 1]]], // prettier-ignore
    [[[0, 1], [1, 0]]], // prettier-ignore
    [[[1, 2], [1, 0]]], // prettier-ignore
    [[[0, 1], [1, 0]], [[2, 1], [1, 2]]], // prettier-ignore
    [[[2, 1], [1, 0]]], // prettier-ignore
    [[[0, 1], [2, 1]]], // prettier-ignore
    [[[1, 2], [2, 1]]], // prettier-ignore
    [[[0, 1], [1, 2]]], // prettier-ignore
    [],
  ];
  interface Frag {
    start: number;
    end: number;
    points: number[];
  }
  const width = grid.width;
  const get = (x: number, y: number) => grid.data[(y + 1) * grid.stride + x + 1]!;
  const index = (x: number, y: number, point: number[]) =>
    x * 2 + point[0]! + (y * 2 + point[1]!) * (width + 1) * 2;
  const ratio = (a: number, b: number, c: number) => (b - a) / (c - a);
  const multiplier = extent / (width - 1);
  const segments: Record<string, number[][]> = {};
  const byStartByLevel = new Map<number, Map<number, Frag>>();
  const byEndByLevel = new Map<number, Map<number, Frag>>();
  let tld = 0;
  let trd = 0;
  let bld = 0;
  let brd = 0;
  let r = 0;
  let c = 0;
  const interpolate = (point: number[], threshold: number): [number, number] => {
    if (point[0] === 0)
      return [multiplier * (c - 1), multiplier * (r - ratio(bld, threshold, tld))];
    if (point[0] === 2) return [multiplier * c, multiplier * (r - ratio(brd, threshold, trd))];
    if (point[1] === 0)
      return [multiplier * (c - ratio(trd, threshold, tld)), multiplier * (r - 1)];
    return [multiplier * (c - ratio(brd, threshold, bld)), multiplier * r];
  };
  const rounded = ([x, y]: [number, number]) => [Math.round(x), Math.round(y)];
  for (r = 0; r < width + 1; r++) {
    trd = get(0, r - 1);
    brd = get(0, r);
    let minR = Math.min(trd, brd);
    let maxR = Math.max(trd, brd);
    for (c = 0; c < width + 1; c++) {
      tld = trd;
      bld = brd;
      trd = get(c, r - 1);
      brd = get(c, r);
      const minL = minR;
      const maxL = maxR;
      minR = Math.min(trd, brd);
      maxR = Math.max(trd, brd);
      if (isNaN(tld) || isNaN(trd) || isNaN(brd) || isNaN(bld)) continue;
      const min = Math.min(minL, minR);
      const max = Math.max(maxL, maxR);
      const first = Math.ceil(min / interval) * interval;
      const last = Math.floor(max / interval) * interval;
      for (let threshold = first; threshold <= last; threshold += interval) {
        const tl = tld > threshold;
        const tr = trd > threshold;
        const bl = bld > threshold;
        const br = brd > threshold;
        for (const segment of CASES[(tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)]!) {
          let byStart = byStartByLevel.get(threshold);
          if (!byStart) byStartByLevel.set(threshold, (byStart = new Map()));
          let byEnd = byEndByLevel.get(threshold);
          if (!byEnd) byEndByLevel.set(threshold, (byEnd = new Map()));
          const start = segment[0]!;
          const end = segment[1]!;
          const startIndex = index(c, r, start);
          const endIndex = index(c, r, end);
          let f = byEnd.get(startIndex);
          if (f) {
            byEnd.delete(startIndex);
            const g = byStart.get(endIndex);
            if (g) {
              byStart.delete(endIndex);
              if (f === g) {
                f.points.push(...rounded(interpolate(end, threshold)));
                (segments[threshold] ??= []).push(f.points);
              } else {
                f.points.push(...g.points);
                f.end = g.end;
                byEnd.set(f.end, f);
              }
            } else {
              f.points.push(...rounded(interpolate(end, threshold)));
              f.end = endIndex;
              byEnd.set(endIndex, f);
            }
          } else if ((f = byStart.get(endIndex))) {
            byStart.delete(endIndex);
            f.points.splice(0, 0, ...rounded(interpolate(start, threshold)));
            f.start = startIndex;
            byStart.set(startIndex, f);
          } else {
            const fresh: Frag = {
              start: startIndex,
              end: endIndex,
              points: [
                ...rounded(interpolate(start, threshold)),
                ...rounded(interpolate(end, threshold)),
              ],
            };
            byStart.set(startIndex, fresh);
            byEnd.set(endIndex, fresh);
          }
        }
      }
    }
  }
  for (const [level, byStart] of byStartByLevel) {
    for (const f of byStart.values()) (segments[level] ??= []).push(f.points);
  }
  return segments;
}

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Rolling terrain: a few random sine bumps, `relief` metres high, around `base`. */
function terrain(cells: number, seed: number, base: number, relief: number): CornerGrid {
  const random = rng(seed);
  const waves = Array.from({ length: 6 }, () => ({
    kx: (random() - 0.5) * 0.6,
    ky: (random() - 0.5) * 0.6,
    phase: random() * Math.PI * 2,
    amp: random(),
  }));
  const noise = Array.from({ length: (cells + 3) ** 2 }, () => random() - 0.5);
  return gridOf(cells, (cx, cy) => {
    let h = 0;
    for (const w of waves) h += w.amp * Math.sin(w.kx * cx + w.ky * cy + w.phase);
    return base + (relief * h) / 3 + noise[(cy + 1) * (cells + 3) + cx + 1]! * relief * 0.02;
  });
}

describe('traceIsolines', () => {
  it('draws straight lines across a ramp, one per interval', () => {
    // 10 m per cell eastwards over 8 cells of 512 units: 20 m lines every 2 cells.
    const grid = gridOf(8, (cx) => 100 + cx * 10);
    const lines = traceIsolines(grid, 20, 4096);
    // Corners −1 … 9 span 90–190 m; the degenerate first column adds nothing.
    expect(Object.keys(lines)).toEqual(['100', '120', '140', '160', '180']);
    for (const [ele, list] of Object.entries(lines)) {
      expect(list).toHaveLength(1);
      const line = list[0]!;
      const x = ((Number(ele) - 100) / 10) * 512;
      // Vertical, from one buffer row to the other, at the ramp's x.
      for (let i = 0; i < line.length; i += 2) expect(line[i]).toBe(x);
      const ys = line.filter((_, i) => i % 2 === 1);
      expect(Math.min(...ys)).toBe(-512);
      expect(Math.max(...ys)).toBe(4096 + 512);
    }
  });

  it('closes a ring around a summit', () => {
    const grid = gridOf(8, (cx, cy) => 100 - Math.hypot(cx - 4, cy - 4) * 10);
    const lines = traceIsolines(grid, 25, 4096);
    const ring = lines['75']?.[0];
    expect(lines['75']).toHaveLength(1);
    expect(ring).toBeDefined();
    expect(ring!.slice(0, 2)).toEqual(ring!.slice(-2));
    // 25 m below the top at 10 m per cell: 2.5 cells out.
    for (let i = 0; i < ring!.length; i += 2) {
      const d = Math.hypot(ring![i]! - 2048, ring![i + 1]! - 2048) / 512;
      expect(d).toBeGreaterThan(2.3);
      expect(d).toBeLessThan(2.6);
    }
  });

  it('skips the levels at or below `above`, leaving the others untouched', () => {
    const grid = gridOf(8, (cx) => -30 + cx * 10);
    const all = traceIsolines(grid, 20, 4096);
    const land = traceIsolines(grid, 20, 4096, 0);
    expect(Object.keys(all).sort()).toEqual(['-20', '0', '20', '40']);
    expect(Object.keys(land)).toEqual(['20', '40']);
    for (const ele of Object.keys(land)) expect(land[ele]).toEqual(all[ele]);
  });

  it('draws nothing without an interval, and nothing through missing data', () => {
    expect(
      traceIsolines(
        gridOf(4, (cx) => cx * 10),
        0,
        4096,
      ),
    ).toEqual({});
    expect(
      traceIsolines(
        gridOf(4, () => Number.NaN),
        10,
        4096,
      ),
    ).toEqual({});
    // A hole in the middle splits the lines but does not break the trace.
    const holed = gridOf(8, (cx, cy) => (cx === 4 && cy === 4 ? Number.NaN : 100 + cx * 10));
    const lines = traceIsolines(holed, 20, 4096);
    expect(lines['140']!.length).toBeGreaterThanOrEqual(1);
    expect(lines['120']).toHaveLength(1);
  });

  it.each([
    ['rolling hills', 1, 400, 300, 10],
    ['a shield of lakes and knolls', 2, 500, 60, 10],
    ['steep ground, coarse interval', 3, 2500, 2500, 50],
    ['a coast (heights through zero)', 4, 20, 200, 20],
    ['odd interval', 5, 310, 120, 25],
  ])(
    'matches maplibre-contour line for line, point for point: %s',
    (_name, seed, base, relief, interval) => {
      const grid = terrain(64, seed, base, relief);
      const expected = referenceIsolines(grid, interval, 4096);
      const lines = traceIsolines(grid, interval, 4096);
      expect(Object.keys(lines).length).toBeGreaterThan(3);
      expect(lines).toEqual(expected);
      // … and so does the tile made from them.
      const options = { levels: [interval, interval * 5] as const, tolerance: 2, tinySpan: 48 };
      expect(
        encodeContourMvt(cleanIsolines(traceIsolines(grid, interval, 4096, 0), options)),
      ).toEqual(encodeContourMvt(cleanIsolines(expected, options)));
    },
  );

  it('matches the reference with holes in the grid (a neighbour not decoded yet)', () => {
    const grid = terrain(48, 9, 300, 200);
    // The partial tile's case: the buffer row and column past two edges are NaN.
    for (let i = 0; i < grid.stride; i++) {
      grid.data[i] = Number.NaN;
      grid.data[i * grid.stride + grid.stride - 1] = Number.NaN;
    }
    // And a few holes inside.
    for (const i of [500, 777, 1203, 1204, 2000]) grid.data[i] = Number.NaN;
    expect(traceIsolines(grid, 10, 4096)).toEqual(referenceIsolines(grid, 10, 4096));
  });

  it('keeps long lines cheap: a spiral is traced in one piece', () => {
    // Height grows with the angle around the centre: every level is one long
    // line, joined from fragments begun on many rows.
    const cells = 96;
    const grid = gridOf(cells, (cx, cy) => {
      const dx = cx - cells / 2 + 0.25;
      const dy = cy - cells / 2 + 0.25;
      return 500 + Math.hypot(dx, dy) * 6 + Math.atan2(dy, dx) * 9;
    });
    const lines = traceIsolines(grid, 60, 4096);
    expect(lines).toEqual(referenceIsolines(grid, 60, 4096));
    const longest = Math.max(...Object.values(lines).flatMap((l) => l.map((p) => p.length / 2)));
    expect(longest).toBeGreaterThan(300);
  });
});

// --- CPU budget ----------------------------------------------------------------

describe('decode budget', () => {
  it('starts only the first absent tiles, in priority order', () => {
    const cold: DemState[] = ['absent', 'absent', 'absent', 'absent', 'absent'];
    expect(planDemLoads(cold, 2)).toEqual([true, true, false, false, false]);
    expect(planDemLoads(cold, 9)).toEqual([true, true, true, true, true]);
    expect(planDemLoads(cold, 0)).toEqual([false, false, false, false, false]);
  });

  it('does not count tiles that are ready or being decoded by another request', () => {
    expect(planDemLoads(['ready', 'pending', 'absent', 'ready', 'absent', 'absent'], 2)).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(planDemLoads(['ready', 'ready', 'ready'], 2)).toEqual([false, false, false]);
  });

  it('reads the budget from the environment, falling back to the default', () => {
    expect(DEFAULT_DECODE_BUDGET).toBe(2);
    expect(decodeBudgetFrom(undefined)).toBe(DEFAULT_DECODE_BUDGET);
    expect(decodeBudgetFrom('')).toBe(DEFAULT_DECODE_BUDGET);
    expect(decodeBudgetFrom('9')).toBe(9);
    expect(decodeBudgetFrom('1')).toBe(1);
    expect(decodeBudgetFrom('0')).toBe(DEFAULT_DECODE_BUDGET);
    expect(decodeBudgetFrom('2.5')).toBe(DEFAULT_DECODE_BUDGET);
    expect(decodeBudgetFrom('lots')).toBe(DEFAULT_DECODE_BUDGET);
  });
});

describe('LoadCache', () => {
  /** A load the test settles by hand. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('shares a load in flight, then keeps its value', async () => {
    const cache = new LoadCache<string>(4, 1000);
    const load = deferred<string>();
    let calls = 0;
    expect(cache.state('a')).toBe('absent');
    const started = cache.start('a', () => {
      calls++;
      return load.promise;
    });
    expect(cache.state('a')).toBe('pending');
    expect(cache.value('a')).toBeUndefined();
    const joined = cache.pending('a');
    expect(joined).toBeDefined();
    load.resolve('dem');
    await expect(started).resolves.toBe('dem');
    await expect(joined).resolves.toBe('dem');
    expect(calls).toBe(1);
    expect(cache.state('a')).toBe('ready');
    expect(cache.value('a')).toBe('dem');
    expect(cache.pending('a')).toBeUndefined();
  });

  it('forgets a failed load, so the next request tries again', async () => {
    const cache = new LoadCache<string>(4, 1000);
    const load = deferred<string>();
    const started = cache.start('a', () => load.promise);
    load.reject(new Error('DEM 503'));
    await expect(started).rejects.toThrow('DEM 503');
    expect(cache.state('a')).toBe('absent');
    expect(cache.size).toBe(0);
  });

  it('forgets a load whose request died: pending for longer than the fetch can take', () => {
    let now = 0;
    const cache = new LoadCache<string>(4, 1000, () => now);
    // The owner was cancelled or killed: its promise never settles.
    void cache.start('a', () => new Promise<string>(() => undefined));
    now = 900;
    expect(cache.state('a')).toBe('pending');
    now = 1001;
    expect(cache.state('a')).toBe('absent');
    expect(cache.pending('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('never ages a loaded value out', async () => {
    let now = 0;
    const cache = new LoadCache<string>(4, 1000, () => now);
    await cache.start('a', async () => 'dem');
    now = 1e9;
    expect(cache.state('a')).toBe('ready');
    expect(cache.value('a')).toBe('dem');
  });

  it('a late result of a replaced load does not overwrite the newer one', async () => {
    const cache = new LoadCache<string>(4, 1000);
    const dead = deferred<string>();
    const first = cache.start('a', () => dead.promise);
    await cache.start('a', async () => 'fresh');
    dead.resolve('stale');
    await first;
    expect(cache.value('a')).toBe('fresh');
    // … and a late failure does not evict it either.
    const failing = deferred<string>();
    const second = cache.start('b', () => failing.promise);
    await cache.start('b', async () => 'kept');
    failing.reject(new Error('late'));
    await expect(second).rejects.toThrow('late');
    expect(cache.value('b')).toBe('kept');
  });

  it('drops the least recently used entry past its size', async () => {
    const cache = new LoadCache<number>(2, 1000);
    await cache.start('a', async () => 1);
    await cache.start('b', async () => 2);
    expect(cache.value('a')).toBe(1); // a is now the most recent
    await cache.start('c', async () => 3);
    expect(cache.state('b')).toBe('absent');
    expect(cache.value('a')).toBe(1);
    expect(cache.value('c')).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
