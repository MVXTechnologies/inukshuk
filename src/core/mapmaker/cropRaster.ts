import type { BoundingBox } from '@core/models';

/**
 * Crop a tile-stitched WebMercator raster down to a lng/lat bbox.
 *
 * The stitched raster covers whole tiles, so it always extends past the bbox
 * that was requested; the PDF composer needs exactly the bbox so the image
 * fills the map frame and the georeferencing corners land on the frame edge.
 * Cropping is nearest-pixel (≤ half a pixel of shift — well under both print
 * resolution and the raster's own ground resolution).
 *
 * The raster does NOT have to be at full tile resolution. `range` says which
 * GROUND the pixels cover; the raster's own width/height say at what
 * resolution — the terrain analysis passes a `grid × grid` heightmap-derived
 * image covering a many-tile range (#354). Everything is therefore scaled
 * into the raster's own pixel space before the window is rounded; for a
 * full-resolution stitched texture the scale is exactly 1 and nothing moves.
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

/**
 * Absolute pixel (float) of a lng/lat inside a tile range, in the range's OWN
 * full-tile-resolution space — i.e. `(maxX - minX + 1) * 256` px wide. Scale
 * the result yourself when the raster you are indexing is not at that
 * resolution (see {@link cropRasterToBbox}).
 */
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
  // Range-space pixels → this raster's pixels. 1 for a full-resolution
  // stitched texture; 256/1024 for a 256² terrain image over a 4-tile range.
  const scaleX = raster.width / ((range.maxX - range.minX + 1) * TILE);
  const scaleY = raster.height / ((range.maxY - range.minY + 1) * TILE);
  const tl = mercatorPixel(bbox.minLng, bbox.maxLat, range);
  const br = mercatorPixel(bbox.maxLng, bbox.minLat, range);
  // Clamp the origin inside the raster too: a bbox that misses the range
  // entirely would otherwise start the row copy past the end of the source.
  const x0 = Math.min(raster.width - 1, Math.max(0, Math.round(tl.x * scaleX)));
  const y0 = Math.min(raster.height - 1, Math.max(0, Math.round(tl.y * scaleY)));
  const x1 = Math.min(raster.width, Math.round(br.x * scaleX));
  const y1 = Math.min(raster.height, Math.round(br.y * scaleY));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcStart = ((y0 + y) * raster.width + x0) * 4;
    data.set(raster.data.subarray(srcStart, srcStart + width * 4), y * width * 4);
  }
  return { data, width, height };
}
