import { lngLatToTile } from '@core/geo/terrain';
import type { LngLat } from '@core/models';

import {
  CLIMB_MAX_ZOOM,
  climbFromTiles,
  elevationAt,
  planClimb,
  tileKeyId,
  tilesUnder,
  type DemTile,
} from './climb';
import { CAPS_LINE, LONG_TRAIL_LINE } from './__fixtures__/trails';

/** A tile whose elevation grows 1 m per pixel eastward. */
function rampTile(size = 256): DemTile {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = x;
  return { size, data };
}

describe('trail climb', () => {
  it('plans the deepest zoom within the tile budget', () => {
    const plan = planClimb([CAPS_LINE]);
    expect(plan?.z).toBe(CLIMB_MAX_ZOOM);
    expect(plan!.tiles.length).toBeGreaterThan(0);
    // A 250 km trail with a tiny budget drops zooms, then gives up.
    const coarse = planClimb([LONG_TRAIL_LINE], { maxTiles: 30 });
    expect(coarse?.z).toBeLessThan(CLIMB_MAX_ZOOM);
    expect(planClimb([LONG_TRAIL_LINE], { maxTiles: 3 })).toBeNull();
    expect(planClimb([])).toBeNull();
  });

  it('lists distinct tiles', () => {
    const tiles = tilesUnder(
      [
        [-70.7, 47.2],
        [-70.7001, 47.2001],
      ],
      12,
    );
    expect(tiles).toHaveLength(1);
    expect(tileKeyId(tiles[0]!)).toMatch(/^12\/\d+\/\d+$/);
  });

  it('samples elevation bilinearly and sums the climb', () => {
    const z = 12;
    const west: LngLat = [-70.7, 47.2];
    const { x, y } = lngLatToTile(west[0], west[1], z);
    const key = tileKeyId({ z, x: Math.floor(x), y: Math.floor(y) });
    const tiles = new Map([[key, rampTile()]]);
    const e0 = elevationAt(west, z, tiles);
    expect(e0).toBeCloseTo((x - Math.floor(x)) * 256 - 0.5, 0);
    // 0.02° east ≈ 58 px at z12 on this tile row: a 58 m climb.
    const east: LngLat = [west[0] + 0.02, west[1]];
    const climb = climbFromTiles([[west, east]], z, tiles);
    expect(climb).toBeGreaterThan(50);
    expect(climb).toBeLessThan(66);
    expect(elevationAt([10, 10], z, tiles)).toBeUndefined();
    expect(climbFromTiles([[[10, 10]]], z, tiles)).toBeNull();
  });
});
