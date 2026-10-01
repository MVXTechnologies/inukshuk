import type { BoundingBox } from '@core/models';

import { boxesIntersect, boxRects, buildBBoxIndex, MAX_CELLS_PER_ENTRY } from './bboxIndex';

const box = (minLng: number, minLat: number, maxLng: number, maxLat: number): BoundingBox => ({
  minLng,
  minLat,
  maxLng,
  maxLat,
});

/** Brute force reference: every entry whose box meets the query. */
function brute(entries: { id: string; bbox: BoundingBox }[], q: BoundingBox): string[] {
  return entries.filter((e) => boxesIntersect(e.bbox, q)).map((e) => e.id);
}

describe('boxRects / boxesIntersect', () => {
  it('splits a box crossing the antimeridian into two', () => {
    expect(boxRects(box(170, -10, -170, 10))).toEqual([
      { w: 170, s: -10, e: 180, n: 10 },
      { w: -180, s: -10, e: -170, n: 10 },
    ]);
    expect(boxRects(box(-200, 0, 200, 1))).toEqual([{ w: -180, s: 0, e: 180, n: 1 }]);
  });

  it('intersects across the antimeridian, touching edges count', () => {
    expect(boxesIntersect(box(170, 0, -170, 1), box(-175, 0.5, -172, 0.6))).toBe(true);
    expect(boxesIntersect(box(170, 0, -170, 1), box(0, 0, 10, 1))).toBe(false);
    expect(boxesIntersect(box(0, 0, 1, 1), box(1, 1, 2, 2))).toBe(true);
    expect(boxesIntersect(box(0, 0, 1, 1), box(NaN, 0, 1, 1))).toBe(false);
  });
});

describe('buildBBoxIndex', () => {
  it('returns intersecting ids once each, in insertion order', () => {
    const index = buildBBoxIndex([
      { id: 'c', bbox: box(-71.3, 46.8, -71.1, 46.9) },
      { id: 'a', bbox: box(-71.25, 46.7, -71.2, 46.75) },
      { id: 'far', bbox: box(2.3, 48.8, 2.4, 48.9) },
      { id: 'b', bbox: box(-71.4, 46.6, -70.9, 47.0) },
    ]);
    expect(index.size).toBe(4);
    expect(index.query(box(-71.22, 46.72, -71.21, 46.85))).toEqual(['c', 'a', 'b']);
    expect(index.query(box(2, 48, 3, 49))).toEqual(['far']);
    expect(index.query(box(100, 0, 101, 1))).toEqual([]);
  });

  it('matches a brute-force scan on random boxes and queries', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const entries = Array.from({ length: 300 }, (_, i) => {
      const lng = -72 + rand() * 2;
      const lat = 46 + rand() * 2;
      return { id: `t${i}`, bbox: box(lng, lat, lng + rand() * 0.3, lat + rand() * 0.3) };
    });
    const index = buildBBoxIndex(entries);
    for (let k = 0; k < 200; k++) {
      const lng = -72.5 + rand() * 3;
      const lat = 45.5 + rand() * 3;
      const q = box(lng, lat, lng + rand() * 0.5, lat + rand() * 0.5);
      expect(index.query(q)).toEqual(brute(entries, q));
    }
    // A world-sized query takes the occupied-cells path: same answer.
    expect(index.query(box(-180, -90, 180, 90))).toEqual(entries.map((e) => e.id));
  });

  it('handles boxes and queries crossing the antimeridian', () => {
    const index = buildBBoxIndex([
      { id: 'fiji', bbox: box(177, -19, -179, -16) },
      { id: 'east', bbox: box(-179.5, -18, -179.2, -17) },
      { id: 'west', bbox: box(178, -18, 179, -17) },
      { id: 'elsewhere', bbox: box(10, -18, 11, -17) },
    ]);
    expect(index.query(box(179.5, -18.5, -179.6, -16.5))).toEqual(['fiji']);
    expect(index.query(box(178.5, -18, -179.3, -17))).toEqual(['fiji', 'east', 'west']);
    expect(index.query(box(-179.4, -17.5, -179.3, -17.2))).toEqual(['fiji', 'east']);
  });

  it('keeps a huge box out of the grid but still finds it', () => {
    const index = buildBBoxIndex(
      [
        { id: 'small', bbox: box(0, 0, 0.01, 0.01) },
        { id: 'continent', bbox: box(-130, 25, -60, 50) },
      ],
      0.1,
    );
    expect((70 / 0.1) * (25 / 0.1)).toBeGreaterThan(MAX_CELLS_PER_ENTRY);
    expect(index.query(box(-71.3, 46.8, -71.2, 46.9))).toEqual(['continent']);
    expect(index.query(box(-1, -1, 1, 1))).toEqual(['small']);
  });

  it('returns a trail with an unusable box for every query (never culls bad data)', () => {
    const index = buildBBoxIndex([
      { id: 'nan', bbox: box(NaN, NaN, NaN, NaN) },
      { id: 'flipped', bbox: box(0, 10, 1, 5) },
      { id: 'ok', bbox: box(0, 0, 1, 1) },
    ]);
    expect(index.query(box(50, 50, 51, 51))).toEqual(['nan', 'flipped']);
    expect(index.query(box(0, 0, 1, 1))).toEqual(['nan', 'flipped', 'ok']);
    // An unusable query matches nothing.
    expect(index.query(box(NaN, 0, 1, 1))).toEqual([]);
  });

  it('rejects a bad cell size', () => {
    expect(() => buildBBoxIndex([], 0)).toThrow(RangeError);
    expect(() => buildBBoxIndex([], Infinity)).toThrow(RangeError);
  });
});
