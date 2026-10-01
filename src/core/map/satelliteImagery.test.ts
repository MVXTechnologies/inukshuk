import {
  applyImageryPaint,
  DEFAULT_IMAGERY_LOOK,
  IMAGERY_LOOK_LABEL,
  IMAGERY_LOOKS,
  IMAGERY_PAINT,
  isImageryLook,
  LEGACY_SATELLITE_TILE_SIZE,
  meanRasterViewportTiles,
  rasterTileScreenPt,
  rasterTileZoom,
  rasterViewportTiles,
  SATELLITE_FADE_MS,
  SATELLITE_TILE_SIZE,
  type Rgb,
} from './satelliteImagery';
import { NATIVE_MAX_ZOOM } from '@core/geo/tiles';

const luma = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// Sampled from the #495 Esri tiles: a shaded conifer stand, a sunlit
// clearing, and glacier snow.
const FOREST: Rgb = [0.12, 0.2, 0.1];
const CLEARING: Rgb = [0.45, 0.5, 0.3];
const SNOW: Rgb = [0.94, 0.95, 0.97];

describe('imagery looks (#495)', () => {
  it('defaults to Brighter, and every look has a label and a paint', () => {
    expect(DEFAULT_IMAGERY_LOOK).toBe('brighter');
    for (const look of IMAGERY_LOOKS) {
      expect(IMAGERY_LOOK_LABEL[look]).toBeTruthy();
      expect(IMAGERY_PAINT[look]).toBeDefined();
    }
  });

  it('validates persisted values', () => {
    expect(isImageryLook('brighter')).toBe(true);
    expect(isImageryLook('vivid')).toBe(false);
    expect(isImageryLook(1)).toBe(false);
    expect(isImageryLook(null)).toBe(false);
  });

  it('Original is the tiles as served', () => {
    expect(IMAGERY_PAINT.original).toEqual({});
    applyImageryPaint(FOREST, IMAGERY_PAINT.original).forEach((c, i) =>
      expect(c).toBeCloseTo(FOREST[i] ?? NaN, 9),
    );
  });

  it('each step brightens the dark forest, most of all', () => {
    const o = luma(FOREST);
    const b = luma(applyImageryPaint(FOREST, IMAGERY_PAINT.bright));
    const bb = luma(applyImageryPaint(FOREST, IMAGERY_PAINT.brighter));
    expect(b).toBeGreaterThan(o + 0.08);
    expect(bb).toBeGreaterThan(b);
    // Shadows gain more than mid-tones: a lift, not a uniform wash.
    const mid = luma(applyImageryPaint(CLEARING, IMAGERY_PAINT.bright)) - luma(CLEARING);
    expect(b - o).toBeGreaterThan(mid);
  });

  it('keeps snow bright and unclipped', () => {
    for (const look of IMAGERY_LOOKS) {
      const s = applyImageryPaint(SNOW, IMAGERY_PAINT[look]);
      expect(luma(s)).toBeGreaterThan(0.88);
      for (const c of s) expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('keeps colour: the forest stays greener than it is red or blue', () => {
    const [r, g, b] = applyImageryPaint(FOREST, IMAGERY_PAINT.brighter);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('only uses the paint properties MapLibre raster layers accept, in range', () => {
    for (const look of IMAGERY_LOOKS) {
      for (const [k, v] of Object.entries(IMAGERY_PAINT[look])) {
        expect(k).toMatch(/^raster-(brightness-min|brightness-max|contrast|saturation)$/);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('matches the shader for positive contrast and desaturation too', () => {
    // contrast 0.5 doubles the distance from mid-grey; saturation -1 is grey.
    expect(applyImageryPaint([0.75, 0.75, 0.75], { 'raster-contrast': 0.5 })[0]).toBeCloseTo(1);
    const grey = applyImageryPaint([0.9, 0.3, 0.3], { 'raster-saturation': -1 });
    expect(grey[0]).toBeCloseTo(0.5);
    expect(grey[1]).toBeCloseTo(0.5);
  });
});

describe('satellite tile budget (#495)', () => {
  const PHONE = { width: 412, height: 915 };
  const MAX = NATIVE_MAX_ZOOM.satellite;

  it('MapLibre rounds raster zooms: a 256 source goes two levels deep past z.5', () => {
    expect(rasterTileZoom(14, 256, MAX)).toBe(15);
    expect(rasterTileZoom(14.4, 256, MAX)).toBe(15);
    expect(rasterTileZoom(14.6, 256, MAX)).toBe(16);
  });

  it('the 362 declaration always asks for floor(z) + 1', () => {
    for (let i = 60; i < 320; i++) {
      const z = i / 20;
      expect(rasterTileZoom(z, SATELLITE_TILE_SIZE, MAX)).toBe(Math.floor(z) + 1);
    }
  });

  it('fetches the same tiles as before at every whole zoom (offline packs unchanged)', () => {
    for (let z = 0; z <= MAX; z++) {
      expect(rasterTileZoom(z, SATELLITE_TILE_SIZE, MAX)).toBe(
        rasterTileZoom(z, LEGACY_SATELLITE_TILE_SIZE, MAX),
      );
    }
  });

  it('stays clamped to the source maxzoom', () => {
    expect(rasterTileZoom(18.7, SATELLITE_TILE_SIZE, MAX)).toBe(MAX);
  });

  it('draws an imagery pixel no wider than 2 points', () => {
    for (let i = 100; i < (MAX - 1) * 20; i++) {
      const z = i / 20;
      const ptPerImagePx = rasterTileScreenPt(z, SATELLITE_TILE_SIZE, MAX) / 256;
      expect(ptPerImagePx).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(ptPerImagePx).toBeLessThan(2);
    }
  });

  it('halves the worst screen and cuts the mean by about a third', () => {
    expect(rasterViewportTiles(14.6, PHONE, LEGACY_SATELLITE_TILE_SIZE, MAX)).toBe(24);
    expect(rasterViewportTiles(14.6, PHONE, SATELLITE_TILE_SIZE, MAX)).toBe(12);
    const before = meanRasterViewportTiles(12, 16, PHONE, LEGACY_SATELLITE_TILE_SIZE, MAX);
    const after = meanRasterViewportTiles(12, 16, PHONE, SATELLITE_TILE_SIZE, MAX);
    expect(before).toBeCloseTo(16.9, 0);
    expect(after).toBeCloseTo(11.4, 0);
    expect(after / before).toBeLessThan(0.7);
  });

  it('an empty range costs nothing', () => {
    expect(meanRasterViewportTiles(14, 14, PHONE, SATELLITE_TILE_SIZE, MAX)).toBe(0);
  });

  it('fades tiles in faster than the MapLibre default', () => {
    expect(SATELLITE_FADE_MS).toBeLessThan(300);
    expect(SATELLITE_FADE_MS).toBeGreaterThan(0);
  });
});
