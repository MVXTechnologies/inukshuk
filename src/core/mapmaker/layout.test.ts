import { layoutMadeMap, PAGE_FORMATS, SCALE_DENOMS } from './layout';
import type { BoundingBox } from '@core/models';

// Québec-ish latitude; ~11 km wide × ~5.5 km tall (wider than tall).
const WIDE: BoundingBox = { minLng: -71.35, minLat: 46.75, maxLng: -71.2, maxLat: 46.8 };
// Taller than wide: ~5.5 km wide × ~11 km tall.
const TALL: BoundingBox = { minLng: -71.3, minLat: 46.7, maxLng: -71.225, maxLat: 46.8 };

const groundWidthM = (b: BoundingBox) =>
  (b.maxLng - b.minLng) * 111320 * Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180);

describe('layoutMadeMap', () => {
  it('orients the page to the region aspect', () => {
    const wide = layoutMadeMap(WIDE, 'a4');
    expect(wide.page.widthPt).toBeGreaterThan(wide.page.heightPt);
    const tall = layoutMadeMap(TALL, 'a4');
    expect(tall.page.heightPt).toBeGreaterThan(tall.page.widthPt);
    // Letter dimensions differ from A4.
    expect(layoutMadeMap(TALL, 'letter').page.heightPt).toBe(PAGE_FORMATS.letter.heightPt);
  });

  it('expands the bbox to the map rect aspect without shrinking it', () => {
    const l = layoutMadeMap(WIDE, 'a4');
    expect(l.drawBbox.minLng).toBeLessThanOrEqual(WIDE.minLng);
    expect(l.drawBbox.maxLng).toBeGreaterThanOrEqual(WIDE.maxLng);
    expect(l.drawBbox.minLat).toBeLessThanOrEqual(WIDE.minLat);
    expect(l.drawBbox.maxLat).toBeGreaterThanOrEqual(WIDE.maxLat);
    // Aspect match: ground meters ratio ≈ rect points ratio. Latitude span in
    // meters uses the plain 111320 factor (small spans; mercator stretch is
    // second-order here and the layout uses the same approximation).
    const gw = groundWidthM(l.drawBbox);
    const gh = (l.drawBbox.maxLat - l.drawBbox.minLat) * 111320;
    expect(gw / gh).toBeCloseTo(l.mapRect.w / l.mapRect.h, 2);
  });

  it('snaps to an exact standard print scale that still fits the region', () => {
    const l = layoutMadeMap(WIDE, 'a4');
    // The denominator is a catalogued standard, and metersPerPt derives from
    // it EXACTLY (1 pt = 0.0254/72 m on paper).
    expect(SCALE_DENOMS).toContain(l.scaleDenom);
    expect(l.metersPerPt).toBeCloseTo(l.scaleDenom * (0.0254 / 72), 9);
    // The drawn region at that scale spans the frame exactly and still
    // contains the request.
    expect(l.mapRect.w * l.metersPerPt).toBeCloseTo(groundWidthM(l.drawBbox), 0);
    expect(groundWidthM(l.drawBbox)).toBeGreaterThanOrEqual(groundWidthM(WIDE) - 1);
  });

  it('caps the raster long edge at 4096 px and stays as sharp as the cap allows', () => {
    const l = layoutMadeMap(WIDE, 'a4');
    const groundW = groundWidthM(l.drawBbox);
    const mPerPx = (156543.03392 * Math.cos((46.775 * Math.PI) / 180)) / 2 ** l.rasterZoom;
    const pxW = groundW / mPerPx;
    expect(Math.max(pxW, (pxW * l.mapRect.h) / l.mapRect.w)).toBeLessThanOrEqual(4096 * 1.001);
    // One zoom deeper would blow the cap (i.e. we picked the sharpest fit).
    expect(pxW * 2).toBeGreaterThan(4096);
  });

  it('picks a clean scale-bar length no wider than 40% of the map', () => {
    const l = layoutMadeMap(WIDE, 'a4');
    const clean = [100, 250, 500, 1000, 2000, 2500, 5000, 10000, 25000, 50000];
    expect(clean).toContain(l.scaleBar.meters);
    expect(l.scaleBar.widthPt).toBeLessThanOrEqual(l.mapRect.w * 0.4 + 1e-9);
    expect(l.scaleBar.widthPt).toBeCloseTo(l.scaleBar.meters / l.metersPerPt, 6);
    expect(l.scaleBar.label).toBe(
      l.scaleBar.meters >= 1000 ? `${l.scaleBar.meters / 1000} km` : `${l.scaleBar.meters} m`,
    );
  });
});

it.each(['a4', 'letter'] as const)(
  'keeps selected regional extents, printed scale and scale bar consistent beyond 1:1M on %s',
  (format) => {
    // Reachable by zooming out before opening the map-maker selector: unlike
    // offline downloads its confirmation has no geographic area/scale limit.
    const region = { minLng: -75, maxLng: -69, minLat: 44, maxLat: 48 };
    const layout = layoutMadeMap(region, format);
    expect(layout.drawBbox.minLng).toBeLessThanOrEqual(region.minLng);
    expect(layout.drawBbox.maxLng).toBeGreaterThanOrEqual(region.maxLng);
    expect(layout.drawBbox.minLat).toBeLessThanOrEqual(region.minLat);
    expect(layout.drawBbox.maxLat).toBeGreaterThanOrEqual(region.maxLat);
    expect(layout.scaleDenom).toBeGreaterThan(1000000);
    const drawnW = groundWidthM(layout.drawBbox);
    const drawnH = (layout.drawBbox.maxLat - layout.drawBbox.minLat) * 111320;
    expect(drawnW / layout.mapRect.w).toBeCloseTo(layout.metersPerPt, 6);
    expect(drawnH / layout.mapRect.h).toBeCloseTo(layout.metersPerPt, 6);
    expect(layout.scaleBar.widthPt * (drawnW / layout.mapRect.w)).toBeCloseTo(
      layout.scaleBar.meters,
      6,
    );
    const cosLat = Math.cos((46 * Math.PI) / 180);
    const pixels = Math.max(drawnW, drawnH) / ((156543.03392 * cosLat) / 2 ** layout.rasterZoom);
    expect(pixels).toBeLessThanOrEqual(4096);
  },
);

describe('layoutMadeMap with an explicit scale (#349)', () => {
  // A frame the editor already sized: exactly A4-portrait aspect at 1:33 000,
  // a denominator that is NOT on the standard ladder.
  const framed = (denom: number) => {
    const lat = 46.81;
    const cos = Math.cos((lat * Math.PI) / 180);
    const mapW = 595.28 - 60;
    const mapH = 841.89 - 88 - 30;
    const wM = mapW * (0.0254 / 72) * denom;
    const hM = mapH * (0.0254 / 72) * denom;
    return {
      minLng: -71.25 - wM / (111320 * cos) / 2,
      maxLng: -71.25 + wM / (111320 * cos) / 2,
      minLat: lat - hM / 111320 / 2,
      maxLat: lat + hM / 111320 / 2,
    };
  };

  it('prints the denominator it was given instead of rounding up', () => {
    const bbox = framed(33000);
    expect(layoutMadeMap(bbox, 'a4').scaleDenom).toBe(40000); // today's snap-up
    expect(layoutMadeMap(bbox, 'a4', { scaleDenom: 33000 }).scaleDenom).toBe(33000);
  });

  it('draws exactly the framed region, so the preview cannot lie', () => {
    const bbox = framed(33000);
    const l = layoutMadeMap(bbox, 'a4', { scaleDenom: 33000 });
    // Snapped up, drawBbox would grow by 40000/33000 = 1.21x on each axis.
    expect(l.drawBbox.maxLng - l.drawBbox.minLng).toBeCloseTo(bbox.maxLng - bbox.minLng, 6);
    expect(l.drawBbox.maxLat - l.drawBbox.minLat).toBeCloseTo(bbox.maxLat - bbox.minLat, 6);
  });

  it('still derives the scale bar and raster zoom from the given scale', () => {
    const l = layoutMadeMap(framed(33000), 'a4', { scaleDenom: 33000 });
    expect(l.metersPerPt).toBeCloseTo(33000 * (0.0254 / 72), 9);
    expect(l.scaleBar.widthPt).toBeCloseTo(l.scaleBar.meters / l.metersPerPt, 6);
    expect(l.rasterZoom).toBeGreaterThan(0);
  });

  it('ignores a nonsensical override rather than printing 1:0', () => {
    const bbox = framed(33000);
    expect(layoutMadeMap(bbox, 'a4', { scaleDenom: 0 }).scaleDenom).toBe(40000);
    expect(layoutMadeMap(bbox, 'a4', { scaleDenom: -5 }).scaleDenom).toBe(40000);
  });
});
