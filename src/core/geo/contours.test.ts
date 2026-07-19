import { CONTOUR_MAJOR_EVERY, contourFeatures, effectiveContourInterval } from './contours';
import type { ContourGrid } from './contours';

const BBOX = { minLng: -71.3, minLat: 46.8, maxLng: -71.2, maxLat: 46.9 };

/** A north→south tilted plane: elevation depends only on the row. */
function plane(grid: number, northH: number, southH: number): ContourGrid {
  const data = new Float32Array(grid * grid);
  for (let y = 0; y < grid; y++) {
    const h = northH + ((southH - northH) * y) / (grid - 1);
    for (let x = 0; x < grid; x++) data[y * grid + x] = h;
  }
  return { data, grid, bbox: BBOX, minH: Math.min(northH, southH), maxH: Math.max(northH, southH) };
}

/** A radial cone peaking at the grid centre. */
function cone(grid: number, peakH: number): ContourGrid {
  const data = new Float32Array(grid * grid);
  const c = (grid - 1) / 2;
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      data[y * grid + x] = Math.max(0, peakH * (1 - d));
    }
  }
  return { data, grid, bbox: BBOX, minH: 0, maxH: peakH };
}

describe('effectiveContourInterval', () => {
  it('auto (0) delegates to the span-based interval', () => {
    expect(effectiveContourInterval(300, 0)).toBe(10);
    expect(effectiveContourInterval(2500, 0)).toBe(100);
  });

  it('honours an explicit interval when the level count is drawable', () => {
    expect(effectiveContourInterval(500, 25)).toBe(25);
  });

  it('steps a too-fine request up the ladder to keep levels bounded', () => {
    // 3000 m span at 10 m = 300 levels — must coarsen (3000/25 = 120 fits).
    expect(effectiveContourInterval(3000, 10)).toBe(25);
    // 60000 m span can't stay under the cap until 500 m.
    expect(effectiveContourInterval(60000, 10)).toBe(500);
  });
});

describe('contourFeatures', () => {
  it('contours a tilted plane into horizontal lines at the right latitudes', () => {
    const hm = plane(33, 0, 320); // north 0 m … south 320 m
    const { minor, major, intervalM } = contourFeatures(hm, 100);
    expect(intervalM).toBe(100);
    const all = [...minor.geometry.coordinates, ...major.geometry.coordinates];
    // Levels 100, 200, 300 → 3 polylines crossing the full width.
    expect(all).toHaveLength(3);
    for (const line of all) {
      // Horizontal: every vertex of one line shares (approximately) one latitude.
      const lats = line.map(([, lat]) => lat!);
      expect(Math.max(...lats) - Math.min(...lats)).toBeLessThan(1e-9);
      // Spans the full longitude range.
      const lngs = line.map(([lng]) => lng!);
      expect(Math.min(...lngs)).toBeCloseTo(BBOX.minLng, 6);
      expect(Math.max(...lngs)).toBeCloseTo(BBOX.maxLng, 6);
    }
    // Elevation 320 max → level 300 is minor (300/100 = 3, not a multiple of 5);
    // no major levels exist below 500.
    expect(major.geometry.coordinates).toHaveLength(0);
  });

  it('flags every 5th level as major', () => {
    const hm = plane(65, 0, 640); // levels 100..600 at 100 m
    const { minor, major } = contourFeatures(hm, 100);
    // 500 is the only multiple of 100 * CONTOUR_MAJOR_EVERY in range.
    expect(CONTOUR_MAJOR_EVERY).toBe(5);
    expect(major.geometry.coordinates).toHaveLength(1);
    expect(minor.geometry.coordinates).toHaveLength(5);
  });

  it('chains a cone level into one closed ring', () => {
    const hm = cone(41, 100);
    const { minor, major } = contourFeatures(hm, 50);
    const all = [...minor.geometry.coordinates, ...major.geometry.coordinates];
    // One 50 m level inside the range (0..100 → level 50; level 100 is a single
    // peak point and produces nothing).
    expect(all.length).toBeGreaterThanOrEqual(1);
    const ring = all[0]!;
    // Chained into one long polyline (not dozens of 2-point segments) that
    // closes on itself.
    expect(ring.length).toBeGreaterThan(20);
    const [x0, y0] = ring[0]!;
    const [x1, y1] = ring[ring.length - 1]!;
    expect(Math.hypot(x1! - x0!, y1! - y0!)).toBeLessThan(1e-9);
  });

  it('returns empty features for a flat grid', () => {
    const hm = plane(17, 200, 200);
    const { minor, major } = contourFeatures(hm, 50);
    expect(minor.geometry.coordinates).toHaveLength(0);
    expect(major.geometry.coordinates).toHaveLength(0);
  });

  it('keeps every vertex inside the grid bbox', () => {
    const hm = cone(33, 400);
    const { minor, major } = contourFeatures(hm, 0);
    for (const line of [...minor.geometry.coordinates, ...major.geometry.coordinates]) {
      for (const [lng, lat] of line) {
        expect(lng!).toBeGreaterThanOrEqual(BBOX.minLng - 1e-9);
        expect(lng!).toBeLessThanOrEqual(BBOX.maxLng + 1e-9);
        expect(lat!).toBeGreaterThanOrEqual(BBOX.minLat - 1e-9);
        expect(lat!).toBeLessThanOrEqual(BBOX.maxLat + 1e-9);
      }
    }
  });
});
