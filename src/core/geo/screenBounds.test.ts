import {
  latToMercatorY,
  mercatorYToLat,
  screenPointToLngLat,
  screenRectToBounds,
  type VisibleBounds,
} from './screenBounds';

// A 400×800 px map showing a slice of southern Québec.
const VIEWPORT = { w: 400, h: 800 };
const VISIBLE: VisibleBounds = [-73, 45, -72, 46]; // [west, south, east, north]

describe('mercator y', () => {
  it('round-trips latitudes', () => {
    for (const lat of [-84, -45, -0.0001, 0, 12.5, 45, 60, 84]) {
      expect(mercatorYToLat(latToMercatorY(lat))).toBeCloseTo(lat, 9);
    }
  });

  it('clamps beyond the mercator cut-off', () => {
    expect(latToMercatorY(90)).toBeCloseTo(latToMercatorY(85.05112878), 9);
    expect(latToMercatorY(-90)).toBeCloseTo(latToMercatorY(-85.05112878), 9);
  });
});

describe('screenPointToLngLat', () => {
  it('maps the viewport corners to the visible bounds corners', () => {
    expect(screenPointToLngLat({ x: 0, y: 0 }, VIEWPORT, VISIBLE)).toEqual([-73, 46]);
    const [lng, lat] = screenPointToLngLat({ x: 400, y: 800 }, VIEWPORT, VISIBLE) ?? [];
    expect(lng).toBeCloseTo(-72, 9);
    expect(lat).toBeCloseTo(45, 9);
  });

  it('is linear in mercator Y, not in latitude', () => {
    const mid = screenPointToLngLat({ x: 200, y: 400 }, VIEWPORT, VISIBLE);
    const expectedLat = mercatorYToLat((latToMercatorY(46) + latToMercatorY(45)) / 2);
    expect(mid?.[0]).toBeCloseTo(-72.5, 9);
    expect(mid?.[1]).toBeCloseTo(expectedLat, 9);
    // The naive latitude midpoint is measurably off — the old flat-earth
    // approximation; south of it, at these latitudes, by ~1e-3°.
    expect(mid?.[1]).not.toBeCloseTo(45.5, 3);
  });

  it('clamps points outside the viewport to its edges', () => {
    expect(screenPointToLngLat({ x: -50, y: -50 }, VIEWPORT, VISIBLE)).toEqual([-73, 46]);
    const [lng] = screenPointToLngLat({ x: 4000, y: 0 }, VIEWPORT, VISIBLE) ?? [];
    expect(lng).toBeCloseTo(-72, 9);
  });

  it('handles a view straddling the antimeridian', () => {
    const visible: VisibleBounds = [179, 0, -179, 1]; // 2° wide, wrapping
    const [lng] = screenPointToLngLat({ x: 200, y: 0 }, VIEWPORT, visible) ?? [];
    expect(lng).toBeCloseTo(-180, 9); // halfway across = the antimeridian itself
  });

  it('returns null before the viewport has been laid out', () => {
    expect(screenPointToLngLat({ x: 0, y: 0 }, { w: 0, h: 0 }, VISIBLE)).toBeNull();
  });
});

describe('screenRectToBounds', () => {
  it('maps a full-viewport rect back to the visible bounds', () => {
    const b = screenRectToBounds({ x: 0, y: 0, w: 400, h: 800 }, VIEWPORT, VISIBLE);
    expect(b?.minLng).toBeCloseTo(-73, 9);
    expect(b?.maxLng).toBeCloseTo(-72, 9);
    expect(b?.minLat).toBeCloseTo(45, 9);
    expect(b?.maxLat).toBeCloseTo(46, 9);
  });

  it('maps a sub-rect to exactly the area it frames — never larger', () => {
    // Centred rect covering half the width and a quarter of the height.
    const b = screenRectToBounds({ x: 100, y: 300, w: 200, h: 200 }, VIEWPORT, VISIBLE);
    expect(b).not.toBeNull();
    if (!b) return;

    expect(b.minLng).toBeCloseTo(-72.75, 9);
    expect(b.maxLng).toBeCloseTo(-72.25, 9);

    // Latitudes: mercator-interpolated at 3/8 and 5/8 down the viewport.
    const yTop = latToMercatorY(46);
    const yBottom = latToMercatorY(45);
    expect(b.maxLat).toBeCloseTo(mercatorYToLat(yTop + (300 / 800) * (yBottom - yTop)), 9);
    expect(b.minLat).toBeCloseTo(mercatorYToLat(yTop + (500 / 800) * (yBottom - yTop)), 9);

    // …and it is strictly inside the visible bounds.
    expect(b.minLng).toBeGreaterThan(-73);
    expect(b.maxLng).toBeLessThan(-72);
    expect(b.minLat).toBeGreaterThan(45);
    expect(b.maxLat).toBeLessThan(46);
  });

  it('scales with the rect: half the width covers half the longitude span', () => {
    const full = screenRectToBounds({ x: 0, y: 0, w: 400, h: 800 }, VIEWPORT, VISIBLE);
    const half = screenRectToBounds({ x: 0, y: 0, w: 200, h: 800 }, VIEWPORT, VISIBLE);
    if (!full || !half) throw new Error('expected bounds');
    expect(half.maxLng - half.minLng).toBeCloseTo((full.maxLng - full.minLng) / 2, 9);
  });

  it('returns null before the viewport has been laid out', () => {
    expect(screenRectToBounds({ x: 0, y: 0, w: 10, h: 10 }, { w: 0, h: 0 }, VISIBLE)).toBeNull();
  });
});
