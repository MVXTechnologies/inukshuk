/**
 * A static spatial index of bounding boxes (#494): which trails could be on
 * screen, answered from each trail's precomputed `stats.bbox` without reading
 * any geometry. A uniform lat/lng bucket grid — trails are small next to the
 * world and a library's trails cluster, so a grid beats an R-tree on build
 * cost and is plenty for a query per camera settle.
 *
 * - A box crossing the antimeridian (`minLng > maxLng`) is indexed as its two
 *   halves; so is a query box that crosses it.
 * - A box covering more than {@link MAX_CELLS_PER_ENTRY} cells (a cross-country
 *   ride, a GPS glitch spanning a continent) goes to a short "wide" list that
 *   every query tests directly, so one huge trail cannot bloat the grid.
 * - An invalid box (non-finite, or min > max in latitude) can't be culled:
 *   it is returned by every query, so a trail is never hidden by bad data.
 *
 * Query results are ids in insertion order (callers rely on it for stable
 * source ordering), each id once.
 *
 * Pure.
 */

import type { BoundingBox } from '@core/models';

export interface BBoxEntry {
  id: string;
  bbox: BoundingBox;
}

export interface BBoxIndex {
  /** Entries indexed (invalid boxes included). */
  readonly size: number;
  /** Ids of the entries whose box intersects `bounds`, in insertion order. */
  query(bounds: BoundingBox): string[];
}

/** Grid cell size (degrees): ~11 km of latitude, a few trails per cell in a dense city. */
export const BBOX_INDEX_CELL_DEG = 0.1;
/** Boxes spanning more cells than this skip the grid (tested on every query instead). */
export const MAX_CELLS_PER_ENTRY = 400;

/** One non-wrapping [west, east] × [south, north] rectangle. */
export interface Rect {
  w: number;
  s: number;
  e: number;
  n: number;
}

const isFiniteBox = (b: BoundingBox): boolean =>
  Number.isFinite(b.minLat) &&
  Number.isFinite(b.maxLat) &&
  Number.isFinite(b.minLng) &&
  Number.isFinite(b.maxLng) &&
  b.minLat <= b.maxLat;

/** Clamp a longitude into [-180, 180] (a box never needs more). */
const clampLng = (lng: number) => Math.max(-180, Math.min(180, lng));
const clampLat = (lat: number) => Math.max(-90, Math.min(90, lat));

/**
 * A box as non-wrapping rectangles: one, or two when it crosses the
 * antimeridian (`minLng > maxLng`). A box at least 360° wide is the world.
 */
export function boxRects(b: BoundingBox): Rect[] {
  const s = clampLat(b.minLat);
  const n = clampLat(b.maxLat);
  if (b.maxLng - b.minLng >= 360) return [{ w: -180, s, e: 180, n }];
  const w = clampLng(b.minLng);
  const e = clampLng(b.maxLng);
  if (b.minLng <= b.maxLng) return [{ w, s, e, n }];
  return [
    { w, s, e: 180, n },
    { w: -180, s, e, n },
  ];
}

const rectsMeet = (a: Rect, b: Rect): boolean =>
  a.w <= b.e && b.w <= a.e && a.s <= b.n && b.s <= a.n;

/** Whether two boxes intersect (edges touching count), antimeridian-aware. */
export function boxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  if (!isFiniteBox(a) || !isFiniteBox(b)) return false;
  for (const ra of boxRects(a)) for (const rb of boxRects(b)) if (rectsMeet(ra, rb)) return true;
  return false;
}

export function buildBBoxIndex(
  entries: readonly BBoxEntry[],
  cellDeg: number = BBOX_INDEX_CELL_DEG,
): BBoxIndex {
  if (!(cellDeg > 0) || !Number.isFinite(cellDeg)) {
    throw new RangeError('Index cell size must be a positive number of degrees');
  }
  const cols = Math.ceil(360 / cellDeg);
  const rows = Math.ceil(180 / cellDeg);
  const col = (lng: number) => Math.min(cols - 1, Math.max(0, Math.floor((lng + 180) / cellDeg)));
  const row = (lat: number) => Math.min(rows - 1, Math.max(0, Math.floor((lat + 90) / cellDeg)));

  const cells = new Map<number, number[]>();
  /** Entries every query tests directly: wide boxes. */
  const wide: number[] = [];
  /** Entries every query returns: boxes that can't be culled. */
  const always: number[] = [];
  const rects: Rect[][] = [];

  entries.forEach((entry, i) => {
    if (!isFiniteBox(entry.bbox)) {
      always.push(i);
      rects.push([]);
      return;
    }
    const parts = boxRects(entry.bbox);
    rects.push(parts);
    let span = 0;
    for (const r of parts) span += (col(r.e) - col(r.w) + 1) * (row(r.n) - row(r.s) + 1);
    if (span > MAX_CELLS_PER_ENTRY) {
      wide.push(i);
      return;
    }
    for (const r of parts) {
      for (let y = row(r.s); y <= row(r.n); y++) {
        for (let x = col(r.w); x <= col(r.e); x++) {
          const k = y * cols + x;
          const list = cells.get(k);
          if (list) list.push(i);
          else cells.set(k, [i]);
        }
      }
    }
  });

  return {
    size: entries.length,
    query(bounds: BoundingBox): string[] {
      if (!isFiniteBox(bounds)) return [];
      const queryRects = boxRects(bounds);
      const hit = new Uint8Array(entries.length);
      const found: number[] = [];
      const consider = (i: number) => {
        if (hit[i]) return;
        hit[i] = 1;
        const own = rects[i] ?? [];
        for (const a of own) {
          for (const b of queryRects) {
            if (rectsMeet(a, b)) {
              found.push(i);
              return;
            }
          }
        }
      };
      let queryCells = 0;
      for (const r of queryRects)
        queryCells += (col(r.e) - col(r.w) + 1) * (row(r.n) - row(r.s) + 1);
      if (queryCells > cells.size) {
        // A world-sized query: walking the occupied cells is cheaper than the grid.
        for (const list of cells.values()) for (const i of list) consider(i);
      } else {
        for (const r of queryRects) {
          for (let y = row(r.s); y <= row(r.n); y++) {
            for (let x = col(r.w); x <= col(r.e); x++) {
              const list = cells.get(y * cols + x);
              if (list) for (const i of list) consider(i);
            }
          }
        }
      }
      for (const i of wide) consider(i);
      for (const i of always) {
        if (!hit[i]) {
          hit[i] = 1;
          found.push(i);
        }
      }
      found.sort((a, b) => a - b);
      return found.flatMap((i) => {
        const entry = entries[i];
        return entry ? [entry.id] : [];
      });
    },
  };
}
