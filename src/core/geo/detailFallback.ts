import type { BoundingBox } from '@core/models';

/**
 * Keeping the detail you already have while its replacement renders (#344).
 *
 * A detail tile is cached under a key that includes the camera-derived crop
 * and raster width, so panning reuses tiles — the keys still match — but any
 * change of zoom invalidates every key at once. The screen then had nothing
 * to show until the new tiles finished, which reads as the map unloading and
 * re-rendering on every pinch.
 *
 * This picks the already-rendered tiles worth keeping underneath the new ones,
 * the way a tile map holds a parent tile until its children arrive.
 */

/** What this needs from a cached tile; `Detail` in the hook satisfies it. */
export interface FallbackCandidate {
  cacheKey: string;
  /** Identity of the page this refines. Changes when the document does. */
  overviewKey: string;
  bbox: BoundingBox;
  pixels: number;
}

export interface FallbackChoice<T extends FallbackCandidate> {
  /** Most-recently-used first; draw these UNDER the fresh tiles. */
  keep: T[];
  /** Pixels the kept tiles add on top of the fresh ones. */
  pixels: number;
}

const intersects = (a: BoundingBox, b: BoundingBox): boolean =>
  a.minLng < b.maxLng && a.maxLng > b.minLng && a.minLat < b.maxLat && a.maxLat > b.minLat;

const contains = (outer: BoundingBox, inner: BoundingBox): boolean =>
  outer.minLng <= inner.minLng &&
  outer.maxLng >= inner.maxLng &&
  outer.minLat <= inner.minLat &&
  outer.maxLat >= inner.maxLat;

/**
 * The region the camera is refining, taken as the union of the tiles it asked
 * for. Using the targets rather than the raw camera bounds keeps this honest
 * when only part of the view is a PDF page — and needs no extra state.
 */
export function unionOfBboxes(boxes: readonly BoundingBox[]): BoundingBox | null {
  let union: BoundingBox | null = null;
  for (const b of boxes) {
    union =
      union === null
        ? { ...b }
        : {
            minLng: Math.min(union.minLng, b.minLng),
            minLat: Math.min(union.minLat, b.minLat),
            maxLng: Math.max(union.maxLng, b.maxLng),
            maxLat: Math.max(union.maxLat, b.maxLat),
          };
  }
  return union;
}

export interface FallbackInput<T extends FallbackCandidate> {
  /** Cached tiles, most-recently-used FIRST. */
  cached: readonly T[];
  /** Cache keys already being shown at the current camera. */
  freshKeys: ReadonlySet<string>;
  /** Areas the fresh tiles already cover — a tile inside one adds nothing. */
  freshBboxes: readonly BoundingBox[];
  /** Overview identities still on screen. A tile from any other is dropped. */
  liveOverviewKeys: ReadonlySet<string>;
  /** What the camera can see; a tile outside it is not worth a texture. */
  bounds: BoundingBox | null;
  budgetPixels: number;
  maxCount: number;
}

/**
 * Which cached tiles to keep showing.
 *
 * A tile is kept when it belongs to a page still on screen, is not already
 * being drawn fresh, overlaps what the camera sees, and is not swallowed whole
 * by a fresh tile. Budget and count are hard limits: this trades GPU memory
 * for continuity, and only up to a point.
 *
 * The overview-identity check is the one that must not be dropped. A tile's
 * geography is only meaningful for the document that produced it, so a page
 * whose georeferencing has been re-parsed, or whose PDF has been replaced,
 * must never keep drawing tiles from before.
 */
export function chooseFallbackDetails<T extends FallbackCandidate>({
  cached,
  freshKeys,
  freshBboxes,
  liveOverviewKeys,
  bounds,
  budgetPixels,
  maxCount,
}: FallbackInput<T>): FallbackChoice<T> {
  if (bounds === null || budgetPixels <= 0 || maxCount <= 0) return { keep: [], pixels: 0 };

  const keep: T[] = [];
  let pixels = 0;
  for (const tile of cached) {
    if (keep.length >= maxCount) break;
    if (freshKeys.has(tile.cacheKey)) continue;
    if (!liveOverviewKeys.has(tile.overviewKey)) continue;
    if (!intersects(tile.bbox, bounds)) continue;
    if (freshBboxes.some((fresh) => contains(fresh, tile.bbox))) continue;
    if (pixels + tile.pixels > budgetPixels) continue;
    pixels += tile.pixels;
    keep.push(tile);
  }
  return { keep, pixels };
}
