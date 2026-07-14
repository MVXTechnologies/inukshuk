import {
  tileCountForRegion,
  overviewZoomFor,
  estimateBytes,
  estimateBytesForBasemaps,
  tileSpanAtZoom,
  offlinePackMaxZoom,
  OFFLINE_PACK_FALLBACK_MAX_ZOOM,
} from './tiles';
import type { BoundingBox } from '@core/models';

const world: BoundingBox = { minLat: -85, minLng: -180, maxLat: 85, maxLng: 180 };
const small: BoundingBox = { minLat: 46.8, minLng: -71.22, maxLat: 46.83, maxLng: -71.18 };

it('counts 1 tile for the whole world at z0', () => {
  expect(tileCountForRegion(world, 0, 0)).toBe(1);
});

it('counts the covering tiles across a zoom range (monotonic, > the single top)', () => {
  const z10to12 = tileCountForRegion(small, 10, 12);
  const z10to11 = tileCountForRegion(small, 10, 11);
  expect(z10to12).toBeGreaterThan(z10to11);
  expect(tileCountForRegion(small, 10, 10)).toBeGreaterThanOrEqual(1);
});

it('overviewZoomFor returns the highest zoom whose per-axis span still fits maxTilesPerSide', () => {
  const maxPerSide = 2;
  const z = overviewZoomFor(small, maxPerSide);
  expect(z).toBeGreaterThanOrEqual(0);
  expect(z).toBeLessThanOrEqual(17);

  // The returned zoom's span actually fits within the budget on both axes.
  const [xSpan, ySpan] = tileSpanAtZoom(small, z);
  expect(xSpan).toBeLessThanOrEqual(maxPerSide);
  expect(ySpan).toBeLessThanOrEqual(maxPerSide);

  // And it is the *highest* such zoom: one step deeper must exceed the budget
  // (unless we're already clamped at the max zoom of 17).
  if (z < 17) {
    const [xNext, yNext] = tileSpanAtZoom(small, z + 1);
    expect(Math.max(xNext, yNext)).toBeGreaterThan(maxPerSide);
  }
});

it('estimateBytes scales with tile count and basemap', () => {
  expect(estimateBytes(100, 'map')).toBeGreaterThan(0);
  expect(estimateBytes(200, 'map')).toBeCloseTo(2 * estimateBytes(100, 'map'));
  expect(estimateBytes(100, 'satellite')).toBeGreaterThan(estimateBytes(100, 'map'));
  expect(estimateBytes(100, 'relief')).toBeGreaterThan(estimateBytes(100, 'map'));
});

it('estimateBytesForBasemaps sums each basemap at the same tile count', () => {
  expect(estimateBytesForBasemaps(100, ['map'])).toBe(estimateBytes(100, 'map'));
  expect(estimateBytesForBasemaps(100, ['map', 'satellite'])).toBe(
    estimateBytes(100, 'map') + estimateBytes(100, 'satellite'),
  );
  expect(estimateBytesForBasemaps(100, [])).toBe(0);
});

describe('offlinePackMaxZoom', () => {
  it('returns the shallowest max zoom among packs of the requested basemap', () => {
    const packs = [
      { basemap: 'map' as const, maxZoom: 17 },
      { basemap: 'map' as const, maxZoom: 15 },
      { basemap: 'satellite' as const, maxZoom: 16 },
    ];
    expect(offlinePackMaxZoom(packs, 'map')).toBe(15);
    expect(offlinePackMaxZoom(packs, 'satellite')).toBe(16);
  });

  it('assumes the fallback zoom for legacy packs without a recorded max zoom', () => {
    const packs = [{ basemap: 'map' as const }, { basemap: 'map' as const, maxZoom: 17 }];
    expect(offlinePackMaxZoom(packs, 'map')).toBe(OFFLINE_PACK_FALLBACK_MAX_ZOOM);
  });

  it('falls back when no packs exist for the basemap', () => {
    expect(offlinePackMaxZoom([], 'relief')).toBe(OFFLINE_PACK_FALLBACK_MAX_ZOOM);
    expect(offlinePackMaxZoom([{ basemap: 'map', maxZoom: 17 }], 'relief')).toBe(
      OFFLINE_PACK_FALLBACK_MAX_ZOOM,
    );
  });
});
