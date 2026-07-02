import type { BoundingBox } from '@core/models';

/**
 * Pure web-mercator tile math + Terrarium DEM decoding for the 3D terrain
 * renderer. No platform deps — the GL screen fetches tiles and decodes pixels
 * using these helpers to build a heightmap mesh.
 */

/** Fractional XYZ tile coordinates of a lng/lat at zoom `z`. */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export interface TileRange {
  z: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Integer tile range (inclusive) covering a bounding box at zoom `z`. */
export function tileRangeForBbox(bbox: BoundingBox, z: number): TileRange {
  const nw = lngLatToTile(bbox.minLng, bbox.maxLat, z);
  const se = lngLatToTile(bbox.maxLng, bbox.minLat, z);
  const n = 2 ** z;
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, Math.floor(v)));
  return { z, minX: clamp(nw.x), maxX: clamp(se.x), minY: clamp(nw.y), maxY: clamp(se.y) };
}

/**
 * Choose the most detailed zoom (≤ `zMax`) at which the bbox still spans no more
 * than `maxTilesPerSide` tiles each way — keeping the fetch + mesh bounded.
 */
export function pickTerrainZoom(
  bbox: BoundingBox,
  maxTilesPerSide = 4,
  zMax = 14,
  zMin = 8,
): number {
  for (let z = zMax; z >= zMin; z--) {
    const r = tileRangeForBbox(bbox, z);
    if (r.maxX - r.minX + 1 <= maxTilesPerSide && r.maxY - r.minY + 1 <= maxTilesPerSide) return z;
  }
  return zMin;
}

/**
 * Crop a tile range around its centre so neither side exceeds `maxTilesPerSide`.
 *
 * {@link pickTerrainZoom} bottoms out at `zMin` for very large boxes (e.g. a
 * 2000 km imported tour), where the range can still span dozens of tiles per
 * side — hundreds of downloads and a heightmap/texture allocation big enough to
 * OOM the app. Consumers must clamp the range they actually fetch.
 */
export function clampTileRange(r: TileRange, maxTilesPerSide: number): TileRange {
  const crop = (min: number, max: number): [number, number] => {
    if (max - min + 1 <= maxTilesPerSide) return [min, max];
    const lo = Math.floor((min + max) / 2) - Math.floor((maxTilesPerSide - 1) / 2);
    return [lo, lo + maxTilesPerSide - 1];
  };
  const [minX, maxX] = crop(r.minX, r.maxX);
  const [minY, maxY] = crop(r.minY, r.maxY);
  return { z: r.z, minX, maxX, minY, maxY };
}

/** Lng/lat of a tile's top-left corner (inverse of {@link lngLatToTile}). */
export function tileToLngLat(x: number, y: number, z: number): { lng: number; lat: number } {
  const n = 2 ** z;
  const lng = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lng, lat };
}

/**
 * Expand a bounding box outward so a 3D terrain built from it shows context
 * around the trail (and fills the viewport) instead of a tight floating slab.
 * Grows each side by `factor` × the box's span, and ensures the box spans at
 * least `minSpanM` metres in each direction so very short trails still get a
 * sensible amount of surrounding landscape. Pure.
 */
export function padBbox(bbox: BoundingBox, factor = 0.6, minSpanM = 1200): BoundingBox {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((midLat * Math.PI) / 180) || 111320;
  const spanLatM = (bbox.maxLat - bbox.minLat) * mPerDegLat;
  const spanLngM = (bbox.maxLng - bbox.minLng) * mPerDegLng;
  // Pad by the factor, then top up to the metre minimum if the trail is tiny.
  const padLatM = Math.max(spanLatM * factor, (minSpanM - spanLatM) / 2, 0);
  const padLngM = Math.max(spanLngM * factor, (minSpanM - spanLngM) / 2, 0);
  const dLat = padLatM / mPerDegLat;
  const dLng = padLngM / mPerDegLng;
  return {
    minLat: bbox.minLat - dLat,
    maxLat: bbox.maxLat + dLat,
    minLng: bbox.minLng - dLng,
    maxLng: bbox.maxLng + dLng,
  };
}

/** The lng/lat box actually covered by an (inclusive) tile range. */
export function rangeBbox(range: TileRange): BoundingBox {
  const nw = tileToLngLat(range.minX, range.minY, range.z);
  const se = tileToLngLat(range.maxX + 1, range.maxY + 1, range.z);
  return { minLng: nw.lng, maxLat: nw.lat, maxLng: se.lng, minLat: se.lat };
}

/** Decode a Terrarium-encoded RGB pixel to metres of elevation. */
export function terrariumToMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Bilinearly sample a row-major grid at fractional column/row in [0,1]. Used to
 * read terrain elevation at an arbitrary trail point.
 */
export function sampleGridBilinear(
  grid: ArrayLike<number>,
  width: number,
  height: number,
  fx: number,
  fy: number,
): number {
  const cx = Math.max(0, Math.min(width - 1, fx * (width - 1)));
  const cy = Math.max(0, Math.min(height - 1, fy * (height - 1)));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const v00 = grid[y0 * width + x0]!;
  const v10 = grid[y0 * width + x1]!;
  const v01 = grid[y1 * width + x0]!;
  const v11 = grid[y1 * width + x1]!;
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

/** Number of tiles spanned by a range, as { wide, high }. */
export function tileCount(range: TileRange): { wide: number; high: number } {
  return { wide: range.maxX - range.minX + 1, high: range.maxY - range.minY + 1 };
}
