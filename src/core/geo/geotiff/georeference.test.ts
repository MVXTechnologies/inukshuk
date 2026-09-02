import { makeReprojector } from '@core/geo/geopdf/crs';
import { extrapolatePageCorners } from '@core/geo/geomath';
import { cropCorners, rasterGeoReference } from './georeference';
import type { RasterModel } from './rasterTiff';

/** The real 021L14 sheet's model (NAD83 / UTM 19N, 4.2334 m pixels). */
const MODEL: RasterModel = { x0: 307633.073099, y0: 5209773.397729, dx: 4.2334, dy: 4.2334 };
const FULL = { x: 0, y: 0, width: 11289, height: 8183 };
/** The neatline crop `cropForPolygon` derives for that sheet. */
const NEATLINE = { x: 335, y: 372, width: 9189, height: 6821 };

const utm19 = makeReprojector({ epsg: 26919 });

describe('cropCorners', () => {
  it('puts the whole Québec City scan where Québec City is', () => {
    const corners = cropCorners(MODEL, FULL, utm19);
    expect(corners.topLeft[0]).toBeCloseTo(-71.531, 2);
    expect(corners.topLeft[1]).toBeCloseTo(47.0135, 3);
    expect(corners.bottomRight[0]).toBeCloseTo(-70.8916, 3);
    expect(corners.bottomRight[1]).toBeCloseTo(46.7141, 3);
  });

  it('is a ROTATED quad in WGS84 — the sheet is north-up in UTM, not in lat/lon', () => {
    const corners = cropCorners(MODEL, FULL, utm19);
    // Grid north is not true north at 71°W in zone 19, so the two top corners
    // are at different latitudes. Supplying four corners (not a bbox) is what
    // keeps the overlay square with the ground.
    expect(corners.topRight[1] - corners.topLeft[1]).toBeGreaterThan(0.01);
  });

  it('crops to the sheet quad: the neatline lands on the NTS graticule', () => {
    const corners = cropCorners(MODEL, NEATLINE, utm19);
    // 021L14 is 71°30'–71°00'W by 46°45'–47°00'N. The crop is the bounding
    // rectangle of that quad in the raster's (rotated) grid, so it CONTAINS
    // the quad with a small margin — which the alpha mask then clears. The
    // margin is ~0.013° (about a kilometre), not the 8 km of collar the
    // uncropped scan would have painted over the next sheet.
    const lngs = Object.values(corners).map(([lng]) => lng);
    const lats = Object.values(corners).map(([, lat]) => lat);
    expect(Math.min(...lngs)).toBeGreaterThan(-71.5 - 0.02);
    expect(Math.min(...lngs)).toBeLessThanOrEqual(-71.5);
    expect(Math.max(...lngs)).toBeLessThan(-71.0 + 0.02);
    expect(Math.max(...lngs)).toBeGreaterThanOrEqual(-71.0);
    expect(Math.min(...lats)).toBeGreaterThan(46.75 - 0.02);
    expect(Math.max(...lats)).toBeLessThan(47.0 + 0.02);
  });
});

describe('rasterGeoReference', () => {
  it('describes the rendered crop as a full-page viewport', () => {
    const geo = rasterGeoReference(MODEL, NEATLINE, utm19, { sourceEpsg: 26919 })!;
    expect(geo).toMatchObject({
      pageIndex: 0,
      source: 'geotiff',
      sourceEpsg: 26919,
      pageWidthPt: 9189,
      pageHeightPt: 6821,
    });
    expect(geo.viewport.rect).toEqual({ x0: 0, y0: 0, x1: 9189, y1: 6821 });
  });

  it('makes the overlay hook’s page extrapolation the identity', () => {
    // A GeoPDF's neatline is a sub-rectangle of its page, so the overlay layer
    // extrapolates the page corners from it. A raster IS its own page — this
    // asserts the shared code path leaves those corners untouched.
    const geo = rasterGeoReference(MODEL, NEATLINE, utm19)!;
    const page = { x0: 0, y0: 0, x1: geo.pageWidthPt, y1: geo.pageHeightPt };
    expect(extrapolatePageCorners(geo.viewport.rect, geo.viewport.corners, page)).toEqual(
      geo.viewport.corners,
    );
  });

  it('reports a bbox that contains all four corners', () => {
    const geo = rasterGeoReference(MODEL, FULL, utm19)!;
    for (const [lng, lat] of Object.values(geo.viewport.corners)) {
      expect(lng).toBeGreaterThanOrEqual(geo.bbox.minLng);
      expect(lng).toBeLessThanOrEqual(geo.bbox.maxLng);
      expect(lat).toBeGreaterThanOrEqual(geo.bbox.minLat);
      expect(lat).toBeLessThanOrEqual(geo.bbox.maxLat);
    }
  });

  it('rejects a model that lands off the globe rather than handing it to MapLibre', () => {
    const absurd: RasterModel = { x0: 1e12, y0: 1e12, dx: 1, dy: 1 };
    expect(rasterGeoReference(absurd, FULL, makeReprojector({}))).toBeNull();
  });

  it('rejects a degenerate crop', () => {
    const geo = rasterGeoReference(MODEL, { x: 0, y: 0, width: 0, height: 0 }, utm19);
    expect(geo).toBeNull();
  });
});
