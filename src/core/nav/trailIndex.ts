import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';

/**
 * A trail prepared for following (#678): its vertices in local metres, the
 * distance along the trail at every vertex, and a uniform grid of its
 * segments so "where is the nearest point of the trail" never has to scan
 * every segment.
 *
 * ## Axes
 *
 * - **Geometry** is a local equirectangular projection centred on the trail
 *   (metres east / north of the trail's bbox centre). Over a trail's extent
 *   (tens of km) its distortion is far below GPS noise, and it makes the
 *   point-to-segment maths plain 2D. Trails that cross the antimeridian are
 *   not supported (none of the app's trails do).
 * - **Distance along** uses the same haversine steps as the trail's own stats
 *   and notes, and skips pause gaps exactly like
 *   `interpolateTrackAtDistance(points, d, segmentStarts)`: a pause is not
 *   walked, so a trail note's `distanceM` is directly a position on this axis.
 *   The edge across a pause is not a segment either: you cannot be "on" it.
 *
 * ## Cost
 *
 * `prepareTrail` is O(n) once per followed trail (plus the grid's cells).
 * `nearestOnTrail` visits only the segments registered in the grid cells of a
 * square around the query, doubling the square until the answer is provably
 * the nearest: O(segments near the point) on or near the trail. A query far
 * from the trail degrades towards O(n); the tracker (`trailTracker.ts`) only
 * calls it on (re)acquisition and throttles it while far away.
 */

const EARTH_RADIUS_M = 6371008.8;
const DEG2RAD = Math.PI / 180;

/** The grid's maximum cells per side; the cell grows with the trail. */
const GRID_MAX_SIDE = 128;
/** The smallest grid cell, metres. */
const GRID_MIN_CELL_M = 25;

export interface PreparedTrail {
  /** Vertex count after dropping consecutive duplicates. */
  readonly n: number;
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  /** Local metres east of the projection origin. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Distance along the trail at each vertex, metres (pause gaps not walked). */
  readonly along: Float64Array;
  /** Haversine length of edge i → i+1 (0 across a pause gap). */
  readonly edgeLen: Float64Array;
  /** 1 when edge i → i+1 is a real segment, 0 across a pause gap. */
  readonly segActive: Uint8Array;
  /** Total distance along the trail, metres. */
  readonly lengthM: number;
  /** Projection: metres per degree of longitude / latitude, and the origin. */
  readonly kx: number;
  readonly ky: number;
  readonly lon0: number;
  readonly lat0: number;
  readonly grid: TrailGrid;
}

interface TrailGrid {
  readonly cellM: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  /** cell index (row * cols + col) → segment indices registered there. */
  readonly cells: Map<number, number[]>;
}

/** A point on the trail, as seen from somewhere. */
export interface TrailProjection {
  /** Index of the segment (edge seg → seg+1) holding the point. */
  seg: number;
  /** Fraction along that segment, [0, 1]. */
  t: number;
  /** Distance along the trail, metres. */
  alongM: number;
  /** Straight-line distance from the query to that point, metres. */
  distM: number;
}

/** Work done by a query, for tests and the performance notes ("measure, don't assert"). */
export interface QueryCost {
  /** Point-to-segment projections computed. */
  segments: number;
  /** Grid cells looked up. */
  cells: number;
}

/**
 * Prepare `points` for following. `segmentStarts` are the indices where a new
 * recorded segment starts (after a pause), as `parseGpx` reports them.
 * Consecutive duplicate points are dropped (their indices then shift; the
 * gap set is remapped). Returns null for an empty trail.
 */
export function prepareTrail(
  points: readonly LatLng[],
  segmentStarts: readonly number[] = [],
): PreparedTrail | null {
  const gapAt = new Set(segmentStarts);
  const lat: number[] = [];
  const lon: number[] = [];
  // gapBefore[k] = a pause precedes kept vertex k.
  const gapBefore: boolean[] = [];
  let pendingGap = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    if (gapAt.has(i)) pendingGap = true;
    const k = lat.length;
    if (k > 0 && lat[k - 1] === p.latitude && lon[k - 1] === p.longitude) continue;
    lat.push(p.latitude);
    lon.push(p.longitude);
    gapBefore.push(k > 0 && pendingGap);
    pendingGap = false;
  }
  const n = lat.length;
  if (n === 0) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < n; i++) {
    const la = lat[i]!;
    const lo = lon[i]!;
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }
  const lat0 = (minLat + maxLat) / 2;
  const lon0 = (minLon + maxLon) / 2;
  const ky = EARTH_RADIUS_M * DEG2RAD;
  const kx = ky * Math.cos(lat0 * DEG2RAD);

  const latA = Float64Array.from(lat);
  const lonA = Float64Array.from(lon);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (lonA[i]! - lon0) * kx;
    y[i] = (latA[i]! - lat0) * ky;
  }

  const along = new Float64Array(n);
  const edgeLen = new Float64Array(Math.max(0, n - 1));
  const segActive = new Uint8Array(Math.max(0, n - 1));
  for (let i = 0; i + 1 < n; i++) {
    const active = !gapBefore[i + 1];
    segActive[i] = active ? 1 : 0;
    const len = active
      ? haversineMeters(
          { latitude: latA[i]!, longitude: lonA[i]! },
          { latitude: latA[i + 1]!, longitude: lonA[i + 1]! },
        )
      : 0;
    edgeLen[i] = len;
    along[i + 1] = along[i]! + len;
  }

  const grid = buildGrid(x, y, segActive, n);
  return {
    n,
    lat: latA,
    lon: lonA,
    x,
    y,
    along,
    edgeLen,
    segActive,
    lengthM: along[n - 1]!,
    kx,
    ky,
    lon0,
    lat0,
    grid,
  };
}

function buildGrid(x: Float64Array, y: Float64Array, segActive: Uint8Array, n: number): TrailGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, x[i]!);
    maxX = Math.max(maxX, x[i]!);
    minY = Math.min(minY, y[i]!);
    maxY = Math.max(maxY, y[i]!);
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  const cellM = Math.max(GRID_MIN_CELL_M, extent / GRID_MAX_SIDE);
  const cols = Math.floor((maxX - minX) / cellM) + 1;
  const rows = Math.floor((maxY - minY) / cellM) + 1;
  const cells = new Map<number, number[]>();
  const add = (cx: number, cy: number, seg: number) => {
    const key = cy * cols + cx;
    const list = cells.get(key);
    if (!list) cells.set(key, [seg]);
    else if (list[list.length - 1] !== seg) list.push(seg);
  };
  // Register each segment in the cells of samples taken every half cell along
  // it. A segment can then miss a cell it only clips at a corner, which the
  // query's one-cell acceptance margin covers (see nearestOnTrail).
  for (let i = 0; i + 1 < n; i++) {
    if (!segActive[i]) continue;
    const ax = x[i]!;
    const ay = y[i]!;
    const dx = x[i + 1]! - ax;
    const dy = y[i + 1]! - ay;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (cellM / 2)));
    for (let s = 0; s <= steps; s++) {
      const px = ax + (dx * s) / steps;
      const py = ay + (dy * s) / steps;
      add(cellOf(px - minX, cellM, cols), cellOf(py - minY, cellM, rows), i);
    }
  }
  // A one-point trail (or one made only of pause gaps) has no segment: its
  // vertex 0 is registered as a pseudo-segment the projection handles.
  if (cells.size === 0) add(0, 0, -1);
  return { cellM, minX, minY, cols, rows, cells };
}

function cellOf(v: number, cellM: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor(v / cellM)));
}

/** Local metres of a coordinate in the trail's projection. */
export function toLocal(trail: PreparedTrail, p: LatLng): { x: number; y: number } {
  return { x: (p.longitude - trail.lon0) * trail.kx, y: (p.latitude - trail.lat0) * trail.ky };
}

/**
 * Project local point (px, py) onto segment `seg`. Segment -1 is the
 * degenerate one-point trail. Pure maths, O(1).
 */
export function projectOnSegment(
  trail: PreparedTrail,
  seg: number,
  px: number,
  py: number,
): TrailProjection {
  if (seg < 0 || seg + 1 >= trail.n) {
    const i = seg < 0 ? 0 : Math.min(seg, trail.n - 1);
    return {
      seg: Math.max(0, Math.min(seg, trail.n - 2)),
      t: 0,
      alongM: trail.along[i]!,
      distM: Math.hypot(px - trail.x[i]!, py - trail.y[i]!),
    };
  }
  const ax = trail.x[seg]!;
  const ay = trail.y[seg]!;
  const dx = trail.x[seg + 1]! - ax;
  const dy = trail.y[seg + 1]! - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + dx * t;
  const qy = ay + dy * t;
  return {
    seg,
    t,
    alongM: trail.along[seg]! + trail.edgeLen[seg]! * t,
    distM: Math.hypot(px - qx, py - qy),
  };
}

/**
 * The nearest point of the trail to `p` (exact), searching outward through the
 * grid. `prefer`: when two candidates are within `tieM` metres of each other
 * in distance, the one whose distance along is closer to `prefer.alongM` wins
 * (where the trail doubles back on itself, an out-and-back or a switchback,
 * the leg you were on stays yours). `cost` accumulates the work done.
 */
export function nearestOnTrail(
  trail: PreparedTrail,
  p: LatLng,
  options: { prefer?: number; tieM?: number; cost?: QueryCost } = {},
): TrailProjection {
  const { prefer, tieM = 5, cost } = options;
  const { x: px, y: py } = toLocal(trail, p);
  const g = trail.grid;
  // Start with a square that already reaches the grid when the point is far
  // outside it, so a far query doesn't spend rounds on empty squares.
  const outX = Math.max(0, g.minX - px, px - (g.minX + g.cols * g.cellM));
  const outY = Math.max(0, g.minY - py, py - (g.minY + g.rows * g.cellM));
  let half = Math.max(2 * g.cellM, Math.hypot(outX, outY) + 2 * g.cellM);
  const seen = new Set<number>();
  let best: TrailProjection | null = null;
  const consider = (cand: TrailProjection) => {
    if (best === null) {
      best = cand;
      return;
    }
    const b: TrailProjection = best;
    if (prefer !== undefined && Math.abs(cand.distM - b.distM) <= tieM) {
      if (Math.abs(cand.alongM - prefer) < Math.abs(b.alongM - prefer)) best = cand;
      else if (
        Math.abs(cand.alongM - prefer) === Math.abs(b.alongM - prefer) &&
        cand.distM < b.distM
      )
        best = cand;
    } else if (cand.distM < b.distM) best = cand;
  };
  for (;;) {
    const c0 = Math.floor((px - half - g.minX) / g.cellM);
    const c1 = Math.floor((px + half - g.minX) / g.cellM);
    const r0 = Math.floor((py - half - g.minY) / g.cellM);
    const r1 = Math.floor((py + half - g.minY) / g.cellM);
    const cc0 = Math.max(0, c0);
    const cc1 = Math.min(g.cols - 1, c1);
    const rr0 = Math.max(0, r0);
    const rr1 = Math.min(g.rows - 1, r1);
    for (let r = rr0; r <= rr1; r++) {
      for (let c = cc0; c <= cc1; c++) {
        if (cost) cost.cells++;
        const list = g.cells.get(r * g.cols + c);
        if (!list) continue;
        for (const seg of list) {
          if (seen.has(seg)) continue;
          seen.add(seg);
          if (cost) cost.segments++;
          consider(projectOnSegment(trail, seg, px, py));
        }
      }
    }
    const coversAll = c0 <= 0 && r0 <= 0 && c1 >= g.cols - 1 && r1 >= g.rows - 1;
    const found = best as TrailProjection | null;
    // Accept once the best is inside the square by a full cell: every segment
    // nearer than that has a registered sample inside the square (samples are
    // half a cell apart), so it has been seen. A tie candidate up to `tieM`
    // farther must be inside too.
    if (found !== null && found.distM + (prefer !== undefined ? tieM : 0) <= half - g.cellM) {
      return found;
    }
    if (coversAll && found !== null) return found;
    half *= 2;
  }
}

/** The point at `alongM` metres along the trail (clamped to its ends). O(log n). */
export function pointAtAlong(trail: PreparedTrail, alongM: number): LatLng {
  const { along, n } = trail;
  if (n === 1 || alongM <= 0) return vertex(trail, 0);
  if (alongM >= trail.lengthM) return vertex(trail, n - 1);
  // Largest i with along[i] <= alongM.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (along[mid]! <= alongM) lo = mid;
    else hi = mid - 1;
  }
  // Across a pause gap the edge has zero length: skip to its far end.
  let i = lo;
  while (i + 1 < n && trail.edgeLen[i] === 0) i++;
  if (i + 1 >= n) return vertex(trail, n - 1);
  const t = (alongM - along[i]!) / trail.edgeLen[i]!;
  const tc = Math.min(1, Math.max(0, t));
  return {
    latitude: trail.lat[i]! + (trail.lat[i + 1]! - trail.lat[i]!) * tc,
    longitude: trail.lon[i]! + (trail.lon[i + 1]! - trail.lon[i]!) * tc,
  };
}

/** The coordinate of a projection's point on the trail. */
export function projectionPoint(trail: PreparedTrail, proj: TrailProjection): LatLng {
  const i = proj.seg;
  if (trail.n === 1) return vertex(trail, 0);
  const j = Math.min(i + 1, trail.n - 1);
  return {
    latitude: trail.lat[i]! + (trail.lat[j]! - trail.lat[i]!) * proj.t,
    longitude: trail.lon[i]! + (trail.lon[j]! - trail.lon[i]!) * proj.t,
  };
}

function vertex(trail: PreparedTrail, i: number): LatLng {
  return { latitude: trail.lat[i]!, longitude: trail.lon[i]! };
}
