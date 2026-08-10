import type { FloatGrid } from './floatTiff';
import {
  DEPTH_MAX_GRID_DIM,
  DEPTH_MAX_VIEW_SPAN_DEG,
  depthChartCacheKey,
  depthCoverageUrl,
  depthFetchBbox,
  depthPointUrl,
  formatDepthReadout,
  isDepthNoData,
  latToMercY,
  lonToMercX,
  mercXToLon,
  mercYToLat,
  nearestValidDepth,
  needsDepthReanchor,
  NONNA_NODATA,
} from './marineDepth';

const grid = (width: number, height: number, values: number[]): FloatGrid => ({
  width,
  height,
  data: Float32Array.from(values),
  x0: 0,
  y0: 0,
  dx: 1,
  dy: 1,
});

describe('mercator conversions', () => {
  it('round-trips the plan reference point', () => {
    expect(mercXToLon(lonToMercX(-71.21338))).toBeCloseTo(-71.21338, 9);
    expect(mercYToLat(latToMercY(46.78502))).toBeCloseTo(46.78502, 9);
  });

  it('matches the live probe values at Québec', () => {
    expect(lonToMercX(-71.21338)).toBeCloseTo(-7927437.2, 0);
    expect(latToMercY(46.78502)).toBeCloseTo(5907054.19, 0);
  });

  it('clamps latitude to the mercator limit', () => {
    expect(latToMercY(89)).toBe(latToMercY(85.06));
    expect(Number.isFinite(latToMercY(90))).toBe(true);
  });
});

describe('depthFetchBbox', () => {
  const view = { west: -71.3, south: 46.75, east: -71.1, north: 46.85 };

  it('pads and quantizes around the viewport centre', () => {
    const b = depthFetchBbox(view);
    expect(b).not.toBeNull();
    if (!b) return;
    expect(b.west).toBeLessThan(view.west);
    expect(b.east).toBeGreaterThan(view.east);
    expect(b.south).toBeLessThan(view.south);
    expect(b.north).toBeGreaterThan(view.north);
    // Quantized to 0.05°: nearby viewports share the same anchor.
    const shifted = depthFetchBbox({
      west: view.west + 0.004,
      south: view.south + 0.004,
      east: view.east + 0.004,
      north: view.north + 0.004,
    });
    expect(shifted).toEqual(b);
  });

  it('rejects over-wide viewports (chart-blue fill carries the look)', () => {
    expect(
      depthFetchBbox({ west: -75, south: 44, east: -75 + DEPTH_MAX_VIEW_SPAN_DEG + 1, north: 47 }),
    ).toBeNull();
  });

  it('rejects degenerate and antimeridian-crossing views', () => {
    expect(depthFetchBbox({ west: -71, south: 47, east: -71, north: 47 })).toBeNull();
    expect(depthFetchBbox({ west: 179, south: 40, east: 181, north: 41 })).toBeNull();
  });
});

describe('needsDepthReanchor', () => {
  const anchor = { west: -72, south: 46, east: -70, north: 48 };

  it('stays anchored while the view sits inside', () => {
    expect(needsDepthReanchor(anchor, { west: -71.5, south: 46.5, east: -70.5, north: 47.5 })).toBe(
      false,
    );
  });

  it('re-anchors when the view escapes', () => {
    expect(needsDepthReanchor(anchor, { west: -72.5, south: 46.5, east: -71, north: 47 })).toBe(
      true,
    );
  });

  it('re-anchors on a deep zoom-in', () => {
    expect(
      needsDepthReanchor(anchor, { west: -71.05, south: 46.95, east: -70.95, north: 47.05 }),
    ).toBe(true);
  });
});

describe('depthCoverageUrl', () => {
  const bbox = { west: -71.3, south: 46.75, east: -71.1, north: 46.85 };

  it('subsets in mercator metres against the live endpoint', () => {
    const url = depthCoverageUrl('nonna10', bbox);
    expect(url).toContain('nonna-geoserver.data.chs-shc.ca');
    expect(url).toContain('request=GetCoverage');
    expect(url).toContain(encodeURIComponent('nonna__NONNA 10 Coverage'));
    expect(url).toContain(`subset=x(${lonToMercX(bbox.west).toFixed(1)}`);
    expect(url).toContain('format=image/tiff');
  });

  it('adds a proportional scalesize once the native grid exceeds the cap', () => {
    // ~0.2° of longitude at 46.8°N ≈ 22 km ≈ 1166 native cells — over the cap.
    const url = depthCoverageUrl('nonna10', bbox);
    const m = /scalesize=i\((\d+)\),j\((\d+)\)/.exec(url);
    expect(m).not.toBeNull();
    const i = Number(m?.[1]);
    const j = Number(m?.[2]);
    expect(Math.max(i, j)).toBeLessThanOrEqual(DEPTH_MAX_GRID_DIM);
    expect(Math.max(i, j)).toBe(DEPTH_MAX_GRID_DIM);
    // Aspect preserved within rounding.
    expect(i / j).toBeCloseTo(1166 / 851, 1);
  });

  it('skips scalesize for small subsets', () => {
    const url = depthCoverageUrl('nonna10', {
      west: -71.21,
      south: 46.78,
      east: -71.2,
      north: 46.79,
    });
    expect(url).not.toContain('scalesize');
  });
});

describe('depthPointUrl', () => {
  it('asks for a 3×3 neighbourhood around the point', () => {
    const url = depthPointUrl('nonna10', 46.78502, -71.21338);
    const mx = /subset=x\((-?\d+\.\d),(-?\d+\.\d)\)/.exec(url);
    expect(mx).not.toBeNull();
    const span = Number(mx?.[2]) - Number(mx?.[1]);
    expect(span).toBeCloseTo(19.0986 * 3, 0);
  });

  it('uses the coarse coverage cell size for NONNA 100', () => {
    const url = depthPointUrl('nonna100', 46.78502, -71.21338);
    const mx = /subset=x\((-?\d+\.\d),(-?\d+\.\d)\)/.exec(url);
    const span = Number(mx?.[2]) - Number(mx?.[1]);
    expect(span).toBeCloseTo(19.0986 * 8 * 3, 0);
  });
});

describe('nearestValidDepth', () => {
  it('prefers the centre cell', () => {
    expect(nearestValidDepth(grid(3, 3, [-1, -2, -3, -4, -26.5, -6, -7, -8, -9]))).toBe(-26.5);
  });

  it('steps over a nodata centre (seam line) to the nearest valid cell', () => {
    const g = grid(3, 3, [
      NONNA_NODATA,
      NONNA_NODATA,
      NONNA_NODATA,
      NONNA_NODATA,
      NONNA_NODATA,
      -12.5,
      NONNA_NODATA,
      NONNA_NODATA,
      -99,
    ]);
    expect(nearestValidDepth(g)).toBe(-12.5);
  });

  it('answers null when the whole neighbourhood is nodata (land tap)', () => {
    expect(nearestValidDepth(grid(3, 3, Array<number>(9).fill(NONNA_NODATA)))).toBeNull();
  });
});

describe('isDepthNoData', () => {
  it('flags the nilValue, junk and undefined', () => {
    expect(isDepthNoData(NONNA_NODATA)).toBe(true);
    expect(isDepthNoData(-NONNA_NODATA)).toBe(true);
    expect(isDepthNoData(Number.NaN)).toBe(true);
    expect(isDepthNoData(undefined)).toBe(true);
    expect(isDepthNoData(-26.5)).toBe(false);
    expect(isDepthNoData(3.8)).toBe(false);
  });
});

describe('formatDepthReadout', () => {
  it('formats a depth below chart datum', () => {
    expect(formatDepthReadout(-26.469, false)).toBe('Depth 26.5 m · chart datum');
  });

  it('formats a drying height', () => {
    expect(formatDepthReadout(3.81, false)).toBe('Drying 3.8 m · chart datum');
  });

  it('converts to feet under imperial units', () => {
    expect(formatDepthReadout(-10, true)).toBe('Depth 32.8 ft · chart datum');
  });
});

describe('depthChartCacheKey', () => {
  it('is stable per quantized bbox', () => {
    const b = { west: -71.35, south: 46.7, east: -71.05, north: 46.9 };
    expect(depthChartCacheKey(b)).toBe('-71.35,46.70,-71.05,46.90');
  });
});
