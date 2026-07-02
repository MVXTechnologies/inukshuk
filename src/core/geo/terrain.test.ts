import type { BoundingBox } from '@core/models';

import {
  clampTileRange,
  lngLatToTile,
  padBbox,
  pickTerrainZoom,
  rangeBbox,
  sampleGridBilinear,
  terrariumToMeters,
  tileCount,
  tileRangeForBbox,
  tileToLngLat,
} from './terrain';

describe('lngLatToTile', () => {
  it('maps the world centre to the middle of the single z=0 tile', () => {
    expect(lngLatToTile(0, 0, 0)).toEqual({ x: 0.5, y: 0.5 });
  });
  it('maps the NW extreme to the origin tile', () => {
    const t = lngLatToTile(-180, 85.0511, 2);
    expect(Math.floor(t.x)).toBe(0);
    expect(Math.floor(t.y)).toBe(0);
  });
});

describe('terrariumToMeters', () => {
  it('decodes the zero-elevation reference', () => {
    expect(terrariumToMeters(128, 0, 0)).toBe(0);
  });
  it('decodes a positive elevation', () => {
    expect(terrariumToMeters(129, 0, 0)).toBe(256); // +1 in the high byte = +256 m
    expect(terrariumToMeters(128, 100, 0)).toBe(100);
  });
});

describe('tileToLngLat', () => {
  it('inverts lngLatToTile', () => {
    const z = 12;
    const t = lngLatToTile(-71.31, 46.81, z);
    const back = tileToLngLat(t.x, t.y, z);
    expect(back.lng).toBeCloseTo(-71.31, 4);
    expect(back.lat).toBeCloseTo(46.81, 4);
  });
  it('rangeBbox contains the source bbox', () => {
    const bbox = { minLat: 46.8, minLng: -71.32, maxLat: 46.82, maxLng: -71.3 };
    const cov = rangeBbox(tileRangeForBbox(bbox, 13));
    expect(cov.minLng).toBeLessThanOrEqual(bbox.minLng);
    expect(cov.maxLng).toBeGreaterThanOrEqual(bbox.maxLng);
    expect(cov.minLat).toBeLessThanOrEqual(bbox.minLat);
    expect(cov.maxLat).toBeGreaterThanOrEqual(bbox.maxLat);
  });
});

describe('sampleGridBilinear', () => {
  const grid = [0, 10, 20, 30]; // 2x2: rows [0,10] / [20,30]
  it('returns corner values exactly', () => {
    expect(sampleGridBilinear(grid, 2, 2, 0, 0)).toBe(0);
    expect(sampleGridBilinear(grid, 2, 2, 1, 0)).toBe(10);
    expect(sampleGridBilinear(grid, 2, 2, 1, 1)).toBe(30);
  });
  it('interpolates the centre', () => {
    expect(sampleGridBilinear(grid, 2, 2, 0.5, 0.5)).toBe(15);
  });
});

describe('tileRangeForBbox / pickTerrainZoom', () => {
  const bbox: BoundingBox = { minLat: 46.8, minLng: -71.32, maxLat: 46.82, maxLng: -71.3 };

  it('returns an inclusive range that contains the corners', () => {
    const r = tileRangeForBbox(bbox, 13);
    expect(r.minX).toBeLessThanOrEqual(r.maxX);
    expect(r.minY).toBeLessThanOrEqual(r.maxY);
  });

  it('keeps a small bbox within the tile budget and prefers detail', () => {
    const z = pickTerrainZoom(bbox, 4);
    const c = tileCount(tileRangeForBbox(bbox, z));
    expect(c.wide).toBeLessThanOrEqual(4);
    expect(c.high).toBeLessThanOrEqual(4);
    expect(z).toBeGreaterThanOrEqual(12); // a ~2 km bbox should still get high zoom
  });

  it('drops zoom for a large bbox to respect the budget', () => {
    const big: BoundingBox = { minLat: 45, minLng: -73, maxLat: 47, maxLng: -71 };
    const z = pickTerrainZoom(big, 4);
    const c = tileCount(tileRangeForBbox(big, z));
    expect(c.wide).toBeLessThanOrEqual(4);
    expect(c.high).toBeLessThanOrEqual(4);
  });
});

describe('padBbox', () => {
  const box: BoundingBox = { minLat: 45.5, maxLat: 45.51, minLng: -73.6, maxLng: -73.58 };

  it('expands outward, keeping the same centre', () => {
    const p = padBbox(box, 0.5, 0);
    expect(p.minLat).toBeLessThan(box.minLat);
    expect(p.maxLat).toBeGreaterThan(box.maxLat);
    expect(p.minLng).toBeLessThan(box.minLng);
    expect(p.maxLng).toBeGreaterThan(box.maxLng);
    expect((p.minLat + p.maxLat) / 2).toBeCloseTo((box.minLat + box.maxLat) / 2, 6);
    expect((p.minLng + p.maxLng) / 2).toBeCloseTo((box.minLng + box.maxLng) / 2, 6);
  });

  it('enforces a minimum span for tiny trails', () => {
    const tiny: BoundingBox = { minLat: 45.5, maxLat: 45.5001, minLng: -73.6, maxLng: -73.5999 };
    const p = padBbox(tiny, 0.6, 2000);
    const mPerDegLat = 111320;
    const spanLatM = (p.maxLat - p.minLat) * mPerDegLat;
    expect(spanLatM).toBeGreaterThanOrEqual(2000 - 1);
  });
});

describe('clampTileRange', () => {
  it('returns in-budget ranges unchanged', () => {
    const r = { z: 10, minX: 5, maxX: 8, minY: 3, maxY: 6 };
    expect(clampTileRange(r, 6)).toEqual(r);
  });

  it('crops a continent-sized range around its centre to the budget', () => {
    // A 2000 km bbox at zMin still spans ~20 tiles per side — the fetch budget
    // must bound it (this is the 3D-view OOM guard).
    const bbox: BoundingBox = { minLng: -80, minLat: 40, maxLng: -55, maxLat: 58 };
    const r = tileRangeForBbox(bbox, 8);
    expect(r.maxX - r.minX + 1).toBeGreaterThan(6);
    const c = clampTileRange(r, 6);
    expect(c.maxX - c.minX + 1).toBe(6);
    expect(c.maxY - c.minY + 1).toBe(6);
    // Cropped window stays inside the original range, centred on it.
    expect(c.minX).toBeGreaterThanOrEqual(r.minX);
    expect(c.maxX).toBeLessThanOrEqual(r.maxX);
    expect(c.minY).toBeGreaterThanOrEqual(r.minY);
    expect(c.maxY).toBeLessThanOrEqual(r.maxY);
  });
});
