import type { GeoReference } from '@core/models';
import { primaryGeoreferenceForPage, primaryGeoreferences } from './primary';

/**
 * The numbers in "picks the map, not the whole-continent locator inset" are
 * transcribed from a real Geoscience Australia AUSTopo sheet (Cook SH52-11,
 * eCat 148128) parsed with our own `parseGeoPdf`: three Adobe-geo viewports,
 * the locator listed FIRST. That ordering is why this module exists.
 */

function geo(
  pageIndex: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number },
): GeoReference {
  return {
    pageIndex,
    source: 'adobe-geo',
    pageWidthPt: 2383.93224,
    pageHeightPt: 1683.77616,
    viewport: {
      rect,
      corners: {
        topLeft: [bbox.minLng, bbox.maxLat],
        topRight: [bbox.maxLng, bbox.maxLat],
        bottomRight: [bbox.maxLng, bbox.minLat],
        bottomLeft: [bbox.minLng, bbox.minLat],
      },
    },
    bbox,
  };
}

// Cook SH52-11, in PDF order.
const AUSTOPO_LOCATOR = geo(
  0,
  { x0: 170.0784, y0: 1105.5096, x1: 311.8104, y1: 1247.2416 },
  { minLat: -49.49198, minLng: 111.06404, maxLat: -4.57622, maxLng: 155.9798 },
);
const AUSTOPO_MAP = geo(
  0,
  { x0: 340.1568, y0: 85.0392, x1: 2239.3656, y1: 1388.9736 },
  { minLat: -31.023055, minLng: 128.87709, maxLat: -29.975425, maxLng: 130.63052 },
);
const AUSTOPO_ADJOINING = geo(
  0,
  { x0: 51.02352, y0: 992.124, x1: 175.74768, y1: 1085.66712 },
  { minLat: -31.982727, minLng: 127.4491, maxLat: -28.980977, maxLng: 132.05797 },
);

describe('primaryGeoreferenceForPage', () => {
  it('picks the map, not the whole-continent locator inset listed before it', () => {
    const picked = primaryGeoreferenceForPage([AUSTOPO_LOCATOR, AUSTOPO_MAP, AUSTOPO_ADJOINING], 0);
    expect(picked).toBe(AUSTOPO_MAP);
    // Guard the consequence, not just the identity: the locator spans ~45° of
    // longitude (all of Australia); the real sheet spans ~1.75°.
    const spanLng = (picked?.bbox.maxLng ?? 0) - (picked?.bbox.minLng ?? 0);
    expect(spanLng).toBeLessThan(2);
  });

  it('is unchanged for a single-viewport document', () => {
    expect(primaryGeoreferenceForPage([AUSTOPO_MAP], 0)).toBe(AUSTOPO_MAP);
  });

  it('only considers the requested page', () => {
    const otherPage = geo(
      1,
      { x0: 0, y0: 0, x1: 9999, y1: 9999 },
      { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
    );
    expect(primaryGeoreferenceForPage([otherPage, AUSTOPO_MAP], 0)).toBe(AUSTOPO_MAP);
    expect(primaryGeoreferenceForPage([otherPage, AUSTOPO_MAP], 1)).toBe(otherPage);
  });

  it('returns undefined for a page with no georeference', () => {
    expect(primaryGeoreferenceForPage([AUSTOPO_MAP], 7)).toBeUndefined();
    expect(primaryGeoreferenceForPage([], 0)).toBeUndefined();
  });

  it('keeps the first of two equal-area frames, so the choice never flips', () => {
    const a = geo(
      0,
      { x0: 0, y0: 0, x1: 10, y1: 10 },
      { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
    );
    const b = geo(
      0,
      { x0: 20, y0: 20, x1: 30, y1: 30 },
      { minLat: 2, minLng: 2, maxLat: 3, maxLng: 3 },
    );
    expect(primaryGeoreferenceForPage([a, b], 0)).toBe(a);
    expect(primaryGeoreferenceForPage([b, a], 0)).toBe(b);
  });

  it('survives a degenerate rect rather than preferring it', () => {
    const degenerate = geo(
      0,
      { x0: 5, y0: 5, x1: Number.NaN, y1: 5 },
      { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
    );
    expect(primaryGeoreferenceForPage([degenerate, AUSTOPO_MAP], 0)).toBe(AUSTOPO_MAP);
  });
});

describe('primaryGeoreferences', () => {
  it('collapses a three-viewport page to one entry', () => {
    const primaries = primaryGeoreferences([AUSTOPO_LOCATOR, AUSTOPO_MAP, AUSTOPO_ADJOINING]);
    expect(primaries).toEqual([AUSTOPO_MAP]);
  });

  it('returns one entry per page, in ascending page order', () => {
    const p2 = geo(
      2,
      { x0: 0, y0: 0, x1: 50, y1: 50 },
      { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
    );
    const p1 = geo(
      1,
      { x0: 0, y0: 0, x1: 50, y1: 50 },
      { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
    );
    const primaries = primaryGeoreferences([p2, AUSTOPO_LOCATOR, AUSTOPO_MAP, p1]);
    expect(primaries.map((g) => g.pageIndex)).toEqual([0, 1, 2]);
    expect(primaries[0]).toBe(AUSTOPO_MAP);
  });

  it('is empty for an un-georeferenced document', () => {
    expect(primaryGeoreferences([])).toEqual([]);
  });
});
