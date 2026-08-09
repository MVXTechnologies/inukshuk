import {
  buildLocatorScene,
  clipPolygonToSquare,
  clipPolylineToSquare,
  locatorWindow,
  projectToWindow,
  type LocatorBasemap,
} from './locator';
import type { CatalogBbox } from './schema';

const QUEBEC_SHEET: CatalogBbox = [-71.5, 46.75, -71, 47];

describe('locatorWindow', () => {
  it('is centered on the bbox and square in projected degrees', () => {
    const w = locatorWindow(QUEBEC_SHEET);
    expect((w.west + w.east) / 2).toBeCloseTo(-71.25, 6);
    expect((w.south + w.north) / 2).toBeCloseTo(46.875, 6);
    // Square: lon span * cos(lat) == lat span.
    expect((w.east - w.west) * w.cosLat).toBeCloseTo(w.north - w.south, 6);
  });

  it('contains the bbox with context margin around it', () => {
    const w = locatorWindow(QUEBEC_SHEET);
    expect(w.west).toBeLessThan(QUEBEC_SHEET[0]);
    expect(w.east).toBeGreaterThan(QUEBEC_SHEET[2]);
    expect(w.south).toBeLessThan(QUEBEC_SHEET[1]);
    expect(w.north).toBeGreaterThan(QUEBEC_SHEET[3]);
  });

  it('clamps huge bboxes so the window never spans the whole country', () => {
    const w = locatorWindow([-140, 42, -52, 83]);
    expect(w.north - w.south).toBeLessThanOrEqual(16);
  });
});

describe('projectToWindow', () => {
  it('maps window corners to canvas corners', () => {
    const w = locatorWindow(QUEBEC_SHEET);
    expect(projectToWindow(w.west, w.north, w, 100)).toEqual([0, 0]);
    const [x, y] = projectToWindow(w.east, w.south, w, 100);
    expect(x).toBeCloseTo(100, 6);
    expect(y).toBeCloseTo(100, 6);
  });

  it('y grows downward (north up)', () => {
    const w = locatorWindow(QUEBEC_SHEET);
    const [, yNorth] = projectToWindow(-71.25, 47, w, 100);
    const [, ySouth] = projectToWindow(-71.25, 46.75, w, 100);
    expect(yNorth).toBeLessThan(ySouth);
  });
});

describe('clipPolygonToSquare', () => {
  it('keeps a fully-inside polygon', () => {
    const poly = [
      [10, 10],
      [40, 10],
      [40, 40],
    ] as const;
    expect(clipPolygonToSquare(poly, 100)).toEqual([
      [10, 10],
      [40, 10],
      [40, 40],
    ]);
  });

  it('clips a polygon overlapping one edge', () => {
    const out = clipPolygonToSquare(
      [
        [-10, 10],
        [30, 10],
        [30, 30],
        [-10, 30],
      ],
      100,
    );
    expect(out.length).toBeGreaterThanOrEqual(4);
    for (const [x, y] of out) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it('reduces a polygon containing the square to the square itself', () => {
    const out = clipPolygonToSquare(
      [
        [-50, -50],
        [150, -50],
        [150, 150],
        [-50, 150],
      ],
      100,
    );
    expect(out).toHaveLength(4);
    const xs = out.map((p) => p[0]).sort((a, b) => a - b);
    const ys = out.map((p) => p[1]).sort((a, b) => a - b);
    expect(xs).toEqual([0, 0, 100, 100]);
    expect(ys).toEqual([0, 0, 100, 100]);
  });

  it('drops a fully-outside polygon', () => {
    expect(
      clipPolygonToSquare(
        [
          [200, 200],
          [300, 200],
          [300, 300],
        ],
        100,
      ),
    ).toEqual([]);
  });
});

describe('clipPolylineToSquare', () => {
  it('keeps an inside polyline as one piece', () => {
    const out = clipPolylineToSquare(
      [
        [10, 10],
        [50, 50],
        [90, 10],
      ],
      100,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(3);
  });

  it('splits a polyline that exits and re-enters', () => {
    const out = clipPolylineToSquare(
      [
        [10, 50],
        [-50, 50], // exits left
        [-50, 20],
        [10, 20], // re-enters
      ],
      100,
    );
    expect(out).toHaveLength(2);
    for (const piece of out) {
      for (const [x] of piece) expect(x).toBeGreaterThanOrEqual(0);
    }
  });

  it('clips a crossing segment to the square', () => {
    const out = clipPolylineToSquare(
      [
        [-50, 50],
        [150, 50],
      ],
      100,
    );
    expect(out).toEqual([
      [
        [0, 50],
        [100, 50],
      ],
    ]);
  });

  it('drops a fully-outside polyline', () => {
    expect(
      clipPolylineToSquare(
        [
          [-50, -10],
          [150, -10],
        ],
        100,
      ),
    ).toEqual([]);
  });
});

describe('buildLocatorScene', () => {
  // A tiny hand-made basemap: one land polygon covering the window's west
  // half, one lake inside it, one border polyline crossing the window.
  const basemap: LocatorBasemap = {
    land: [{ b: [-80, 40, -71.25, 55], p: [-80, 40, -71.25, 40, -71.25, 55, -80, 55] }],
    lakes: [{ b: [-72.5, 46.5, -72, 47], p: [-72.5, 46.5, -72, 46.5, -72, 47, -72.5, 47] }],
    borders: [{ b: [-80, 46.9, -60, 46.9], p: [-80, 46.9, -60, 46.9] }],
  };

  it('produces clipped SVG paths for every layer', () => {
    const scene = buildLocatorScene(QUEBEC_SHEET, basemap, 100);
    expect(scene.size).toBe(100);
    expect(scene.land).toHaveLength(1);
    expect(scene.lakes).toHaveLength(1);
    expect(scene.borders).toHaveLength(1);
    expect(scene.land[0]).toMatch(/^M[\d. ]+.*Z$/);
    expect(scene.borders[0]).toMatch(/^M[\d. ]+/);
    expect(scene.borders[0]!.endsWith('Z')).toBe(false);
  });

  it('skips rings whose bounds miss the window', () => {
    const farAway: LocatorBasemap = {
      land: [{ b: [-130, 60, -120, 65], p: [-130, 60, -120, 60, -120, 65] }],
      lakes: [],
      borders: [],
    };
    const scene = buildLocatorScene(QUEBEC_SHEET, farAway, 100);
    expect(scene.land).toEqual([]);
  });

  it('centers the sheet rect with the expected relative size', () => {
    const scene = buildLocatorScene(QUEBEC_SHEET, basemap, 100);
    const { x, y, width, height } = scene.sheet;
    expect(x + width / 2).toBeCloseTo(50, 4);
    expect(y + height / 2).toBeCloseTo(50, 4);
    // The window is >= MIN_LAT_SPAN (3°) tall; a 0.25° sheet stays small but visible.
    expect(height).toBeGreaterThan(5);
    expect(height).toBeLessThan(30);
    expect(width).toBeGreaterThan(height); // 0.5° x 0.25° sheet is wider than tall
  });
});
