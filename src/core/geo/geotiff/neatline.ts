/**
 * Cropping a scanned map sheet to its neatline.
 *
 * A CanMatrix TIFF is a scan of the whole printed sheet: the map, plus the
 * collar — marginalia, the legend panel, the adjoining-sheet diagram, the
 * Canada wordmark. The georeferencing covers that whole scan, so drawing it
 * raw paints ~4 km of white paper and legend over the terrain east of the map.
 * With two neighbouring sheets active, each hides part of the other.
 *
 * There is no neatline tag in the file. But for an NTS sheet the neatline *is*
 * the graticule quad — 021L14 is exactly 71°30′–71°00′W by 46°45′–47°00′N —
 * and the catalog already knows that quad (NRCan's sheet index). So: project
 * the quad into the raster's own pixel grid, crop to it, and blank whatever
 * still falls outside. Four projections' worth of work, and the sheets then
 * tile against each other the way the paper maps do.
 *
 * The quad's edges are NOT straight in a projected grid — meridians converge
 * and parallels bow — so the ring is densified before projection and the mask
 * works scanline by scanline rather than from four corners.
 */
import type { BoundingBox, LngLat } from '@core/models';
import type { Reprojector } from '@core/geo/geopdf/crs';
import type { RasterCrop, RasterModel, RasterSamplePlan } from './rasterTiff';

/** A point in raster pixel coordinates (x → columns, y → rows, fractional). */
export interface PixelPoint {
  x: number;
  y: number;
}

/** Points per bbox edge when densifying. 16 keeps the bow under a pixel. */
const DEFAULT_DENSIFY = 16;

/**
 * A closed ring around a WGS84 bbox with `perEdge` points along each side, so
 * the projected outline follows the curved parallels instead of cutting the
 * corners off with four straight chords.
 */
export function densifyBboxRing(bbox: BoundingBox, perEdge: number = DEFAULT_DENSIFY): LngLat[] {
  const n = Math.max(1, Math.floor(perEdge));
  const { minLng, minLat, maxLng, maxLat } = bbox;
  const ring: LngLat[] = [];
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  for (let i = 0; i < n; i++) ring.push([lerp(minLng, maxLng, i / n), maxLat]);
  for (let i = 0; i < n; i++) ring.push([maxLng, lerp(maxLat, minLat, i / n)]);
  for (let i = 0; i < n; i++) ring.push([lerp(maxLng, minLng, i / n), minLat]);
  for (let i = 0; i < n; i++) ring.push([minLng, lerp(minLat, maxLat, i / n)]);
  return ring;
}

/**
 * Project a WGS84 ring into the raster's pixel grid. Points that fail to
 * project (outside the projection's domain) are dropped; fewer than three
 * survivors means "no usable outline" and the caller should skip cropping
 * rather than guess.
 */
export function projectRingToPixels(
  model: RasterModel,
  reprojector: Reprojector,
  ring: readonly LngLat[],
): PixelPoint[] {
  const out: PixelPoint[] = [];
  for (const [lng, lat] of ring) {
    const [x, y] = reprojector.fromWgs84(lng, lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x: (x - model.x0) / model.dx, y: (model.y0 - y) / model.dy });
  }
  return out;
}

/**
 * Integer crop covering `polygon`, clamped to the image. Null when the polygon
 * misses the image, or covers so little of it that cropping is more likely a
 * georeferencing bug than a real neatline (guarded at 10 % of each axis).
 */
export function cropForPolygon(
  polygon: readonly PixelPoint[],
  width: number,
  height: number,
): RasterCrop | null {
  if (polygon.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(width, Math.ceil(maxX));
  const y1 = Math.min(height, Math.ceil(maxY));
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;
  if (cropWidth < width * 0.1 || cropHeight < height * 0.1) return null;
  return { x: x0, y: y0, width: cropWidth, height: cropHeight };
}

/**
 * Horizontal extent of `polygon` at scanline `y`, or null when the scanline
 * misses it. Takes the outermost crossings, which is exact for the convex
 * quad a graticule cell projects to and degrades to its hull otherwise —
 * never a chance of blanking map content that a shape check got wrong.
 */
export function polygonRowSpan(
  polygon: readonly PixelPoint[],
  y: number,
): { x0: number; x1: number } | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if (a === undefined || b === undefined) continue;
    // Half-open test on y so a vertex shared by two edges counts once.
    if (a.y <= y === b.y <= y) continue;
    const t = (y - a.y) / (b.y - a.y);
    const x = a.x + t * (b.x - a.x);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
  }
  return x0 <= x1 ? { x0, x1 } : null;
}

/**
 * Make every output pixel whose source pixel falls outside `polygon` fully
 * transparent, in place. One span per output row, so this costs
 * `outHeight × edges` — not a point-in-polygon test per pixel.
 */
export function maskRgbaOutsidePolygon(
  rgba: Uint8Array,
  plan: RasterSamplePlan,
  polygon: readonly PixelPoint[],
): void {
  if (polygon.length < 3) return;
  for (let j = 0; j < plan.outHeight; j++) {
    const srcRow = plan.srcRows[j];
    if (srcRow === undefined) continue;
    const span = polygonRowSpan(polygon, srcRow + 0.5);
    const rowBase = j * plan.outWidth * 4;
    for (let i = 0; i < plan.outWidth; i++) {
      const srcCol = plan.srcCols[i];
      if (srcCol === undefined) continue;
      const inside = span !== null && srcCol + 0.5 >= span.x0 && srcCol + 0.5 <= span.x1;
      if (!inside) rgba[rowBase + i * 4 + 3] = 0;
    }
  }
}
