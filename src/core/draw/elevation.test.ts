import type { LngLat } from '@core/models';
import { tileKeyId, type DemTile } from '@core/trails/climb';

import {
  planRouteElevation,
  ROUTE_MAX_SAMPLES,
  ROUTE_SAMPLE_STEP_M,
  routeElevationFromTiles,
} from './elevation';

const SIZE = 4;

/** A tile whose height rises linearly southward (row 0 = north) from `base`. */
function slopeTile(base: number, perRow: number): DemTile {
  const data = new Float32Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) data[r * SIZE + c] = base + r * perRow;
  return { size: SIZE, data };
}

const flat = (h: number): DemTile => ({ size: SIZE, data: new Float32Array(SIZE * SIZE).fill(h) });

// ~6.6 km across Québec City's upper town, west → east.
const ROUTE: LngLat[] = [
  [-71.26, 46.8],
  [-71.23, 46.805],
  [-71.2, 46.81],
  [-71.18, 46.812],
];

describe('planRouteElevation', () => {
  it('densifies the line (vertices kept) and picks a zoom within the tile budget', () => {
    const plan = planRouteElevation(ROUTE);
    expect(plan).not.toBeNull();
    expect(plan!.samples[0]).toEqual(ROUTE[0]);
    expect(plan!.samples[plan!.samples.length - 1]).toEqual(ROUTE[3]);
    for (const v of ROUTE) expect(plan!.samples).toContainEqual(v);
    // ~6.6 km at 30 m → a couple of hundred samples.
    expect(plan!.samples.length).toBeGreaterThan(6600 / ROUTE_SAMPLE_STEP_M - 10);
    expect(plan!.tiles.length).toBeGreaterThan(0);
    expect(plan!.tiles.length).toBeLessThanOrEqual(24);
    expect(plan!.z).toBe(13);
  });

  it('needs a line', () => {
    expect(planRouteElevation([])).toBeNull();
    expect(planRouteElevation([ROUTE[0]!])).toBeNull();
  });

  it('drops the zoom for a long route, and gives up past the budget', () => {
    const long: LngLat[] = [
      [-72, 46],
      [-70, 47.5],
    ];
    const plan = planRouteElevation(long);
    expect(plan).not.toBeNull();
    expect(plan!.z).toBeLessThan(13);
    expect(planRouteElevation(long, { maxTiles: 1 })).toBeNull();
  });

  it('caps the sample count on a very long line', () => {
    const huge: LngLat[] = [
      [-80, 40],
      [-60, 55],
    ];
    const plan = planRouteElevation(huge, { maxTiles: 10_000 });
    expect(plan).not.toBeNull();
    expect(plan!.samples.length).toBeLessThanOrEqual(ROUTE_MAX_SAMPLES);
  });
});

describe('routeElevationFromTiles', () => {
  it('climbs from a low tile onto a high one', () => {
    const plan = planRouteElevation(ROUTE)!;
    const tiles = new Map<string, DemTile>();
    // West half low, east half 120 m higher.
    const xs = [...new Set(plan.tiles.map((t) => t.x))].sort((a, b) => a - b);
    const mid = xs[Math.floor(xs.length / 2)]!;
    for (const t of plan.tiles) tiles.set(tileKeyId(t), flat(t.x < mid ? 50 : 170));
    const result = routeElevationFromTiles(plan, tiles);
    expect(result).not.toBeNull();
    expect(result!.elevations).toHaveLength(plan.samples.length);
    expect(result!.ascentM).toBeGreaterThan(100);
    expect(result!.descentM).toBe(0);
  });

  it('reads per-pixel slopes and leaves samples on a missing tile undefined', () => {
    const plan = planRouteElevation(ROUTE)!;
    const tiles = new Map<string, DemTile>();
    const [first, ...rest] = plan.tiles;
    tiles.set(tileKeyId(first!), slopeTile(10, 5));
    const result = routeElevationFromTiles(plan, tiles);
    expect(result).not.toBeNull();
    if (rest.length > 0) expect(result!.elevations.some((e) => e === undefined)).toBe(true);
  });

  it('is null with no tile data at all', () => {
    const plan = planRouteElevation(ROUTE)!;
    expect(routeElevationFromTiles(plan, new Map())).toBeNull();
  });
});
