import {
  buildFootprintScene,
  ensureMinRect,
  FOOTPRINT_MAX_LAT_SPAN,
  FOOTPRINT_MIN_LAT_SPAN,
  FOOTPRINT_MIN_SHEET_PX,
  FOOTPRINT_WINDOW_FACTOR,
  footprintWindow,
  graticuleStep,
  LOCATOR_BASEMAP_EXTENT,
  pointBbox,
  windowInsideExtent,
} from './footprintThumb';
import type { LocatorBasemap } from './locator';
import { LOCATOR_BASEMAP } from './locatorBasemap';
import type { CatalogBbox } from './schema';

/** CanTopo 021L14-sized sheet near Québec City (0.5° × 0.25°). */
const QUEBEC_SHEET: CatalogBbox = [-71.5, 46.75, -71, 47];
/** A 1:24 000 US Topo quad (0.125°) in Colorado — outside the basemap extent. */
const COLORADO_QUAD: CatalogBbox = [-106.875, 39.125, -106.75, 39.25];

const W = 160;
const H = 120;

describe('footprintWindow', () => {
  it('is centred on the bbox with the card aspect in projected degrees', () => {
    const w = footprintWindow(QUEBEC_SHEET, W / H);
    expect((w.west + w.east) / 2).toBeCloseTo(-71.25, 6);
    expect((w.south + w.north) / 2).toBeCloseTo(46.875, 6);
    expect(((w.east - w.west) * w.cosLat) / (w.north - w.south)).toBeCloseTo(W / H, 6);
  });

  it('frames the sheet with margin on every side', () => {
    const w = footprintWindow(QUEBEC_SHEET, W / H);
    expect(w.west).toBeLessThan(QUEBEC_SHEET[0]);
    expect(w.east).toBeGreaterThan(QUEBEC_SHEET[2]);
    expect(w.south).toBeLessThan(QUEBEC_SHEET[1]);
    expect(w.north).toBeGreaterThan(QUEBEC_SHEET[3]);
  });

  it('sizes the window from the tighter axis', () => {
    // Wide sheet: 2° × 0.25° at 46.875° — the width decides.
    const wide: CatalogBbox = [-72, 46.75, -70, 47];
    const w = footprintWindow(wide, W / H);
    const cos = Math.cos((46.875 * Math.PI) / 180);
    const expected = ((2 * cos) / (W / H)) * FOOTPRINT_WINDOW_FACTOR;
    expect(w.north - w.south).toBeCloseTo(expected, 6);
  });

  it('clamps the latitude span both ways', () => {
    const small = footprintWindow(COLORADO_QUAD, 1);
    expect(small.north - small.south).toBeCloseTo(FOOTPRINT_MIN_LAT_SPAN, 9);
    const huge = footprintWindow([-140, 42, -52, 83], 1);
    expect(huge.north - huge.south).toBeCloseTo(FOOTPRINT_MAX_LAT_SPAN, 9);
  });

  it('treats a nonsense aspect as square', () => {
    const w = footprintWindow(QUEBEC_SHEET, Number.NaN);
    expect((w.east - w.west) * w.cosLat).toBeCloseTo(w.north - w.south, 6);
    const z = footprintWindow(QUEBEC_SHEET, 0);
    expect((z.east - z.west) * z.cosLat).toBeCloseTo(z.north - z.south, 6);
  });
});

describe('windowInsideExtent', () => {
  it('is true only when the whole window is inside', () => {
    expect(windowInsideExtent(footprintWindow(QUEBEC_SHEET, W / H), LOCATOR_BASEMAP_EXTENT)).toBe(
      true,
    );
    expect(windowInsideExtent(footprintWindow(COLORADO_QUAD, W / H), LOCATOR_BASEMAP_EXTENT)).toBe(
      false,
    );
  });
});

describe('ensureMinRect', () => {
  it('grows a tiny rect about its centre', () => {
    const r = ensureMinRect({ x: 10, y: 20, width: 2, height: 1 }, 8);
    expect(r).toEqual({ x: 7, y: 16.5, width: 8, height: 8 });
  });

  it('never shrinks a rect', () => {
    const r = { x: 1, y: 2, width: 30, height: 40 };
    expect(ensureMinRect(r, 8)).toEqual(r);
  });
});

describe('graticuleStep', () => {
  it('picks a tidy step giving at most five lines', () => {
    expect(graticuleStep(1.2)).toBe(0.25);
    expect(graticuleStep(2)).toBe(0.5);
    expect(graticuleStep(4)).toBe(1);
    expect(graticuleStep(9)).toBe(2);
    expect(graticuleStep(20)).toBe(5);
    expect(graticuleStep(80)).toBe(10);
  });
});

describe('buildFootprintScene', () => {
  it('draws the Québec sheet inside the frame over land, water and borders', () => {
    const scene = buildFootprintScene(QUEBEC_SHEET, LOCATOR_BASEMAP, { width: W, height: H });
    expect(scene.basemap).toBe(true);
    expect(scene.land.length).toBeGreaterThan(0);
    expect(scene.graticule).toEqual([]);
    const { x, y, width, height } = scene.sheet;
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x + width).toBeLessThan(W);
    expect(y + height).toBeLessThan(H);
    // Centred in the card.
    expect(x + width / 2).toBeCloseTo(W / 2, 6);
    expect(y + height / 2).toBeCloseTo(H / 2, 1);
  });

  it('keeps every path inside the rectangular canvas', () => {
    const scene = buildFootprintScene(QUEBEC_SHEET, LOCATOR_BASEMAP, { width: W, height: H });
    for (const d of [...scene.land, ...scene.lakes, ...scene.borders]) {
      const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(0);
        expect(nums[i]).toBeLessThanOrEqual(W);
        expect(nums[i + 1]).toBeGreaterThanOrEqual(0);
        expect(nums[i + 1]).toBeLessThanOrEqual(H);
      }
    }
  });

  it('outside the basemap extent draws a graticule, never a fake ocean', () => {
    const scene = buildFootprintScene(COLORADO_QUAD, LOCATOR_BASEMAP, { width: W, height: H });
    expect(scene.basemap).toBe(false);
    expect(scene.land).toEqual([]);
    expect(scene.lakes).toEqual([]);
    expect(scene.borders).toEqual([]);
    expect(scene.graticule.length).toBeGreaterThan(0);
  });

  it('grows a sub-pixel sheet to the minimum visible size', () => {
    const tiny: CatalogBbox = [-71.21, 46.81, -71.2095, 46.8105];
    const scene = buildFootprintScene(tiny, LOCATOR_BASEMAP, { width: W, height: H });
    expect(scene.sheet.width).toBe(FOOTPRINT_MIN_SHEET_PX);
    expect(scene.sheet.height).toBe(FOOTPRINT_MIN_SHEET_PX);
  });

  it('places the user when inside the frame, and only then', () => {
    const inside = buildFootprintScene(QUEBEC_SHEET, LOCATOR_BASEMAP, {
      width: W,
      height: H,
      origin: { latitude: 46.875, longitude: -71.25 },
    });
    expect(inside.you?.x).toBeCloseTo(W / 2, 6);
    expect(inside.you?.y).toBeCloseTo(H / 2, 1);
    const far = buildFootprintScene(QUEBEC_SHEET, LOCATOR_BASEMAP, {
      width: W,
      height: H,
      origin: { latitude: 40, longitude: -100 },
    });
    expect(far.you).toBeNull();
    expect(buildFootprintScene(QUEBEC_SHEET, LOCATOR_BASEMAP, { width: W, height: H }).you).toBe(
      null,
    );
  });

  it('honours a custom extent and skips rings outside the frame', () => {
    const ring = {
      b: [-71.4, 46.8, -71.1, 46.95] as const,
      p: [-71.4, 46.8, -71.1, 46.8, -71.1, 46.95, -71.4, 46.8],
    };
    const faraway = { b: [10, 10, 11, 11] as const, p: [10, 10, 11, 10, 11, 11, 10, 10] };
    const basemap: LocatorBasemap = { land: [ring, faraway], lakes: [], borders: [ring, faraway] };
    const scene = buildFootprintScene(
      QUEBEC_SHEET,
      basemap,
      { width: W, height: H },
      [-80, 40, -60, 55],
    );
    expect(scene.land).toHaveLength(1);
    expect(scene.borders).toHaveLength(1);
  });
});

describe('pointBbox', () => {
  it('is centred on the point and square on the ground', () => {
    const b = pointBbox({ latitude: 47.32, longitude: -71.4 });
    expect((b[0] + b[2]) / 2).toBeCloseTo(-71.4, 9);
    expect((b[1] + b[3]) / 2).toBeCloseTo(47.32, 9);
    const cos = Math.cos((47.32 * Math.PI) / 180);
    expect((b[2] - b[0]) * cos).toBeCloseTo(b[3] - b[1], 9);
    expect(b[3] - b[1]).toBeCloseTo(0.6, 9);
  });
});
