import { clampTileRange, TERRARIUM_TILE_SOURCE, tileRangeForBbox } from '@core/geo/terrain';
import type { BoundingBox } from '@core/models';
import { mercatorPixel } from './cropRaster';
import { layoutMadeMap, RASTER_LONG_EDGE_PX, type PageFormat } from './layout';
import { PRINT_STYLES, printTileSource } from './printSources';
import {
  assessTileFailures,
  clampZoomToSource,
  fetchAllTiles,
  frameIsPrintable,
  isOfflineOnlyError,
  MERCATOR_MAX_LAT,
  maxTilesPerSideFor,
  planTiles,
  TileFetchError,
  tilesInRange,
  tileUrl,
  wrapTileX,
  type TileFailure,
} from './tilePlan';

const CAP = maxTilesPerSideFor(RASTER_LONG_EDGE_PX);
const src = { minZoom: 0, maxZoom: 19 };

/** The frame the editor hands the composer for a centre + scale. */
function sheet(center: [number, number], scaleDenom: number, format: PageFormat = 'a4') {
  const [lng, lat] = center;
  const d = 0.001;
  const bbox = { minLng: lng - d, maxLng: lng + d, minLat: lat - d * 0.7, maxLat: lat + d * 0.7 };
  return layoutMadeMap(bbox, format, { scaleDenom });
}

/** Pixels of `bbox` that fall OUTSIDE the stitched raster of `range`. */
function uncoveredPx(range: Parameters<typeof mercatorPixel>[2], bbox: BoundingBox) {
  const tl = mercatorPixel(bbox.minLng, bbox.maxLat, range);
  const br = mercatorPixel(bbox.maxLng, bbox.minLat, range);
  const w = (range.maxX - range.minX + 1) * 256;
  const h = (range.maxY - range.minY + 1) * 256;
  return Math.max(0, -tl.x) + Math.max(0, br.x - w) + Math.max(0, -tl.y) + Math.max(0, br.y - h);
}

const MONT_SAINTE_ANNE: [number, number] = [-70.905, 47.076];
const QUEBEC: [number, number] = [-71.208, 46.8139];

describe('planTiles — the sheet must be covered edge to edge (#460)', () => {
  it('A4 1:25 000 over Mont-Sainte-Anne: 17 tile rows, none cropped away', () => {
    // The failing case: the raster is 3 925 px tall, straddling 17 tiles at
    // z16. The old 16-tile clamp dropped the top row — 61 px of the frame
    // missing, the rest stretched over it, misregistered.
    const layout = sheet(MONT_SAINTE_ANNE, 25000);
    expect(layout.rasterZoom).toBe(16);
    const old = clampTileRange(tileRangeForBbox(layout.drawBbox, 16), RASTER_LONG_EDGE_PX / 256);
    expect(uncoveredPx(old, layout.drawBbox)).toBeGreaterThan(50);

    const plan = planTiles(layout.drawBbox, layout.rasterZoom, src, CAP);
    expect(plan.range.maxY - plan.range.minY + 1).toBe(17);
    expect(uncoveredPx(plan.range, layout.drawBbox)).toBe(0);
  });

  it.each([
    ['msa', MONT_SAINTE_ANNE],
    ['quebec', QUEBEC],
  ] as const)(
    '%s: every realistic scale and page is fully covered and within the cap',
    (_name, center) => {
      for (const format of ['a4', 'letter'] as const) {
        for (const denom of [2500, 5000, 10000, 25000, 50000, 100000, 250000, 1000000]) {
          const layout = sheet(center, denom, format);
          const plan = planTiles(layout.drawBbox, layout.rasterZoom, src, CAP);
          expect(uncoveredPx(plan.range, layout.drawBbox)).toBe(0);
          expect(plan.range.maxX - plan.range.minX + 1).toBeLessThanOrEqual(CAP);
          expect(plan.range.maxY - plan.range.minY + 1).toBeLessThanOrEqual(CAP);
          expect(plan.tiles.length).toBeLessThanOrEqual(CAP * CAP);
        }
      }
    },
  );

  it('maxTilesPerSideFor leaves one tile of slack for a straddling window', () => {
    expect(maxTilesPerSideFor(4096)).toBe(17);
    expect(maxTilesPerSideFor(256)).toBe(2);
    expect(maxTilesPerSideFor(300)).toBe(3);
  });

  it('lists each tile once with its stitch position', () => {
    const layout = sheet(QUEBEC, 5000);
    const plan = planTiles(layout.drawBbox, layout.rasterZoom, src, CAP);
    const { minX, maxX, minY, maxY } = plan.range;
    expect(plan.tiles).toHaveLength((maxX - minX + 1) * (maxY - minY + 1));
    expect(new Set(plan.tiles.map((t) => `${t.x}/${t.y}`)).size).toBe(plan.tiles.length);
    expect(plan.tiles[0]).toMatchObject({ x: minX, y: minY, col: 0, row: 0 });
    expect(plan.tiles.at(-1)).toMatchObject({
      x: maxX,
      y: maxY,
      col: maxX - minX,
      row: maxY - minY,
    });
  });

  it('does not ask for the next tile when an edge sits exactly on a boundary', () => {
    // z1: lng 0 / lat 0 is the corner shared by all four tiles.
    const plan = planTiles({ minLng: -180, maxLng: 0, minLat: 0, maxLat: 80 }, 1, src, CAP);
    expect(plan.range).toEqual({ z: 1, minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });
});

describe('zoom clamping', () => {
  it('clamps to the source min/max and floors fractional zooms', () => {
    expect(clampZoomToSource(20, { minZoom: 0, maxZoom: 17 })).toBe(17);
    expect(clampZoomToSource(-3, { minZoom: 0, maxZoom: 17 })).toBe(0);
    expect(clampZoomToSource(15.9, { minZoom: 0, maxZoom: 17 })).toBe(15);
    expect(clampZoomToSource(Number.NaN, { minZoom: 2, maxZoom: 17 })).toBe(2);
    expect(clampZoomToSource(Infinity, { minZoom: 2, maxZoom: 17 })).toBe(2);
  });

  it('planTiles never requests past the source maximum', () => {
    const layout = sheet(QUEBEC, 2500);
    const plan = planTiles(layout.drawBbox, 22, { minZoom: 0, maxZoom: 17 }, CAP);
    expect(plan.range.z).toBe(17);
    for (const t of plan.tiles) expect(t.z).toBe(17);
  });

  it('planTiles never goes below the source minimum', () => {
    const plan = planTiles(
      { minLng: -10, maxLng: 10, minLat: -10, maxLat: 10 },
      0,
      {
        minZoom: 3,
        maxZoom: 17,
      },
      CAP,
    );
    expect(plan.range.z).toBe(3);
  });
});

describe('x wrap / y clamp', () => {
  it('wraps columns into the world', () => {
    expect(wrapTileX(-1, 3)).toBe(7);
    expect(wrapTileX(8, 3)).toBe(0);
    expect(wrapTileX(17, 3)).toBe(1);
    expect(wrapTileX(5, 3)).toBe(5);
  });

  it('a sheet across the antimeridian keeps a continuous range and requests wrapped tiles', () => {
    // Taveuni, Fiji straddles 180°: the frame runs from 179.5° to 180.5°.
    const plan = planTiles(
      { minLng: 179.5, maxLng: 180.5, minLat: -17, maxLat: -16.5 },
      8,
      src,
      CAP,
    );
    const n = 2 ** 8;
    expect(plan.range.minX).toBeLessThan(n);
    expect(plan.range.maxX).toBeGreaterThanOrEqual(n);
    for (const t of plan.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(n);
    }
    // Both sides of the line are there: columns 255 and 0.
    expect(new Set(plan.tiles.map((t) => t.x))).toEqual(new Set([255, 0]));
  });

  it('a sheet west of -180° wraps the other way', () => {
    const plan = planTiles(
      { minLng: -180.5, maxLng: -179.5, minLat: 60, maxLat: 60.2 },
      6,
      src,
      CAP,
    );
    expect(plan.range.minX).toBe(-1);
    expect(new Set(plan.tiles.map((t) => t.x))).toEqual(new Set([63, 0]));
  });

  it('never requests the same column twice for a frame wider than the world', () => {
    const plan = planTiles({ minLng: -300, maxLng: 300, minLat: -10, maxLat: 10 }, 2, src, 100);
    expect(plan.range.maxX - plan.range.minX + 1).toBe(4);
    expect(new Set(plan.tiles.map((t) => `${t.x}/${t.y}`)).size).toBe(plan.tiles.length);
  });

  it('clamps rows to the world past the Mercator limit (no NaN rows)', () => {
    const plan = planTiles({ minLng: -80, maxLng: -60, minLat: 80, maxLat: 95 }, 4, src, CAP);
    expect(plan.range.minY).toBe(0);
    for (const t of plan.tiles) {
      expect(Number.isInteger(t.y)).toBe(true);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThan(16);
    }
    const south = planTiles({ minLng: 0, maxLng: 1, minLat: -95, maxLat: -86 }, 3, src, CAP);
    expect(south.range).toMatchObject({ minY: 7, maxY: 7 });
  });

  it('rejects a non-finite frame instead of planning NaN tiles', () => {
    expect(() =>
      planTiles({ minLng: Number.NaN, maxLng: 1, minLat: 0, maxLat: 1 }, 5, src, CAP),
    ).toThrow(RangeError);
  });
});

describe('tile count cap', () => {
  it('crops around the centre to the cap on both axes', () => {
    const plan = planTiles({ minLng: -80, maxLng: -60, minLat: 40, maxLat: 55 }, 12, src, 17);
    expect(plan.range.maxX - plan.range.minX + 1).toBe(17);
    expect(plan.range.maxY - plan.range.minY + 1).toBe(17);
    expect(plan.tiles).toHaveLength(17 * 17);
    // Centred: the uncropped range's middle column is still inside.
    const full = tileRangeForBbox({ minLng: -80, maxLng: -60, minLat: 40, maxLat: 55 }, 12);
    const mid = Math.floor((full.minX + full.maxX) / 2);
    expect(plan.range.minX).toBeLessThanOrEqual(mid);
    expect(plan.range.maxX).toBeGreaterThanOrEqual(mid);
  });

  it('a cap below one still plans one tile', () => {
    expect(
      planTiles({ minLng: 0, maxLng: 10, minLat: 0, maxLat: 10 }, 8, src, 0).tiles,
    ).toHaveLength(1);
  });
});

describe('tilesInRange', () => {
  it('lists a 3D/DEM range row-major with stitch positions', () => {
    const tiles = tilesInRange({ z: 10, minX: 300, maxX: 301, minY: 360, maxY: 361 });
    expect(tiles).toEqual([
      { z: 10, x: 300, y: 360, col: 0, row: 0 },
      { z: 10, x: 301, y: 360, col: 1, row: 0 },
      { z: 10, x: 300, y: 361, col: 0, row: 1 },
      { z: 10, x: 301, y: 361, col: 1, row: 1 },
    ]);
  });
});

describe('frameIsPrintable', () => {
  it('accepts a normal sheet and refuses one zoomed out past the world', () => {
    expect(frameIsPrintable(sheet(QUEBEC, 25000).drawBbox)).toBe(true);
    expect(frameIsPrintable({ minLng: -100, maxLng: -40, minLat: -61, maxLat: 155 })).toBe(false);
    expect(
      frameIsPrintable({ minLng: -10, maxLng: 10, minLat: 0, maxLat: MERCATOR_MAX_LAT + 1 }),
    ).toBe(false);
    expect(frameIsPrintable({ minLng: -200, maxLng: 200, minLat: 0, maxLat: 10 })).toBe(false);
    expect(frameIsPrintable({ minLng: 5, maxLng: 5, minLat: 0, maxLat: 10 })).toBe(false);
    expect(frameIsPrintable({ minLng: Number.NaN, maxLng: 5, minLat: 0, maxLat: 10 })).toBe(false);
  });
});

describe('tile URLs — every layer the map maker prints', () => {
  const t = { z: 16, x: 19854, y: 23023 };

  it('street and imagery are Esri MapServer tiles in {z}/{y}/{x} order', () => {
    for (const style of PRINT_STYLES) {
      const url = tileUrl(printTileSource(style.drape).template, t);
      expect(url).toMatch(
        /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_(Street_Map|Imagery)\/MapServer\/tile\/16\/23023\/19854$/,
      );
    }
    expect(tileUrl(printTileSource('map').template, t)).toContain('World_Street_Map');
    expect(tileUrl(printTileSource('satellite').template, t)).toContain('World_Imagery');
  });

  it('the composer stitches exactly the template the live editor shows', () => {
    for (const style of PRINT_STYLES) {
      expect(printTileSource(style.drape).template).toBe(style.tileUrl);
    }
  });

  it('each print source is bounded by the zooms it really serves', () => {
    expect(printTileSource('map')).toMatchObject({ minZoom: 0, maxZoom: 19 });
    expect(printTileSource('satellite')).toMatchObject({ minZoom: 0, maxZoom: 17 });
  });

  it('elevation (contours / slope) is a Terrarium PNG in {z}/{x}/{y} order', () => {
    expect(tileUrl(TERRARIUM_TILE_SOURCE.template, { z: 14, x: 4951, y: 5774 })).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/4951/5774.png',
    );
  });

  it('refuses a template missing a placeholder', () => {
    expect(() => tileUrl('https://example.com/{z}/{x}.png', t)).toThrow(/\{y\}/);
  });

  it('never leaves a placeholder or a fractional / negative index in the URL', () => {
    const layout = sheet(MONT_SAINTE_ANNE, 25000);
    for (const style of PRINT_STYLES) {
      const source = printTileSource(style.drape);
      const plan = planTiles(layout.drawBbox, layout.rasterZoom, source, CAP);
      for (const tile of plan.tiles) {
        const url = tileUrl(source.template, tile);
        expect(url).not.toMatch(/[{}]/);
        expect(url).toMatch(/\/tile\/\d+\/\d+\/\d+$/);
      }
    }
  });
});

describe('fetchAllTiles', () => {
  const noSleep = () => Promise.resolve();

  it('retries a flaky tile and succeeds without reporting it', async () => {
    let calls = 0;
    const failures = await fetchAllTiles(
      ['a', 'b', 'c'],
      async (tile) => {
        if (tile === 'b' && calls++ < 2) throw new Error('timeout');
      },
      { sleep: noSleep },
    );
    expect(failures).toEqual([]);
    expect(calls).toBe(3);
  });

  it('reports a tile that keeps failing, and still fetches all the others', async () => {
    const fetched: string[] = [];
    const failures = await fetchAllTiles(
      ['a', 'b', 'c', 'd'],
      async (tile) => {
        if (tile === 'c') throw new Error('Unable to download a file: HTTP 503');
        fetched.push(tile);
      },
      { sleep: noSleep, retries: 2 },
    );
    expect(fetched.sort()).toEqual(['a', 'b', 'd']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ tile: 'c', attempts: 3 });
  });

  it('does not retry an offline-only refusal — no retry can fix a setting', async () => {
    let calls = 0;
    const offline = Object.assign(new Error('offline-only: x not cached'), {
      name: 'OfflineOnlyError',
    });
    const failures = await fetchAllTiles(
      ['a'],
      async () => {
        calls++;
        throw offline;
      },
      { sleep: noSleep },
    );
    expect(calls).toBe(1);
    expect(failures[0]?.attempts).toBe(1);
  });

  it('backs off between attempts', async () => {
    const waits: number[] = [];
    await fetchAllTiles(
      ['a'],
      async () => {
        throw new Error('x');
      },
      { retries: 2, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([400, 800]);
  });

  it('never runs more than `concurrency` downloads at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const tiles = Array.from({ length: 40 }, (_, i) => i);
    await fetchAllTiles(
      tiles,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
      { concurrency: 6 },
    );
    expect(peak).toBe(6);
  });

  it('reports progress for every tile, failed ones included', async () => {
    const ticks: [number, number][] = [];
    await fetchAllTiles(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('x');
      },
      { retries: 0, onSettled: (d, total) => ticks.push([d, total]) },
    );
    expect(ticks).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('stops scheduling once aborted', async () => {
    let aborted = false;
    const seen: number[] = [];
    await fetchAllTiles(
      [1, 2, 3, 4, 5],
      async (n) => {
        seen.push(n);
        if (n === 2) aborted = true;
      },
      { concurrency: 1, isAborted: () => aborted },
    );
    expect(seen).toEqual([1, 2]);
  });

  it('handles an empty tile list', async () => {
    expect(await fetchAllTiles([], async () => undefined)).toEqual([]);
  });
});

describe('assessTileFailures', () => {
  const fail = (error: unknown, n: number): TileFailure<number>[] =>
    Array.from({ length: n }, (_, i) => ({ tile: i, error, attempts: 3 }));

  it('nothing missing is 0', () => {
    expect(assessTileFailures('map', 200, [], 0.05)).toBe(0);
  });

  it('a few holes under the tolerance print, and are counted', () => {
    expect(assessTileFailures('map', 200, fail(new Error('timeout'), 3), 0.05)).toBe(3);
  });

  it('too many missing throws a message naming the count and the cause', () => {
    const run = () =>
      assessTileFailures(
        'map',
        192,
        fail(new Error('Unable to download a file: timeout'), 40),
        0.05,
      );
    expect(run).toThrow(TileFetchError);
    expect(run).toThrow(
      "couldn't download 40 of 192 map tiles (Unable to download a file: timeout). Check your connection and try again.",
    );
  });

  it('offline-only mode is named as the cause, with the setting to change', () => {
    const offline = Object.assign(new Error('offline-only: map-16-1-2.png not cached'), {
      name: 'OfflineOnlyError',
    });
    expect(isOfflineOnlyError(offline)).toBe(true);
    let caught: unknown;
    try {
      assessTileFailures('map', 192, fail(offline, 192), 0.05);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TileFetchError);
    const err = caught as TileFetchError;
    expect(err.offlineOnly).toBe(true);
    expect(err.failed).toBe(192);
    expect(err.message).toMatch(/offline-only mode is on/);
    expect(err.message).toMatch(/Locally downloaded only/);
  });

  it('zero tolerance (elevation) throws on a single missing tile', () => {
    expect(() => assessTileFailures('elevation', 4, fail('boom', 1), 0)).toThrow(
      "couldn't download 1 of 4 elevation tiles (boom). Check your connection and try again.",
    );
  });
});
