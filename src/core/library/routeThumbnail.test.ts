import {
  buildRouteThumbnail,
  decimate,
  fitToSquare,
  simplifyPolyline,
  toSvgPath,
} from './routeThumbnail';

const opts = { size: 56, padding: 8, maxPoints: 64 };

describe('decimate', () => {
  it('returns a copy when already under the limit', () => {
    const pts = [1, 2, 3];
    const out = decimate(pts, 5);
    expect(out).toEqual([1, 2, 3]);
    expect(out).not.toBe(pts);
  });

  it('keeps the first and last points and hits the limit exactly', () => {
    const pts = Array.from({ length: 1001 }, (_, i) => i);
    const out = decimate(pts, 11);
    expect(out).toHaveLength(11);
    expect(out[0]).toBe(0);
    expect(out[10]).toBe(1000);
  });
});

describe('simplifyPolyline', () => {
  it('drops collinear interior points', () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i }));
    expect(simplifyPolyline(line, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 49, y: 49 },
    ]);
  });

  it('keeps a corner that deviates beyond the tolerance', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0.1 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(simplifyPolyline(pts, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it('passes short inputs through', () => {
    expect(simplifyPolyline([{ x: 1, y: 2 }], 1)).toEqual([{ x: 1, y: 2 }]);
  });
});

describe('fitToSquare', () => {
  it('fills the longer side and centres the shorter one', () => {
    // An east–west line at the equator: width fills, height centred.
    const pts = fitToSquare(
      [
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: 1 },
      ],
      56,
      8,
    );
    expect(pts[0]).toEqual({ x: 8, y: 28 });
    expect(pts[1]?.x).toBeCloseTo(48);
    expect(pts[1]?.y).toBeCloseTo(28);
  });

  it('puts north at the top', () => {
    const pts = fitToSquare(
      [
        { latitude: 46, longitude: -71 },
        { latitude: 47, longitude: -71 },
      ],
      56,
      8,
    );
    expect(pts[0]?.y).toBeGreaterThan(pts[1]?.y ?? Infinity);
  });

  it('corrects longitude for latitude (a square in metres stays square)', () => {
    const lat = 60; // cos 60° = 0.5: 2° of longitude ≈ 1° of latitude
    const pts = fitToSquare(
      [
        { latitude: lat - 0.5, longitude: -1 },
        { latitude: lat + 0.5, longitude: 1 },
      ],
      56,
      8,
    );
    const w = Math.abs((pts[1]?.x ?? 0) - (pts[0]?.x ?? 0));
    const h = Math.abs((pts[1]?.y ?? 0) - (pts[0]?.y ?? 0));
    expect(w / h).toBeCloseTo(1, 1);
  });
});

describe('toSvgPath', () => {
  it('emits M then L commands rounded to 0.1 px', () => {
    expect(
      toSvgPath([
        { x: 1.234, y: 5.67 },
        { x: 10, y: 20.05 },
      ]),
    ).toBe('M1.2 5.7 L10 20.1');
  });
});

describe('buildRouteThumbnail', () => {
  it('returns null when there is nothing drawable', () => {
    expect(buildRouteThumbnail([], opts)).toBeNull();
    expect(buildRouteThumbnail([{ latitude: NaN, longitude: 0 }], opts)).toBeNull();
    expect(buildRouteThumbnail([{ latitude: 95, longitude: 0 }], opts)).toBeNull();
  });

  it('centres a single fix and still yields a path', () => {
    const thumb = buildRouteThumbnail([{ latitude: 46.8, longitude: -71.2 }], opts);
    expect(thumb?.start).toEqual({ x: 28, y: 28 });
    expect(thumb?.path).toBe('M28 28 L28 28');
  });

  it('simplifies a long wiggly track to the point budget, inside the padding', () => {
    const coords = Array.from({ length: 20000 }, (_, i) => ({
      latitude: 46.8 + Math.sin(i / 50) * 0.01 + i * 1e-6,
      longitude: -71.2 + Math.cos(i / 70) * 0.01,
    }));
    const thumb = buildRouteThumbnail(coords, { size: 56, padding: 8, maxPoints: 24 });
    expect(thumb).not.toBeNull();
    expect(thumb?.pointCount).toBeLessThanOrEqual(24);
    expect(thumb?.pointCount).toBeGreaterThanOrEqual(2);
    const numbers = (thumb?.path ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    for (const n of numbers) {
      expect(n).toBeGreaterThanOrEqual(8 - 0.05);
      expect(n).toBeLessThanOrEqual(48 + 0.05);
    }
  });

  it('starts the path at the first valid fix', () => {
    const thumb = buildRouteThumbnail(
      [
        { latitude: NaN, longitude: NaN },
        { latitude: 46, longitude: -71 },
        { latitude: 46.01, longitude: -71 },
      ],
      opts,
    );
    // The start (southern point) is at the bottom of the box.
    expect(thumb?.start.y).toBeCloseTo(48);
    expect(thumb?.path.startsWith('M28 48')).toBe(true);
  });
});
