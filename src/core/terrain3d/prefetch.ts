/**
 * Which DEM tiles to ask for, in what order. Visible tiles fall back to
 * their nearest loaded ancestor DEM, so the order is: a coarse ancestor first
 * (one fetch covers a whole area with approximate heights), then the tile's
 * own DEM, nearest tiles first; then a prefetch ring ahead of the camera, so
 * a pan or a rotate finds its heights already decoded.
 */
import { demKey, demNeighbor, demWindow, type DemId, type TileId } from './tiles';

/** Ancestor this many zooms up is requested before a tile's own DEM. */
export const COARSE_LEAD = 3;
/** Never prefetch coarser than this (z0–4 cost almost nothing anyway). */
export const MIN_PREFETCH_ZOOM = 0;

export interface PlanInput {
  /** Visible terrain tiles, nearest first. */
  tiles: readonly TileId[];
  /** Compass bearing the view faces, degrees. */
  bearingDeg: number;
  isLoaded: (d: DemId) => boolean;
  /** Also skip DEMs already in flight / failed recently. */
  isPending?: (d: DemId) => boolean;
  maxRequests: number;
}

/**
 * Ordered, de-duplicated DEM requests (only ones neither loaded nor pending).
 */
export function planDemRequests(p: PlanInput): DemId[] {
  const out: DemId[] = [];
  const seen = new Set<string>();
  const want = (d: DemId) => {
    if (out.length >= p.maxRequests) return;
    const k = demKey(d);
    if (seen.has(k)) return;
    seen.add(k);
    if (p.isLoaded(d) || p.isPending?.(d)) return;
    out.push(d);
  };
  const own: DemId[] = [];
  for (const t of p.tiles) {
    const d = demWindow(t).dem;
    const az = Math.max(MIN_PREFETCH_ZOOM, d.z - COARSE_LEAD);
    const k = d.z - az;
    want({ z: az, x: d.x >> k, y: d.y >> k });
    want(d);
    own.push(d);
  }
  // Prefetch ring: the neighbours of visible DEMs that lie ahead of the view.
  const b = (p.bearingDeg * Math.PI) / 180;
  const fx = Math.sin(b);
  const fy = -Math.cos(b); // tile y grows south
  for (const d of own) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (dx * fx + dy * fy <= 0.3) continue;
        const n = demNeighbor(d, dx, dy);
        if (n) want(n);
      }
    }
  }
  return out;
}

/**
 * Heights for a tile come from the deepest loaded DEM among the tile's own
 * window zoom and its ancestors. Returns that zoom, or null when nothing
 * above the tile is loaded (the tile draws flat).
 */
export function bestLoadedDemZoom(t: TileId, isLoaded: (d: DemId) => boolean): number | null {
  const own = demWindow(t).dem;
  for (let z = own.z; z >= 0; z--) {
    const k = own.z - z;
    if (isLoaded({ z, x: own.x >> k, y: own.y >> k })) return z;
  }
  return null;
}
