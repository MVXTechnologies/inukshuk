import type { BoundingBox } from '@core/models';

/**
 * Crop a tile-stitched WebMercator raster down to a lng/lat bbox.
 *
 * The stitched raster covers whole tiles, so it always extends past the bbox
 * that was requested; the PDF composer needs exactly the bbox so the image
 * fills the map frame and the georeferencing corners land on the frame edge.
 * Cropping is nearest-pixel (≤ half a pixel of shift — well under both print
 * resolution and the raster's own ground resolution).
 */

export interface TileRangeLike {
  z: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface RgbaRaster {
  data: Uint8Array;
  width: number;
  height: number;
}

const TILE = 256;

/** Absolute raster pixel (float) of a lng/lat inside a stitched tile range. */
export function mercatorPixel(
  lng: number,
  lat: number,
  range: TileRangeLike,
): { x: number; y: number } {
  const n = 2 ** range.z;
  const worldX = ((lng + 180) / 360) * n * TILE;
  const latRad = (lat * Math.PI) / 180;
  const worldY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * TILE;
  return { x: worldX - range.minX * TILE, y: worldY - range.minY * TILE };
}

export function cropRasterToBbox(
  raster: RgbaRaster,
  range: TileRangeLike,
  bbox: BoundingBox,
): RgbaRaster {
  const tl = mercatorPixel(bbox.minLng, bbox.maxLat, range);
  const br = mercatorPixel(bbox.maxLng, bbox.minLat, range);
  const x0 = Math.max(0, Math.round(tl.x));
  const y0 = Math.max(0, Math.round(tl.y));
  const x1 = Math.min(raster.width, Math.round(br.x));
  const y1 = Math.min(raster.height, Math.round(br.y));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcStart = ((y0 + y) * raster.width + x0) * 4;
    data.set(raster.data.subarray(srcStart, srcStart + width * 4), y * width * 4);
  }
  return { data, width, height };
}
