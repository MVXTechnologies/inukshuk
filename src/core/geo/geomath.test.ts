import type { CornerCoordinates, PointRect } from '@core/models';
import {
  applyAffine,
  bboxFromCorners,
  bboxFromLngLats,
  cornersAreValid,
  extrapolatePageCorners,
  fitAffine,
  initialBearingDeg,
  isDegenerateBBox,
  isInsideBBox,
  isValidLngLat,
  padBBox,
  unionBoundingBoxes,
} from './geomath';

describe('fitAffine / applyAffine', () => {
  it('recovers a pure translation + scale exactly', () => {
    // dst = (2x + 10, 3y - 5)
    const src = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const;
    const dst = src.map(([x, y]) => [2 * x + 10, 3 * y - 5] as const);
    const t = fitAffine(src, dst);
    expect(applyAffine(t, 5, 7)[0]).toBeCloseTo(20, 6);
    expect(applyAffine(t, 5, 7)[1]).toBeCloseTo(16, 6);
  });

  it('recovers a rotation/skew transform', () => {
    // dst = (x - y, x + y)
    const src = [
      [0, 0],
      [2, 0],
      [0, 2],
      [3, 5],
    ] as const;
    const dst = src.map(([x, y]) => [x - y, x + y] as const);
    const t = fitAffine(src, dst);
    const [u, v] = applyAffine(t, 4, 1);
    expect(u).toBeCloseTo(3, 6);
    expect(v).toBeCloseTo(5, 6);
  });

  it('throws on too few points', () => {
    expect(() =>
      fitAffine(
        [
          [0, 0],
          [1, 1],
        ],
        [
          [0, 0],
          [1, 1],
        ],
      ),
    ).toThrow(/at least 3/);
  });

  it('throws on collinear (degenerate) source points', () => {
    const src = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ] as const;
    const dst = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ] as const;
    expect(() => fitAffine(src, dst)).toThrow(/Degenerate/);
  });
});

describe('extrapolatePageCorners', () => {
  it('returns the viewport corners unchanged when target === viewport', () => {
    const rect: PointRect = { x0: 0, y0: 0, x1: 100, y1: 200 };
    const corners: CornerCoordinates = {
      topLeft: [-71.1, 42.4],
      topRight: [-71.0, 42.4],
      bottomRight: [-71.0, 42.3],
      bottomLeft: [-71.1, 42.3],
    };
    const out = extrapolatePageCorners(rect, corners, rect);
    expect(out.topLeft[0]).toBeCloseTo(-71.1, 6);
    expect(out.topLeft[1]).toBeCloseTo(42.4, 6);
    expect(out.bottomRight[0]).toBeCloseTo(-71.0, 6);
    expect(out.bottomRight[1]).toBeCloseTo(42.3, 6);
  });

  it('extrapolates a full page from a centered viewport linearly', () => {
    // Viewport is the inner half of the page; geo spans 1 degree across it.
    const viewportRect: PointRect = { x0: 100, y0: 100, x1: 200, y1: 200 };
    const viewportCorners: CornerCoordinates = {
      topLeft: [0, 1],
      topRight: [1, 1],
      bottomRight: [1, 0],
      bottomLeft: [0, 0],
    };
    const pageRect: PointRect = { x0: 0, y0: 0, x1: 300, y1: 300 };
    const out = extrapolatePageCorners(viewportRect, viewportCorners, pageRect);
    // Page extends one extra viewport-width beyond each side -> -1..2 degrees.
    expect(out.bottomLeft[0]).toBeCloseTo(-1, 6);
    expect(out.bottomLeft[1]).toBeCloseTo(-1, 6);
    expect(out.topRight[0]).toBeCloseTo(2, 6);
    expect(out.topRight[1]).toBeCloseTo(2, 6);
  });
});

describe('bbox helpers', () => {
  it('bboxFromLngLats computes the extent', () => {
    const bbox = bboxFromLngLats([
      [-71.1, 42.3],
      [-70.9, 42.5],
      [-71.0, 42.4],
    ]);
    expect(bbox).toEqual({ minLat: 42.3, minLng: -71.1, maxLat: 42.5, maxLng: -70.9 });
  });

  it('bboxFromLngLats throws on empty input', () => {
    expect(() => bboxFromLngLats([])).toThrow();
  });

  it('bboxFromCorners wraps bboxFromLngLats', () => {
    const corners: CornerCoordinates = {
      topLeft: [-71.1, 42.5],
      topRight: [-70.9, 42.5],
      bottomRight: [-70.9, 42.3],
      bottomLeft: [-71.1, 42.3],
    };
    expect(bboxFromCorners(corners)).toEqual({
      minLat: 42.3,
      minLng: -71.1,
      maxLat: 42.5,
      maxLng: -70.9,
    });
  });

  it('isInsideBBox is inclusive of edges', () => {
    const bbox = { minLat: 42.3, minLng: -71.1, maxLat: 42.5, maxLng: -70.9 };
    expect(isInsideBBox({ latitude: 42.4, longitude: -71.0 }, bbox)).toBe(true);
    expect(isInsideBBox({ latitude: 42.3, longitude: -71.1 }, bbox)).toBe(true);
    expect(isInsideBBox({ latitude: 42.6, longitude: -71.0 }, bbox)).toBe(false);
    expect(isInsideBBox({ latitude: 42.4, longitude: -72.0 }, bbox)).toBe(false);
  });

  it('padBBox expands symmetrically by a fraction', () => {
    const padded = padBBox({ minLat: 0, minLng: 0, maxLat: 10, maxLng: 20 }, 0.1);
    expect(padded).toEqual({ minLat: -1, minLng: -2, maxLat: 11, maxLng: 22 });
  });
});

describe('unionBoundingBoxes', () => {
  it('returns undefined for an empty list', () => {
    expect(unionBoundingBoxes([])).toBeUndefined();
  });

  it('returns the box itself for a single input', () => {
    const b = { minLat: 1, minLng: 2, maxLat: 3, maxLng: 4 };
    expect(unionBoundingBoxes([b])).toEqual(b);
  });

  it('computes the smallest box containing all inputs (disjoint boxes)', () => {
    const a = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };
    const b = { minLat: 5, minLng: 5, maxLat: 6, maxLng: 6 };
    expect(unionBoundingBoxes([a, b])).toEqual({ minLat: 0, minLng: 0, maxLat: 6, maxLng: 6 });
  });

  it('computes the union of overlapping boxes', () => {
    const a = { minLat: 0, minLng: 0, maxLat: 5, maxLng: 5 };
    const b = { minLat: 3, minLng: -2, maxLat: 8, maxLng: 4 };
    expect(unionBoundingBoxes([a, b])).toEqual({ minLat: 0, minLng: -2, maxLat: 8, maxLng: 5 });
  });

  it('handles three or more boxes', () => {
    const boxes = [
      { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      { minLat: -3, minLng: 2, maxLat: 0.5, maxLng: 6 },
      { minLat: 2, minLng: -1, maxLat: 4, maxLng: 0.5 },
    ];
    expect(unionBoundingBoxes(boxes)).toEqual({ minLat: -3, minLng: -1, maxLat: 4, maxLng: 6 });
  });
});

describe('coordinate validation (native-crash guard)', () => {
  it('accepts finite in-range coordinates', () => {
    expect(isValidLngLat([-71.0, 42.4])).toBe(true);
    expect(isValidLngLat([180, 90])).toBe(true);
    expect(isValidLngLat([-180, -90])).toBe(true);
    expect(isValidLngLat([0, 0])).toBe(true);
  });

  it('rejects non-finite and out-of-range coordinates', () => {
    expect(isValidLngLat([NaN, 42])).toBe(false);
    expect(isValidLngLat([0, Infinity])).toBe(false);
    expect(isValidLngLat([0, -Infinity])).toBe(false);
    expect(isValidLngLat([181, 0])).toBe(false);
    expect(isValidLngLat([0, 91])).toBe(false);
    // The real-world bug: a degenerate viewport extrapolated to a full page
    // produces finite but absurd corners that crash MapLibre natively.
    expect(isValidLngLat([-71, 5000])).toBe(false);
  });

  it('cornersAreValid is true only when every corner is valid', () => {
    const good: CornerCoordinates = {
      topLeft: [-71.1, 42.5],
      topRight: [-70.9, 42.5],
      bottomRight: [-70.9, 42.3],
      bottomLeft: [-71.1, 42.3],
    };
    expect(cornersAreValid(good)).toBe(true);
    expect(cornersAreValid({ ...good, bottomLeft: [-71.1, 9000] })).toBe(false);
    expect(cornersAreValid({ ...good, topRight: [NaN, 42.5] })).toBe(false);
  });

  it('isDegenerateBBox flags near-zero-area extents', () => {
    // A real map sheet (~5 km) is fine.
    expect(isDegenerateBBox({ minLat: 47.6, minLng: -71.2, maxLat: 47.8, maxLng: -71.0 })).toBe(
      false,
    );
    // The real bug: a viewport that collapsed to a sub-arcsecond point (these
    // are the actual corners the broken GPTS reprojection produced — spans ~4e-7°).
    expect(
      isDegenerateBBox({
        minLat: 0.00043013738869937854,
        minLng: -73.48938127178322,
        maxLat: 0.00043056141624172646,
        maxLng: -73.489380344438,
      }),
    ).toBe(true);
    // Degenerate in only one axis (a line) still counts.
    expect(isDegenerateBBox({ minLat: 47.6, minLng: -71.0, maxLat: 47.8, maxLng: -71.0 })).toBe(
      true,
    );
  });
});

describe('initialBearingDeg', () => {
  it('reads due north / east / south / west off the cardinal offsets', () => {
    const at = { latitude: 46.8139, longitude: -71.2082 };
    expect(initialBearingDeg(at, { ...at, latitude: at.latitude + 0.1 })).toBeCloseTo(0, 6);
    expect(initialBearingDeg(at, { ...at, longitude: at.longitude + 0.1 })).toBeCloseTo(90, 1);
    expect(initialBearingDeg(at, { ...at, latitude: at.latitude - 0.1 })).toBeCloseTo(180, 6);
    expect(initialBearingDeg(at, { ...at, longitude: at.longitude - 0.1 })).toBeCloseTo(270, 1);
  });

  it('always reports a compass bearing in [0, 360)', () => {
    const at = { latitude: 46.8139, longitude: -71.2082 };
    for (let d = 0; d < 360; d += 17) {
      const r = (d * Math.PI) / 180;
      const to = {
        latitude: at.latitude + 0.05 * Math.cos(r),
        longitude: at.longitude + 0.05 * Math.sin(r),
      };
      const b = initialBearingDeg(at, to);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });

  it('is the initial bearing of a great circle, not the rhumb line', () => {
    // The classic worked example (Baltimore -> Kansas City, same latitude):
    // the great circle bows poleward, so it departs at 273°39', not due west.
    const b = initialBearingDeg(
      { latitude: 39.099912, longitude: -76.348327 },
      { latitude: 39.099912, longitude: -94.581213 },
    );
    expect(b).toBeGreaterThan(270); // a rhumb line would read exactly 270
    expect(b).toBeCloseTo(275.78, 1);
  });

  it('handles the antimeridian without wrapping the long way round', () => {
    const b = initialBearingDeg(
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    );
    expect(b).toBeCloseTo(90, 4);
  });

  it('returns 0 for coincident points instead of NaN', () => {
    const at = { latitude: 46.8139, longitude: -71.2082 };
    expect(initialBearingDeg(at, { ...at })).toBe(0);
  });
});
