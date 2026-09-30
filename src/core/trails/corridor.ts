import { estimateBytes, overviewZoomFor, type PackFormat } from '@core/geo/tiles';
import type { BoundingBox, LngLat } from '@core/models';

import { haversineM } from './geometry';

/**
 * The offline download along a trail (#467, "Download · offline map along the
 * whole trail, ≈3 km each side").
 *
 * MapLibre offline packs are rectangles, and one rectangle around a 300 km
 * trail would be mostly off-trail. So the trail is cut into CHUNKS whose
 * extent stays under `maxSpanKm`, and each chunk's box — grown by the buffer
 * on every side — becomes one pack. Consecutive chunks share their joining
 * vertex, so the boxes overlap there and the corridor has no gap; tiles in
 * the overlap are stored once by MapLibre (packs share one tile database), and
 * the size estimate counts each tile once too.
 */

export const CORRIDOR_BUFFER_M = 3000;
export const CORRIDOR_MAX_SPAN_KM = 20;
/** Deepest zoom a corridor pack stores (the vector base map's own max). */
export const CORRIDOR_MAX_ZOOM = 15;
/** Beyond these the whole-trail download is refused (a continent's worth of packs). */
export const CORRIDOR_MAX_BOXES = 120;
export const CORRIDOR_MAX_BYTES = 2_000_000_000;

const M_PER_DEG_LAT = 111_320;

function spanKm(b: BoundingBox): { w: number; h: number } {
  const midLat = (b.minLat + b.maxLat) / 2;
  const w = haversineM([b.minLng, midLat], [b.maxLng, midLat]) / 1000;
  const h = ((b.maxLat - b.minLat) * M_PER_DEG_LAT) / 1000;
  return { w, h };
}

function grow(b: BoundingBox, p: LngLat): BoundingBox {
  return {
    minLng: Math.min(b.minLng, p[0]),
    minLat: Math.min(b.minLat, p[1]),
    maxLng: Math.max(b.maxLng, p[0]),
    maxLat: Math.max(b.maxLat, p[1]),
  };
}

const boxAt = (p: LngLat): BoundingBox => ({
  minLng: p[0],
  minLat: p[1],
  maxLng: p[0],
  maxLat: p[1],
});

/** Grow a box by `bufferM` on every side (clamped to the world). */
export function bufferBox(b: BoundingBox, bufferM: number): BoundingBox {
  const dLat = bufferM / M_PER_DEG_LAT;
  const cos = Math.max(0.05, Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180));
  const dLng = bufferM / (M_PER_DEG_LAT * cos);
  return {
    minLng: Math.max(-180, b.minLng - dLng),
    minLat: Math.max(-85, b.minLat - dLat),
    maxLng: Math.min(180, b.maxLng + dLng),
    maxLat: Math.min(85, b.maxLat + dLat),
  };
}

/** Densify so no segment is longer than `maxM` (a straight 40 km ferry leg). */
function densify(part: readonly LngLat[], maxM: number): LngLat[] {
  const out: LngLat[] = [];
  part.forEach((p, i) => {
    const prev = part[i - 1];
    if (prev !== undefined) {
      const d = haversineM(prev, p);
      const n = Math.ceil(d / maxM);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push([prev[0] + (p[0] - prev[0]) * t, prev[1] + (p[1] - prev[1]) * t]);
      }
    }
    out.push(p);
  });
  return out;
}

/** The corridor's boxes, in trail order. */
export function corridorBoxes(
  parts: readonly (readonly LngLat[])[],
  bufferM = CORRIDOR_BUFFER_M,
  maxSpanKm = CORRIDOR_MAX_SPAN_KM,
): BoundingBox[] {
  const boxes: BoundingBox[] = [];
  for (const raw of parts) {
    const part = densify(raw, (maxSpanKm * 1000) / 2);
    const first = part[0];
    if (first === undefined) continue;
    let box = boxAt(first);
    for (let i = 1; i < part.length; i++) {
      const p = part[i];
      if (p === undefined) continue;
      const next = grow(box, p);
      const { w, h } = spanKm(next);
      if (w > maxSpanKm || h > maxSpanKm) {
        boxes.push(box);
        const prev = part[i - 1] ?? p;
        box = grow(boxAt(prev), p);
      } else {
        box = next;
      }
    }
    boxes.push(box);
  }
  return boxes.map((b) => bufferBox(b, bufferM));
}

const lngToX = (lng: number, z: number) => Math.floor(((lng + 180) / 360) * 2 ** z);
const latToY = (lat: number, z: number) => {
  const r = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  return Math.max(0, Math.min(2 ** z - 1, y));
};

/** Tiles to enumerate before falling back to a (double-counting) sum. */
const UNIQUE_TILE_LIMIT = 500_000;

/**
 * Distinct tiles the packs store: each box from its own overview zoom to
 * `maxZoom`, the overlaps counted once.
 */
export function corridorTileCount(boxes: readonly BoundingBox[], maxZoom: number): number {
  let total = 0;
  for (let z = 0; z <= maxZoom; z++) {
    const seen = new Set<number>();
    let sum = 0;
    for (const b of boxes) {
      if (overviewZoomFor(b) > z) continue;
      const x0 = lngToX(b.minLng, z);
      const x1 = lngToX(b.maxLng, z);
      const y0 = latToY(b.maxLat, z);
      const y1 = latToY(b.minLat, z);
      sum += (x1 - x0 + 1) * (y1 - y0 + 1);
      if (sum > UNIQUE_TILE_LIMIT) continue;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) seen.add(x * 2 ** z + y);
    }
    total += sum > UNIQUE_TILE_LIMIT ? sum : seen.size;
  }
  return total;
}

export interface CorridorPlan {
  boxes: BoundingBox[];
  tiles: number;
  bytes: number;
  /** Too many packs or bytes for one download. */
  tooBig: boolean;
}

export function planCorridorDownload(
  parts: readonly (readonly LngLat[])[],
  format: PackFormat,
  options?: { bufferM?: number; maxZoom?: number },
): CorridorPlan {
  const boxes = corridorBoxes(parts, options?.bufferM ?? CORRIDOR_BUFFER_M);
  const tiles = corridorTileCount(boxes, options?.maxZoom ?? CORRIDOR_MAX_ZOOM);
  const bytes = estimateBytes(tiles, 'map', format);
  return {
    boxes,
    tiles,
    bytes,
    tooBig: boxes.length === 0 || boxes.length > CORRIDOR_MAX_BOXES || bytes > CORRIDOR_MAX_BYTES,
  };
}
