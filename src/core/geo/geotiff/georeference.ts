/**
 * Turning a raster GeoTIFF into the app's {@link GeoReference}.
 *
 * The library, the map overlay layer and the "where is this map" UI all speak
 * `GeoReference` — a page size plus a viewport rectangle with geographic
 * corners. A GeoPDF fills that in from its own page geometry; a GeoTIFF fills
 * it in from the crop we actually render, measured in source pixels instead of
 * PDF points. The unit does not matter: everything downstream only ever uses
 * the ratio between the rectangle and the page.
 *
 * Because the rendered image IS the georeferenced region, `viewport.rect`
 * always covers the whole page, and `extrapolatePageCorners` is the identity —
 * unlike a GeoPDF, where the neatline is a sub-rectangle of the sheet.
 */
import { bboxFromCorners, cornersAreValid, isDegenerateBBox } from '@core/geo/geomath';
import type { Reprojector } from '@core/geo/geopdf/crs';
import type { CornerCoordinates, GeoReference } from '@core/models';
import type { RasterCrop, RasterModel } from './rasterTiff';

/** The WGS84 corners of a pixel rectangle of a north-up projected raster. */
export function cropCorners(
  model: RasterModel,
  crop: RasterCrop,
  reprojector: Reprojector,
): CornerCoordinates {
  const west = model.x0 + crop.x * model.dx;
  const east = model.x0 + (crop.x + crop.width) * model.dx;
  const north = model.y0 - crop.y * model.dy;
  const south = model.y0 - (crop.y + crop.height) * model.dy;
  return {
    topLeft: reprojector.toWgs84(west, north),
    topRight: reprojector.toWgs84(east, north),
    bottomRight: reprojector.toWgs84(east, south),
    bottomLeft: reprojector.toWgs84(west, south),
  };
}

/**
 * The `GeoReference` for a rendered crop of a raster GeoTIFF, or null when the
 * corners come out non-finite, off the globe or degenerate — the same gate the
 * PDF overlay path applies, applied here so a bad file never reaches MapLibre.
 */
export function rasterGeoReference(
  model: RasterModel,
  crop: RasterCrop,
  reprojector: Reprojector,
  options: { pageIndex?: number; sourceEpsg?: number } = {},
): GeoReference | null {
  const corners = cropCorners(model, crop, reprojector);
  if (!cornersAreValid(corners)) return null;
  const bbox = bboxFromCorners(corners);
  if (isDegenerateBBox(bbox)) return null;
  return {
    pageIndex: options.pageIndex ?? 0,
    source: 'geotiff',
    ...(options.sourceEpsg !== undefined ? { sourceEpsg: options.sourceEpsg } : {}),
    pageWidthPt: crop.width,
    pageHeightPt: crop.height,
    viewport: {
      rect: { x0: 0, y0: 0, x1: crop.width, y1: crop.height },
      corners,
    },
    bbox,
  };
}
