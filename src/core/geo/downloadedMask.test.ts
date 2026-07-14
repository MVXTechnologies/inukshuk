import type { BoundingBox } from '@core/models';
import type { Position } from 'geojson';
import { buildDownloadedMask, MASK_WORLD } from './downloadedMask';

/** Shoelace signed area (positive = counter-clockwise in lng/lat space). */
function signedArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (!a || !b) throw new Error('ring index out of range');
    sum += (a[0] ?? 0) * (b[1] ?? 0) - (b[0] ?? 0) * (a[1] ?? 0);
  }
  return sum / 2;
}

/** Axis-aligned bbox of a rectangular ring. */
function ringBBox(ring: Position[]): BoundingBox {
  const lngs = ring.map((p) => p[0] ?? NaN);
  const lats = ring.map((p) => p[1] ?? NaN);
  return {
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
  };
}

const rectArea = (b: BoundingBox) => (b.maxLng - b.minLng) * (b.maxLat - b.minLat);

const overlapArea = (a: BoundingBox, b: BoundingBox) =>
  Math.max(0, Math.min(a.maxLng, b.maxLng) - Math.max(a.minLng, b.minLng)) *
  Math.max(0, Math.min(a.maxLat, b.maxLat) - Math.max(a.minLat, b.minLat));

const box = (minLng: number, minLat: number, maxLng: number, maxLat: number): BoundingBox => ({
  minLng,
  minLat,
  maxLng,
  maxLat,
});

describe('buildDownloadedMask', () => {
  it('returns a full world mask (no holes) for an empty region list', () => {
    const mask = buildDownloadedMask([]);
    expect(mask.geometry.type).toBe('Polygon');
    expect(mask.geometry.coordinates).toHaveLength(1);
    const exterior = mask.geometry.coordinates[0];
    if (!exterior) throw new Error('missing exterior ring');
    expect(ringBBox(exterior)).toEqual(MASK_WORLD);
  });

  it('closes every ring (first coordinate === last coordinate)', () => {
    const mask = buildDownloadedMask([box(-70, 45, -69, 46)]);
    for (const ring of mask.geometry.coordinates) {
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });

  it('winds the exterior counter-clockwise and holes clockwise (RFC 7946 / MapLibre fill)', () => {
    const mask = buildDownloadedMask([box(-70, 45, -69, 46)]);
    const [exterior, ...holes] = mask.geometry.coordinates;
    if (!exterior) throw new Error('missing exterior ring');
    expect(signedArea(exterior)).toBeGreaterThan(0); // CCW
    expect(holes).toHaveLength(1);
    for (const hole of holes) expect(signedArea(hole)).toBeLessThan(0); // CW
  });

  it('punches one hole exactly matching a single downloaded region', () => {
    const region = box(-70.5, 45.25, -69.75, 46);
    const hole = buildDownloadedMask([region]).geometry.coordinates[1];
    if (!hole) throw new Error('missing hole ring');
    expect(ringBBox(hole)).toEqual(region);
  });

  it('keeps holes for multiple disjoint regions independent', () => {
    const a = box(-70, 45, -69, 46);
    const b = box(10, 50, 11, 51);
    const [, ...holes] = buildDownloadedMask([a, b]).geometry.coordinates;
    expect(holes).toHaveLength(2);
    const areas = holes.map((h) => Math.abs(signedArea(h))).sort();
    expect(areas[0]).toBeCloseTo(rectArea(a), 10);
    expect(areas[1]).toBeCloseTo(rectArea(b), 10);
  });

  it('splits overlapping regions into disjoint holes covering exactly their union', () => {
    const a = box(0, 0, 10, 10);
    const b = box(5, 5, 15, 15); // overlaps a by 5×5
    const [, ...holes] = buildDownloadedMask([a, b]).geometry.coordinates;

    // No two holes overlap…
    const boxes = holes.map(ringBBox);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const bi = boxes[i];
        const bj = boxes[j];
        if (!bi || !bj) throw new Error('hole bbox missing');
        expect(overlapArea(bi, bj)).toBe(0);
      }
    }
    // …every hole winds clockwise…
    for (const hole of holes) expect(signedArea(hole)).toBeLessThan(0);
    // …and together they cover exactly the union area (100 + 100 − 25).
    const total = holes.reduce((sum, h) => sum + Math.abs(signedArea(h)), 0);
    expect(total).toBeCloseTo(175, 10);
  });

  it('collapses a region fully inside an earlier one (no zero-area hole)', () => {
    const outer = box(0, 0, 10, 10);
    const inner = box(2, 2, 8, 8);
    const [, ...holes] = buildDownloadedMask([outer, inner]).geometry.coordinates;
    expect(holes).toHaveLength(1);
    const hole = holes[0];
    if (!hole) throw new Error('missing hole ring');
    expect(Math.abs(signedArea(hole))).toBeCloseTo(100, 10);
  });

  it('clamps regions to the mask world bounds and drops fully-outside regions', () => {
    const spillsNorth = box(-70, 80, -69, 89); // beyond the ±85 mercator clamp
    const offWorld = box(-200, 86, -190, 89); // entirely outside
    const [, ...holes] = buildDownloadedMask([spillsNorth, offWorld]).geometry.coordinates;
    expect(holes).toHaveLength(1);
    const hole = holes[0];
    if (!hole) throw new Error('missing hole ring');
    expect(ringBBox(hole)).toEqual(box(-70, 80, -69, MASK_WORLD.maxLat));
  });
});
