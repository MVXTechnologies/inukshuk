import type { FloatGrid } from './floatTiff';
import {
  DEPTH_BANDS,
  depthBandIndex,
  depthChartCorners,
  infillSeams,
  renderDepthChart,
  selectSoundings,
  soundingLabel,
  soundingsFeatureCollection,
} from './depthChart';
import { NONNA_NODATA, latToMercY, lonToMercX } from './marineDepth';

/** A grid anchored near Québec (mercator metres), NONNA value convention. */
function grid(width: number, height: number, values: number[], cell = 20): FloatGrid {
  return {
    width,
    height,
    data: Float32Array.from(values),
    x0: lonToMercX(-71.3),
    y0: latToMercY(46.9),
    dx: cell,
    dy: cell,
  };
}

describe('depthBandIndex', () => {
  it('maps drying, shallow and deep depths to the chart bands', () => {
    expect(depthBandIndex(-1.2)).toBe(0); // drying green
    expect(depthBandIndex(0)).toBe(1); // 0–2 m
    expect(depthBandIndex(1.9)).toBe(1);
    expect(depthBandIndex(2)).toBe(2); // 2–5 m
    expect(depthBandIndex(7)).toBe(3); // 5–10 m
    expect(depthBandIndex(10)).toBe(4); // chart white
    expect(depthBandIndex(80)).toBe(4);
    expect(DEPTH_BANDS[depthBandIndex(80)]?.maxDepthM).toBe(Infinity);
  });
});

describe('infillSeams', () => {
  it('heals a 1-px vertical nodata seam', () => {
    const g = grid(3, 3, [-10, NONNA_NODATA, -12, -10, NONNA_NODATA, -12, -10, NONNA_NODATA, -12]);
    const healed = infillSeams(g);
    expect(healed.data[1]).toBeCloseTo(-11, 5);
    expect(healed.data[4]).toBeCloseTo(-11, 5);
    // Input untouched.
    expect(g.data[1]).toBe(Float32Array.from([NONNA_NODATA])[0]);
  });

  it('does not grow water over a coast edge (valid on one side only)', () => {
    const g = grid(3, 1, [-10, NONNA_NODATA, NONNA_NODATA]);
    const healed = infillSeams(g);
    expect(healed.data[1]).toBe(g.data[1]);
    expect(healed.data[2]).toBe(g.data[2]);
  });

  it('closes a seam crossing on the second pass', () => {
    // A vertical and a horizontal seam crossing at the centre cell: pass 1
    // heals the arms, pass 2 the intersection (nodata on all 4 sides).
    const nd = NONNA_NODATA;
    const g = grid(5, 5, [
      ...[-10, -10, nd, -10, -10],
      ...[-10, -10, nd, -10, -10],
      ...[nd, nd, nd, nd, nd],
      ...[-14, -14, nd, -14, -14],
      ...[-14, -14, nd, -14, -14],
    ]);
    const healed = infillSeams(g);
    expect(healed.data[12]).toBeLessThan(-9);
    expect(healed.data[12]).toBeGreaterThan(-15);
  });
});

describe('renderDepthChart', () => {
  it('renders bands at 2× the grid resolution with transparent no-data', () => {
    // Left half shallow (−1 m → 0–2 m band), right half nodata.
    const values = Array.from({ length: 64 }, (_, i) => (i % 8 < 4 ? -1 : NONNA_NODATA));
    const img = renderDepthChart(grid(8, 8, values), null);
    expect(img).not.toBeNull();
    if (!img) return;
    expect(img.width).toBe(16);
    expect(img.height).toBe(16);
    // A pixel well inside the shallow half wears the 0–2 m band colour.
    const o = (8 * img.width + 2) * 4;
    expect([img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]]).toEqual([0xa3, 0xc6, 0xe6]);
    expect(img.rgba[o + 3]).toBe(255);
    // A pixel in the nodata half is fully transparent.
    const oNo = (8 * img.width + 14) * 4;
    expect(img.rgba[oNo + 3]).toBe(0);
  });

  it('draws a contour line where the depth crosses a chart level', () => {
    // Left half 4 m deep, right half 8 m deep → the 5 m contour runs between.
    const values = Array.from({ length: 256 }, (_, i) => (i % 16 < 8 ? -4 : -8));
    const img = renderDepthChart(grid(16, 16, values), null);
    expect(img).not.toBeNull();
    if (!img) return;
    // Scan the middle row for the contour ink.
    let contourPixels = 0;
    for (let px = 0; px < img.width; px++) {
      const o = (16 * img.width + px) * 4;
      if (img.rgba[o] === 0x2a && img.rgba[o + 1] === 0x36 && img.rgba[o + 2] === 0x40) {
        contourPixels++;
      }
    }
    expect(contourPixels).toBeGreaterThan(0);
    expect(contourPixels).toBeLessThan(img.width / 2); // a line, not a flood
  });

  it('composites the coarse grid under the dense grid fringe', () => {
    // Dense grid: all nodata. Coarse grid covering the same area: 3 m deep.
    const dense = grid(8, 8, Array<number>(64).fill(NONNA_NODATA));
    const coarse: FloatGrid = { ...grid(4, 4, Array<number>(16).fill(-3)), dx: 40, dy: 40 };
    const img = renderDepthChart(dense, coarse);
    expect(img).not.toBeNull();
    if (!img) return;
    const o = (8 * img.width + 8) * 4;
    // 3 m → the 2–5 m band.
    expect([img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]]).toEqual([0xbd, 0xd8, 0xef]);
  });

  it('rejects degenerate grids', () => {
    expect(renderDepthChart(grid(1, 1, [-5]), null)).toBeNull();
  });
});

describe('depthChartCorners', () => {
  it('returns exact mercator-aligned corners in ImageSource order', () => {
    const g = grid(10, 5, Array<number>(50).fill(-5));
    const [tl, tr, br, bl] = depthChartCorners(g);
    expect(tl[0]).toBeCloseTo(-71.3, 6);
    expect(tl[1]).toBeCloseTo(46.9, 6);
    expect(tr[0]).toBeGreaterThan(tl[0]);
    expect(tr[1]).toBe(tl[1]);
    expect(br[0]).toBe(tr[0]);
    expect(br[1]).toBeLessThan(tr[1]);
    expect(bl[0]).toBe(tl[0]);
    expect(bl[1]).toBe(br[1]);
  });
});

describe('selectSoundings', () => {
  it('picks the controlling (shallowest) cell per block', () => {
    // One block (26-cell blocks; 8×8 grid = a single block): shallowest is −2.5.
    const values = Array.from({ length: 64 }, (_, i) => (i === 27 ? -2.5 : -20));
    const soundings = selectSoundings(grid(8, 8, values), null);
    expect(soundings).toHaveLength(1);
    expect(soundings[0]?.depthM).toBeCloseTo(2.5, 5);
  });

  it('skips all-nodata blocks without a coarse fallback', () => {
    expect(selectSoundings(grid(8, 8, Array<number>(64).fill(NONNA_NODATA)), null)).toHaveLength(0);
  });

  it('falls back to the coarse composite where the dense grid is empty', () => {
    const dense = grid(8, 8, Array<number>(64).fill(NONNA_NODATA));
    const coarse: FloatGrid = { ...grid(4, 4, Array<number>(16).fill(-42)), dx: 40, dy: 40 };
    const soundings = selectSoundings(dense, coarse);
    expect(soundings).toHaveLength(1);
    expect(soundings[0]?.depthM).toBeCloseTo(42, 4);
  });
});

describe('soundingLabel', () => {
  it('keeps one decimal on shallow soundings, whole numbers deep', () => {
    expect(soundingLabel(26.47, false)).toBe('26.5');
    expect(soundingLabel(65.61, false)).toBe('66');
    expect(soundingLabel(4, false)).toBe('4');
  });

  it('brackets drying heights', () => {
    expect(soundingLabel(-1.24, false)).toBe('(1.2)');
  });

  it('converts to feet under imperial units', () => {
    expect(soundingLabel(20, true)).toBe('66');
    expect(soundingLabel(5, true)).toBe('16.4');
  });
});

describe('soundingsFeatureCollection', () => {
  it('builds labelled point features with shallow-first sort keys', () => {
    const fc = soundingsFeatureCollection(
      [
        { lon: -71.2, lat: 46.8, depthM: 3.2 },
        { lon: -71.21, lat: 46.81, depthM: 26.5 },
      ],
      false,
    );
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]?.properties.label).toBe('3.2');
    expect(fc.features[0]?.properties.shallow).toBe(1);
    expect(fc.features[1]?.properties.shallow).toBe(0);
    expect(fc.features[0]?.properties.sort).toBeLessThan(fc.features[1]?.properties.sort ?? -1);
    expect(fc.features[0]?.geometry.coordinates).toEqual([-71.2, 46.8]);
  });
});
