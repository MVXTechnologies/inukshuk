/**
 * The personal heatmap as a pass-count grid (#465, #466). Every qualifying
 * trail is walked along its (simplified) geometry at sub-cell spacing and
 * binned into fixed ground cells; each cell remembers how many DISTINCT
 * trails crossed it (a slow walk counts once, like one fast pass), and each
 * step between two neighbouring cells becomes a graph edge with the same
 * distinct-trail count.
 *
 * Rendering then draws those edges as crisp lines through the cells' sample
 * centroids — the streets actually travelled, coloured by how many times —
 * plus one weighted point per coarse cell for the low-zoom glow. Both are
 * bounded by the ground the library covers, not by how many trails or fixes
 * it holds: a street run 300 times costs what a street run once does.
 *
 * Pure; numeric cell keys (no string building in the hot loops).
 */

import type { Feature, FeatureCollection, MultiLineString, Point } from 'geojson';

import { simplifyIndices } from '@core/geo/track/simplify';

/** Line-grid cell size: small enough to follow streets, big enough to merge GPS wobble. */
export const HEAT_LINE_CELL_M = 20;
/** Glow-grid cell size (low zooms, where a cell is a pixel or two). */
export const HEAT_GLOW_CELL_M = 120;

const M_PER_DEG = 111_320;
const COL_OFFSET = 2_097_152; // 2^21 > half the columns around Earth at 20 m
const ROW_STRIDE = 4_194_304; // 2^22

/** A trail's geometry: `[lng, lat]` parts (see `TrackGeometry`). */
export interface GridTrackInput {
  id: string;
  parts: readonly (readonly (readonly [number, number])[])[];
}

/** What one trail contributes to the grid (memoizable per trail). */
export interface TrackCellWalk {
  /** Distinct cells the trail visits. */
  cells: Set<number>;
  /** Distinct undirected edges (`a < b`) between consecutive visited cells. */
  edges: Set<string>;
  /** Per-cell sample sums, for the drawn centroid: [sumLng, sumLat, n]. */
  sums: Map<number, [number, number, number]>;
}

/** A grid with row-dependent column widths (square-ish cells at any latitude). */
export class CellGrid {
  readonly cellM: number;
  private readonly halfCols = new Map<number, number>();
  constructor(cellM: number) {
    if (!Number.isFinite(cellM) || cellM < 1 || cellM > 100_000) {
      throw new RangeError('Grid cell size must be between 1 m and 100 km');
    }
    this.cellM = cellM;
  }
  private halfColumns(row: number): number {
    let h = this.halfCols.get(row);
    if (h === undefined) {
      const lat = Math.max(-89.9, Math.min(89.9, ((row + 0.5) * this.cellM) / M_PER_DEG));
      const mPerDeg = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
      h = Math.max(1, Math.round((180 * mPerDeg) / this.cellM));
      this.halfCols.set(row, h);
    }
    return h;
  }
  /** Numeric key of the cell holding (lng, lat). */
  key(lng: number, lat: number): number {
    const row = Math.floor((lat * M_PER_DEG) / this.cellM);
    const half = this.halfColumns(row);
    const col = Math.min(half - 1, Math.floor(((lng === 180 ? -180 : lng) / 180) * half));
    return row * ROW_STRIDE + (col + COL_OFFSET);
  }
  /** Row/col of a key (for neighbourhood lookups and tests). */
  static unkey(key: number): { row: number; col: number } {
    const row = Math.floor(key / ROW_STRIDE);
    return { row, col: key - row * ROW_STRIDE - COL_OFFSET };
  }
  /** The cell and its 8 neighbours (neighbouring rows projected by longitude). */
  ring(key: number): number[] {
    return this.neighbourhood(key, 1);
  }
  /**
   * The (2·reach+1)² cells around `key`, wrapping at the dateline. Other
   * rows have slightly different column widths, so the centre column is
   * projected into each by longitude.
   */
  neighbourhood(key: number, reach: number): number[] {
    const { row, col } = CellGrid.unkey(key);
    const ratio = (col + 0.5) / this.halfColumns(row);
    const out: number[] = [];
    for (let dr = -reach; dr <= reach; dr++) {
      const r = row + dr;
      const half = this.halfColumns(r);
      const c0 = dr === 0 ? col : Math.floor(ratio * half);
      for (let dc = -reach; dc <= reach; dc++) {
        const c = ((((c0 + dc + half) % (2 * half)) + 2 * half) % (2 * half)) - half;
        out.push(r * ROW_STRIDE + (c + COL_OFFSET));
      }
    }
    return out;
  }
  /** Whether `b` is `a` or one of its 8 neighbours (allocation-free {@link ring} test). */
  isNeighbour(a: number, b: number): boolean {
    if (a === b) return true;
    const ra = Math.floor(a / ROW_STRIDE);
    const rb = Math.floor(b / ROW_STRIDE);
    const dr = rb - ra;
    if (dr < -1 || dr > 1) return false;
    const ca = a - ra * ROW_STRIDE - COL_OFFSET;
    const cb = b - rb * ROW_STRIDE - COL_OFFSET;
    const half = this.halfColumns(rb);
    const c0 = dr === 0 ? ca : Math.floor(((ca + 0.5) / this.halfColumns(ra)) * half);
    const dc = ((((cb - c0 + half) % (2 * half)) + 2 * half) % (2 * half)) - half;
    return dc >= -1 && dc <= 1;
  }
}

/**
 * Longest segment (m) painted. Simplified geometry legitimately has long
 * straight segments (a road ride keeps two vertices for kilometres); only a
 * jump beyond this — a GPS glitch across the map — is left unpainted. Same
 * reach as the pre-#465 heat trace (2048 half-cell samples of 12.5 m).
 */
export const MAX_BRIDGE_M = 25_000;

/**
 * Walk one trail's parts at ≤ half-cell spacing and collect its distinct
 * cells, edges and centroid sums. Consecutive samples in the same cell do not
 * repeat it; a jump longer than {@link MAX_BRIDGE_M} (a GPS glitch) breaks
 * the walk so no edge is invented across it.
 *
 * Edges come from a SMOOTHED cell path: a cell whose predecessor and
 * successor are already neighbours is a sideways wobble (GPS drifting across
 * a cell boundary, or a stair-step around a diagonal) and is skipped, so a
 * street is one line of edges instead of a zig-zag between two cell rows.
 * The wobble cell still counts as visited (tap and glow see it).
 */
export function walkTrackCells(input: GridTrackInput, grid: CellGrid): TrackCellWalk {
  const cells = new Set<number>();
  const edges = new Set<string>();
  const sums = new Map<number, [number, number, number]>();
  const step = grid.cellM / 2;
  let path: number[] = [];
  const flush = () => {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as number;
      const b = path[i] as number;
      if (a !== b) edges.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
    path = [];
  };
  const visit = (lng: number, lat: number) => {
    const k = grid.key(lng, lat);
    const s = sums.get(k);
    if (s) {
      s[0] += lng;
      s[1] += lat;
      s[2] += 1;
    } else sums.set(k, [lng, lat, 1]);
    cells.add(k);
    const top = path[path.length - 1];
    if (top === k) return;
    // Drop wobbles: while the cell before the top already touches k, the
    // top was a detour.
    while (path.length >= 2 && grid.isNeighbour(path[path.length - 2] as number, k)) path.pop();
    if (path[path.length - 1] !== k) path.push(k);
  };
  for (const part of input.parts) {
    flush();
    let open = false;
    for (let i = 0; i < part.length; i++) {
      const p = part[i];
      if (!p) continue;
      const [lng, lat] = p;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        flush();
        open = false;
        continue;
      }
      const q = i > 0 ? part[i - 1] : undefined;
      if (q && open) {
        const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
        const dx = (lng - q[0]) * kx;
        const dy = (lat - q[1]) * M_PER_DEG;
        const len = Math.hypot(dx, dy);
        if (len > MAX_BRIDGE_M) {
          flush();
        } else {
          const n = Math.floor(len / step);
          for (let s = 1; s <= n; s++) {
            const t = s / (n + 1);
            visit(q[0] + (lng - q[0]) * t, q[1] + (lat - q[1]) * t);
          }
        }
      }
      visit(lng, lat);
      open = true;
    }
  }
  flush();
  return { cells, edges, sums };
}

/** The whole library's grid. */
export interface HeatGrid {
  grid: CellGrid;
  /** cell → distinct trails through the cell itself. */
  cellCounts: Map<number, number>;
  /** cell → drawn position (centroid of every sample in it). */
  centroids: Map<number, [number, number]>;
  /** undirected edge "a:b" → distinct trails that stepped a↔b. */
  edgeCounts: Map<string, number>;
}

/** Merge per-trail walks (each trail counted once per cell/edge). */
export function buildHeatGrid(walks: readonly TrackCellWalk[], grid: CellGrid): HeatGrid {
  const cellCounts = new Map<number, number>();
  const edgeCounts = new Map<string, number>();
  const acc = new Map<number, [number, number, number]>();
  for (const w of walks) {
    for (const c of w.cells) cellCounts.set(c, (cellCounts.get(c) ?? 0) + 1);
    for (const e of w.edges) edgeCounts.set(e, (edgeCounts.get(e) ?? 0) + 1);
    for (const [c, s] of w.sums) {
      const a = acc.get(c);
      if (a) {
        a[0] += s[0];
        a[1] += s[1];
        a[2] += s[2];
      } else acc.set(c, [s[0], s[1], s[2]]);
    }
  }
  const centroids = new Map<number, [number, number]>();
  for (const [c, [x, y, n]] of acc) centroids.set(c, [x / n, y / n]);
  return { grid, cellCounts, centroids, edgeCounts };
}

/**
 * The pass count drawn for a cell: distinct trails in the cell's 3×3
 * neighbourhood, capped by the sum — so two recordings of one street that
 * wobble into neighbouring cells still read as two passes, not two lines of
 * one pass each. Approximated as the max over the ring (exact distinct
 * counting would need the id sets; the max never over-counts).
 */
function smoothedCount(g: HeatGrid, cell: number): number {
  let best = g.cellCounts.get(cell) ?? 0;
  for (const k of g.grid.ring(cell)) {
    const c = g.cellCounts.get(k);
    if (c !== undefined && c > best) best = c;
  }
  return best;
}

/** Pass-count buckets (log2): 1, 2, 3–4, 5–8, 9–16, 17–32, 33–64, 65+. */
export function passBucket(count: number): number {
  if (count <= 1) return 1;
  let b = 2;
  while (b < count && b < 128) b *= 2;
  return b;
}

export interface HeatLineProps {
  /** Representative pass count (bucket upper bound, see {@link passBucket}). */
  count: number;
}

/** Tolerance (m) when straightening chains through cell centroids. */
const CHAIN_SIMPLIFY_M = 4;

/**
 * The grid's edges as polylines through cell centroids: ONE MultiLineString
 * feature per pass bucket, sorted by count (hot drawn last, on top). Edges
 * are chained through cells where exactly two same-bucket edges meet, so a
 * street reads as one smooth line, not a string of beads, and each chain is
 * straightened (centroids along a straight street are collinear to within
 * GPS noise). The feature count is the number of buckets (≤ 8).
 */
export function heatGridLines(g: HeatGrid): FeatureCollection<MultiLineString, HeatLineProps> {
  // bucket → adjacency (cell → neighbours) of that bucket's edges.
  const byBucket = new Map<number, Map<number, number[]>>();
  for (const [e, n] of g.edgeCounts) {
    const sep = e.indexOf(':');
    const a = Number(e.slice(0, sep));
    const b = Number(e.slice(sep + 1));
    const count = Math.max(n, Math.min(smoothedCount(g, a), smoothedCount(g, b)));
    const bucket = passBucket(count);
    let adj = byBucket.get(bucket);
    if (!adj) {
      adj = new Map();
      byBucket.set(bucket, adj);
    }
    const la = adj.get(a);
    if (la) la.push(b);
    else adj.set(a, [b]);
    const lb = adj.get(b);
    if (lb) lb.push(a);
    else adj.set(b, [a]);
  }
  const features: Feature<MultiLineString, HeatLineProps>[] = [];
  const buckets = [...byBucket.keys()].sort((x, y) => x - y);
  for (const bucket of buckets) {
    const adj = byBucket.get(bucket) as Map<number, number[]>;
    const lines: [number, number][][] = [];
    const used = new Set<string>();
    const ek = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    const extend = (from: number, to: number, chain: number[]) => {
      let prev = from;
      let cur = to;
      for (;;) {
        chain.push(cur);
        const next = adj.get(cur);
        if (!next || next.length !== 2) return;
        const nxt = next[0] === prev ? next[1] : next[0];
        if (nxt === undefined || used.has(ek(cur, nxt))) return;
        used.add(ek(cur, nxt));
        prev = cur;
        cur = nxt;
      }
    };
    // Start chains at endpoints/junctions first, then sweep leftover cycles.
    const starts = [...adj.keys()].sort(
      (x, y) => Number((adj.get(x)?.length ?? 0) === 2) - Number((adj.get(y)?.length ?? 0) === 2),
    );
    for (const s of starts) {
      for (const t of adj.get(s) ?? []) {
        if (used.has(ek(s, t))) continue;
        used.add(ek(s, t));
        const chain = [s];
        extend(s, t, chain);
        const pts: { longitude: number; latitude: number }[] = [];
        for (const c of chain) {
          const p = g.centroids.get(c);
          if (p) pts.push({ longitude: p[0], latitude: p[1] });
        }
        if (pts.length < 2) continue;
        const line: [number, number][] = [];
        for (const i of simplifyIndices(pts, CHAIN_SIMPLIFY_M)) {
          const p = pts[i];
          if (p)
            line.push([Math.round(p.longitude * 1e5) / 1e5, Math.round(p.latitude * 1e5) / 1e5]);
        }
        lines.push(line);
      }
    }
    if (lines.length > 0) {
      features.push({
        type: 'Feature',
        geometry: { type: 'MultiLineString', coordinates: lines },
        properties: { count: bucket },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

export interface HeatGlowProps {
  /** Distinct trails in the coarse cell (drives `heatmap-weight`). */
  count: number;
}

/**
 * One weighted point per occupied coarse cell, for the low-zoom glow layer.
 * The count is the most-travelled fine cell inside it (distinct trails, so a
 * pass is a pass however slow).
 */
export function heatGlowPoints(
  g: HeatGrid,
  coarse: CellGrid = new CellGrid(HEAT_GLOW_CELL_M),
): FeatureCollection<Point, HeatGlowProps> {
  const agg = new Map<number, { x: number; y: number; n: number; count: number }>();
  for (const [cell, count] of g.cellCounts) {
    const p = g.centroids.get(cell);
    if (!p) continue;
    const k = coarse.key(p[0], p[1]);
    const a = agg.get(k);
    if (a) {
      a.x += p[0];
      a.y += p[1];
      a.n += 1;
      if (count > a.count) a.count = count;
    } else agg.set(k, { x: p[0], y: p[1], n: 1, count });
  }
  const features: Feature<Point, HeatGlowProps>[] = [];
  for (const a of agg.values()) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [Math.round((a.x / a.n) * 1e6) / 1e6, Math.round((a.y / a.n) * 1e6) / 1e6],
      },
      properties: { count: a.count },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---- tap / hot-spot index ---------------------------------------------------

/** cell → categoryId → trail ids through that cell (in input order). */
export type GridIndex = Map<number, Map<string, string[]>>;

/** One trail for the tap index: its visited cells (see {@link walkTrackCells}). */
export interface GridIndexInput {
  id: string;
  categoryId: string;
  cells: ReadonlySet<number>;
}

/** Index trails by the cells they visit (each trail once per cell). */
export function buildGridIndex(inputs: readonly GridIndexInput[]): GridIndex {
  const index: GridIndex = new Map();
  for (const t of inputs) {
    for (const c of t.cells) {
      let byCategory = index.get(c);
      if (!byCategory) {
        byCategory = new Map();
        index.set(c, byCategory);
      }
      const ids = byCategory.get(t.categoryId);
      if (ids) ids.push(t.id);
      else byCategory.set(t.categoryId, [t.id]);
    }
  }
  return index;
}

/**
 * How far (in cells, each way) a tap reaches around its cell: 2 × 20 m, the
 * same ±40–50 m window the dilated 25 m trace plus its ring used to give, so
 * two recordings of one street a few metres apart still meet.
 */
export const TAP_REACH_CELLS = 2;

/**
 * Trails around a cell: every trail id in its neighbourhood (first-seen
 * order) and whether any single category has ≥ 2 distinct trails there.
 */
export function gridTrailsNear(
  index: GridIndex,
  grid: CellGrid,
  cell: number,
  reach: number = TAP_REACH_CELLS,
): { trackIds: string[]; hot: boolean } {
  const perCategory = new Map<string, Set<string>>();
  const trackIds: string[] = [];
  const seen = new Set<string>();
  for (const k of grid.neighbourhood(cell, reach)) {
    const byCategory = index.get(k);
    if (!byCategory) continue;
    for (const [categoryId, ids] of byCategory) {
      let set = perCategory.get(categoryId);
      if (!set) {
        set = new Set();
        perCategory.set(categoryId, set);
      }
      for (const id of ids) {
        set.add(id);
        if (!seen.has(id)) {
          seen.add(id);
          trackIds.push(id);
        }
      }
    }
  }
  let hot = false;
  for (const set of perCategory.values()) {
    if (set.size >= 2) {
      hot = true;
      break;
    }
  }
  return { trackIds, hot };
}

/** Upper bound on the tap search radius: keeps a zoomed-out tap cheap. */
export const MAX_GRID_TAP_RADIUS_M = 3000;

/**
 * {@link gridTrailsNear} with a finger tolerance in metres: the tap's own
 * neighbourhood first, then outward in rings of sample points spaced one
 * neighbourhood apart, returning the NEAREST hit (so the closest trail wins).
 * The work is bounded by the radius, never by the library's size.
 */
export function gridTrailsNearWithin(
  index: GridIndex,
  grid: CellGrid,
  lng: number,
  lat: number,
  radiusM: number,
  reach: number = TAP_REACH_CELLS,
): { trackIds: string[]; hot: boolean } {
  const centre = gridTrailsNear(index, grid, grid.key(lng, lat), reach);
  const radius = Math.min(Math.max(0, radiusM), MAX_GRID_TAP_RADIUS_M);
  const span = grid.cellM * (2 * reach + 1);
  if (centre.trackIds.length > 0 || radius <= grid.cellM * reach) return centre;
  const mPerDegLng = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const steps = Math.ceil(radius / span);
  const samples: { d: number; dx: number; dy: number }[] = [];
  for (let iy = -steps; iy <= steps; iy++) {
    for (let ix = -steps; ix <= steps; ix++) {
      const dx = ix * span;
      const dy = iy * span;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d <= radius + span / 2) samples.push({ d, dx, dy });
    }
  }
  samples.sort((a, b) => a.d - b.d);
  const tried = new Set<number>();
  for (const { dx, dy } of samples) {
    const cell = grid.key(lng + dx / mPerDegLng, lat + dy / M_PER_DEG);
    if (tried.has(cell)) continue;
    tried.add(cell);
    const found = gridTrailsNear(index, grid, cell, reach);
    if (found.trackIds.length > 0) return found;
  }
  return { trackIds: [], hot: false };
}
