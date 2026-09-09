import type { CornerCoordinates, GeoReference, LngLat, PointRect } from '@core/models';
import { bboxFromCorners } from '@core/geo/geomath';
import { makeReprojector } from './crs';

/**
 * Sidecar world file (.pgw / .pdfw / .wld). Six lines mapping pixel -> CRS:
 *   line 1: A — x pixel size (CRS units per pixel, x)
 *   line 2: D — rotation about y axis
 *   line 3: B — rotation about x axis
 *   line 4: E — y pixel size (usually negative; CRS units per pixel, y)
 *   line 5: C — x of the CENTER of the top-left pixel
 *   line 6: F — y of the CENTER of the top-left pixel
 *
 * geoX = A*col + B*row + C ; geoY = D*col + E*row + F   (col,row = pixel index)
 *
 * The world file is in RASTER pixel space; we map page points -> raster pixels
 * (top-left origin in raster vs bottom-left in PDF) and then to CRS, finally
 * reprojecting to WGS84.
 */
export function parseWorldFile(args: {
  worldText: string;
  rasterWidthPx: number;
  rasterHeightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
  epsg?: number;
  pageIndex?: number;
}): GeoReference {
  const {
    worldText,
    rasterWidthPx,
    rasterHeightPx,
    pageWidthPt,
    pageHeightPt,
    epsg = 4326,
    pageIndex = 0,
  } = args;

  const lines = worldText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(Number);
  if (lines.length < 6 || lines.some((n) => Number.isNaN(n))) {
    throw new Error('world file must contain 6 numeric lines');
  }
  const [A, D, B, E, C, F] = lines as [number, number, number, number, number, number];

  const reproj = makeReprojector({ epsg });

  // Pixel (col,row) -> CRS, with col,row at pixel centers. The world file gives
  // the center of the top-left pixel, so corner col=-0.5, row=-0.5.
  const pixelToWgs = (col: number, row: number): LngLat => {
    const gx = A * col + B * row + C;
    const gy = D * col + E * row + F;
    return reproj.isWgs84 ? [gx, gy] : reproj.toWgs84(gx, gy);
  };

  // The four raster corners (top-left origin). Using pixel-edge coordinates.
  const corners: CornerCoordinates = {
    topLeft: pixelToWgs(-0.5, -0.5),
    topRight: pixelToWgs(rasterWidthPx - 0.5, -0.5),
    bottomRight: pixelToWgs(rasterWidthPx - 0.5, rasterHeightPx - 0.5),
    bottomLeft: pixelToWgs(-0.5, rasterHeightPx - 0.5),
  };

  // A sidecar georeferences the rendered raster as a whole, so the frame and
  // the rendered page box are the same zero-origin rectangle.
  const rect: PointRect = { x0: 0, y0: 0, x1: pageWidthPt, y1: pageHeightPt };

  return {
    pageIndex,
    source: 'world-file',
    sourceEpsg: epsg,
    pageWidthPt,
    pageHeightPt,
    pageBox: { ...rect },
    viewport: { rect, corners },
    bbox: bboxFromCorners(corners),
  };
}
