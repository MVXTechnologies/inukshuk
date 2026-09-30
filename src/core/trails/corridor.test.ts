import type { LngLat } from '@core/models';

import {
  bufferBox,
  canDownloadWholeTrail,
  WHOLE_TRAIL_MAX_KM,
  CORRIDOR_MAX_BOXES,
  corridorBoxes,
  corridorTileCount,
  planCorridorDownload,
} from './corridor';
import { CAPS_LINE, LONG_TRAIL_LINE } from './__fixtures__/trails';

describe('trail corridor', () => {
  it('buffers a box by metres on every side', () => {
    const b = bufferBox({ minLng: 0, minLat: 0, maxLng: 0, maxLat: 0 }, 3000);
    expect(b.maxLat).toBeCloseTo(3000 / 111_320, 6);
    expect(b.minLng).toBeCloseTo(-3000 / 111_320, 6);
    const polar = bufferBox({ minLng: 179.99, minLat: 84.99, maxLng: 179.99, maxLat: 84.99 }, 9000);
    expect(polar.maxLng).toBe(180);
    expect(polar.maxLat).toBe(85);
  });

  it('keeps a short trail in one box', () => {
    const boxes = corridorBoxes([CAPS_LINE.slice(0, 3)], 3000, 20);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.minLng).toBeLessThan(-70.754);
  });

  it('chunks a long trail into overlapping boxes that cover every vertex', () => {
    const boxes = corridorBoxes([LONG_TRAIL_LINE], 3000, 20);
    expect(boxes.length).toBeGreaterThan(10);
    for (const [lon, lat] of LONG_TRAIL_LINE) {
      expect(
        boxes.some((b) => lon >= b.minLng && lon <= b.maxLng && lat >= b.minLat && lat <= b.maxLat),
      ).toBe(true);
    }
    for (const b of boxes) {
      expect((b.maxLat - b.minLat) * 111.32).toBeLessThan(20 + 6.1);
    }
  });

  it('densifies long straight segments', () => {
    const straight: LngLat[] = [
      [0, 45],
      [0, 46],
    ];
    expect(corridorBoxes([straight], 1000, 20).length).toBeGreaterThanOrEqual(6);
    expect(corridorBoxes([[]])).toEqual([]);
  });

  it('counts overlapping tiles once', () => {
    const box = { minLng: -70.8, minLat: 47.1, maxLng: -70.7, maxLat: 47.2 };
    const once = corridorTileCount([box], 14);
    expect(corridorTileCount([box, box], 14)).toBe(once);
    expect(once).toBeGreaterThan(0);
  });

  it('plans the download and refuses a continent', () => {
    const plan = planCorridorDownload([CAPS_LINE], 'vector');
    expect(plan.tooBig).toBe(false);
    expect(plan.bytes).toBe(plan.tiles * 12_000);
    const huge: LngLat[] = [
      [-120, 34],
      [-68, 46],
    ];
    const big = planCorridorDownload([huge], 'vector');
    expect(big.boxes.length).toBeGreaterThan(CORRIDOR_MAX_BOXES);
    expect(big.tooBig).toBe(true);
    expect(planCorridorDownload([], 'raster').tooBig).toBe(true);
  });
});

describe('whole-trail download', () => {
  it('is offered only for short stage-less trails within budget', () => {
    const plan = planCorridorDownload([CAPS_LINE], 'vector');
    expect(canDownloadWholeTrail(43, plan)).toBe(true);
    expect(canDownloadWholeTrail(WHOLE_TRAIL_MAX_KM + 1, plan)).toBe(false);
    expect(canDownloadWholeTrail(10, { ...plan, tooBig: true })).toBe(false);
  });
});
