import type { LngLat } from '@core/models';
import { haversineM } from '@core/trails/geometry';

import {
  boundsOfVertices,
  densifyLine,
  isSelfIntersecting,
  midpointHandles,
  midpointOf,
  pointInRing,
  polygonAreaM2,
  polygonPerimeterM,
  polylineLengthM,
  segmentsIntersect,
} from './geometry';

const R = 6371008.8;
const DEG = Math.PI / 180;

describe('polylineLengthM', () => {
  it('sums the segments', () => {
    const line: LngLat[] = [
      [-71.2, 46.8],
      [-71.19, 46.8],
      [-71.19, 46.81],
    ];
    const expected = haversineM(line[0]!, line[1]!) + haversineM(line[1]!, line[2]!);
    expect(polylineLengthM(line)).toBeCloseTo(expected, 6);
  });

  it('is 0 for fewer than two vertices', () => {
    expect(polylineLengthM([])).toBe(0);
    expect(polylineLengthM([[0, 0]])).toBe(0);
  });

  it('one degree of latitude is ~111.2 km', () => {
    expect(
      polylineLengthM([
        [0, 0],
        [0, 1],
      ]),
    ).toBeCloseTo(111_195, -1);
  });
});

describe('polygonAreaM2', () => {
  it('is exact for a lat/lng rectangle: R² Δλ (sin φ2 − sin φ1)', () => {
    const ring: LngLat[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const exact = R * R * (1 * DEG) * (Math.sin(1 * DEG) - Math.sin(0));
    expect(polygonAreaM2(ring)).toBeCloseTo(exact, -2);
    expect(polygonAreaM2(ring) / 1e6).toBeCloseTo(12_363.7, 0);
  });

  it('does not depend on winding or the start vertex', () => {
    const ring: LngLat[] = [
      [-71.2, 46.8],
      [-71.18, 46.8],
      [-71.18, 46.81],
      [-71.2, 46.81],
    ];
    const a = polygonAreaM2(ring);
    expect(polygonAreaM2([...ring].reverse())).toBeCloseTo(a, 6);
    expect(polygonAreaM2([...ring.slice(2), ...ring.slice(0, 2)])).toBeCloseTo(a, 6);
  });

  it('a ~1.5 km × 1.1 km block near Québec City is ~1.7 km²', () => {
    const ring: LngLat[] = [
      [-71.2, 46.8],
      [-71.18, 46.8],
      [-71.18, 46.81],
      [-71.2, 46.81],
    ];
    const w = haversineM([-71.2, 46.805], [-71.18, 46.805]);
    const h = haversineM([-71.2, 46.8], [-71.2, 46.81]);
    expect(polygonAreaM2(ring)).toBeCloseTo(w * h, -3);
  });

  it('is 0 under three vertices', () => {
    expect(
      polygonAreaM2([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(0);
  });
});

describe('polygonPerimeterM', () => {
  it('includes the closing edge', () => {
    const ring: LngLat[] = [
      [0, 0],
      [0, 1],
      [1, 1],
    ];
    const expected =
      haversineM([0, 0], [0, 1]) + haversineM([0, 1], [1, 1]) + haversineM([1, 1], [0, 0]);
    expect(polygonPerimeterM(ring)).toBeCloseTo(expected, 6);
  });

  it('is 0 under three vertices', () => {
    expect(polygonPerimeterM([[0, 0]])).toBe(0);
  });
});

describe('midpointHandles', () => {
  const v: LngLat[] = [
    [0, 0],
    [2, 0],
    [2, 2],
  ];

  it('one handle per segment of an open line, inserting between its ends', () => {
    expect(midpointHandles(v, false)).toEqual([
      { insertAt: 1, at: [1, 0] },
      { insertAt: 2, at: [2, 1] },
    ]);
  });

  it('a closed ring also gets the closing segment, inserting at the end', () => {
    expect(midpointHandles(v, true)).toEqual([
      { insertAt: 1, at: [1, 0] },
      { insertAt: 2, at: [2, 1] },
      { insertAt: 3, at: [1, 1] },
    ]);
  });

  it('no closing handle on a two-vertex "ring"', () => {
    expect(midpointHandles(v.slice(0, 2), true)).toEqual([{ insertAt: 1, at: [1, 0] }]);
  });

  it('midpointOf averages the ends', () => {
    expect(midpointOf([-71, 46], [-72, 47])).toEqual([-71.5, 46.5]);
  });
});

describe('boundsOfVertices', () => {
  it('spans every vertex', () => {
    expect(
      boundsOfVertices([
        [-71.2, 46.8],
        [-71.1, 46.7],
        [-71.15, 46.9],
      ]),
    ).toEqual({ minLng: -71.2, minLat: 46.7, maxLng: -71.1, maxLat: 46.9 });
  });

  it('is null for none', () => {
    expect(boundsOfVertices([])).toBeNull();
  });
});

describe('densifyLine', () => {
  it('keeps every vertex and adds points every step', () => {
    const a: LngLat = [-71.2, 46.8];
    const b: LngLat = [-71.2, 46.801]; // ~111 m north
    const c: LngLat = [-71.199, 46.801];
    const out = densifyLine([a, b, c], 30);
    expect(out[0]).toEqual(a);
    expect(out).toContainEqual(b);
    expect(out[out.length - 1]).toEqual(c);
    // 111 m / 30 m → 3 intermediate samples before b.
    expect(out.indexOf(b)).toBe(4);
    for (let i = 1; i < out.length; i++) {
      expect(haversineM(out[i - 1]!, out[i]!)).toBeLessThanOrEqual(30.0001);
    }
  });

  it('is empty for no vertices and the vertex itself for one', () => {
    expect(densifyLine([], 30)).toEqual([]);
    expect(densifyLine([[1, 2]], 30)).toEqual([[1, 2]]);
  });

  it('a zero step keeps just the vertices', () => {
    const line: LngLat[] = [
      [0, 0],
      [0, 1],
    ];
    expect(densifyLine(line, 0)).toEqual(line);
  });
});

describe('segmentsIntersect', () => {
  it('crossing segments intersect', () => {
    expect(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
  });

  it('parallel segments do not', () => {
    expect(segmentsIntersect([0, 0], [2, 0], [0, 1], [2, 1])).toBe(false);
  });

  it('collinear overlap and touching ends count', () => {
    expect(segmentsIntersect([0, 0], [2, 0], [1, 0], [3, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 1], [1, 1], [2, 0])).toBe(true);
  });

  it('collinear but disjoint does not', () => {
    expect(segmentsIntersect([0, 0], [1, 0], [2, 0], [3, 0])).toBe(false);
  });
});

describe('isSelfIntersecting', () => {
  it('a simple square is fine', () => {
    expect(
      isSelfIntersecting([
        [-71.2, 46.8],
        [-71.19, 46.8],
        [-71.19, 46.81],
        [-71.2, 46.81],
      ]),
    ).toBe(false);
  });

  it('a bow tie is flagged', () => {
    expect(
      isSelfIntersecting([
        [-71.2, 46.8],
        [-71.19, 46.81],
        [-71.19, 46.8],
        [-71.2, 46.81],
      ]),
    ).toBe(true);
  });

  it('triangles never self-intersect', () => {
    expect(
      isSelfIntersecting([
        [0, 0],
        [1, 0],
        [0, 1],
      ]),
    ).toBe(false);
  });
});

describe('pointInRing', () => {
  const ring: LngLat[] = [
    [-71.2, 46.8],
    [-71.19, 46.8],
    [-71.19, 46.81],
    [-71.2, 46.81],
  ];

  it('inside and outside', () => {
    expect(pointInRing([-71.195, 46.805], ring)).toBe(true);
    expect(pointInRing([-71.185, 46.805], ring)).toBe(false);
    expect(pointInRing([-71.195, 46.815], ring)).toBe(false);
  });

  it('a degenerate ring contains nothing', () => {
    expect(pointInRing([0, 0], ring.slice(0, 2))).toBe(false);
  });
});
