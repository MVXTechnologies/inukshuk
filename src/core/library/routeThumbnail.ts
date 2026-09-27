/**
 * Route thumbnails for Library trail rows (revamp §5): the trail's shape,
 * fitted into a small square and simplified to a handful of points so a list
 * of long recordings stays cheap to draw.
 *
 * Pure geometry only: the SVG is drawn by `RouteThumbnail.tsx`, and loading /
 * caching the GPX lives in `useRouteThumbnail.ts`.
 */

/** A point in thumbnail pixels (y grows downward). */
export interface ThumbPoint {
  x: number;
  y: number;
}

export interface RouteThumbnail {
  /** SVG path data (`M x y L x y …`), in thumbnail pixels. */
  path: string;
  /** Where the trail starts (drawn as a dot). */
  start: ThumbPoint;
  /** Points kept after simplification (≥ 1). */
  pointCount: number;
}

export interface RouteThumbnailOptions {
  /** Side of the square thumbnail, px. */
  size: number;
  /** Inset kept clear on every side, px (room for the stroke and the start dot). */
  padding: number;
  /** Upper bound on the simplified point count. */
  maxPoints: number;
}

export const DEFAULT_THUMBNAIL_OPTIONS: RouteThumbnailOptions = {
  size: 56,
  padding: 8,
  maxPoints: 64,
};

/** Hard cap on points fed to the simplifier; longer tracks are decimated first. */
const PRE_DECIMATE_LIMIT = 4000;

/** Keep every `stride`-th point of `points`, always keeping the last one. */
export function decimate<T>(points: readonly T[], limit: number): T[] {
  if (points.length <= limit) return [...points];
  if (limit < 2) return points.slice(0, Math.max(0, limit));
  const stride = (points.length - 1) / (limit - 1);
  const out: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    const p = points[Math.round(i * stride)];
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** Squared distance from `p` to the segment `a`–`b`. */
function segmentDistanceSq(p: ThumbPoint, a: ThumbPoint, b: ThumbPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const ex = a.x + t * dx - p.x;
  const ey = a.y + t * dy - p.y;
  return ex * ex + ey * ey;
}

/**
 * Ramer–Douglas–Peucker simplification (iterative, so a 4 000-point track
 * cannot blow the stack). Keeps both endpoints.
 */
export function simplifyPolyline(points: readonly ThumbPoint[], tolerance: number): ThumbPoint[] {
  const n = points.length;
  if (n <= 2) return [...points];
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const toleranceSq = tolerance * tolerance;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (range === undefined) break;
    const [first, last] = range;
    const a = points[first];
    const b = points[last];
    if (a === undefined || b === undefined) continue;
    let maxSq = -1;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const p = points[i];
      if (p === undefined) continue;
      const d = segmentDistanceSq(p, a, b);
      if (d > maxSq) {
        maxSq = d;
        index = i;
      }
    }
    if (index !== -1 && maxSq > toleranceSq) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * Project lat/lon into thumbnail pixels: equirectangular around the track's
 * mid-latitude (plenty for a trail-sized area), scaled uniformly so the
 * longer side fills the box and the shorter one is centred.
 */
export function fitToSquare(
  coords: readonly { latitude: number; longitude: number }[],
  size: number,
  padding: number,
): ThumbPoint[] {
  if (coords.length === 0) return [];
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const c of coords) {
    minLat = Math.min(minLat, c.latitude);
    maxLat = Math.max(maxLat, c.latitude);
  }
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const planar = coords.map((c) => ({ x: c.longitude * k, y: -c.latitude }));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of planar) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const inner = Math.max(0, size - 2 * padding);
  const span = Math.max(maxX - minX, maxY - minY);
  const scale = span > 0 ? inner / span : 0;
  const offsetX = padding + (inner - (maxX - minX) * scale) / 2;
  const offsetY = padding + (inner - (maxY - minY) * scale) / 2;
  return planar.map((p) => ({
    x: offsetX + (p.x - minX) * scale,
    y: offsetY + (p.y - minY) * scale,
  }));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** SVG path data for a polyline, rounded to 0.1 px. */
export function toSvgPath(points: readonly ThumbPoint[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round1(p.x)} ${round1(p.y)}`).join(' ');
}

/**
 * The whole pipeline: drop unusable fixes, decimate, fit, simplify to at most
 * `maxPoints`, and emit the path. Null when there is nothing to draw.
 */
export function buildRouteThumbnail(
  coords: readonly { latitude: number; longitude: number }[],
  options: RouteThumbnailOptions = DEFAULT_THUMBNAIL_OPTIONS,
): RouteThumbnail | null {
  const valid = coords.filter(
    (c) =>
      Number.isFinite(c.latitude) &&
      Number.isFinite(c.longitude) &&
      Math.abs(c.latitude) <= 90 &&
      Math.abs(c.longitude) <= 180,
  );
  if (valid.length === 0) return null;
  const fitted = fitToSquare(decimate(valid, PRE_DECIMATE_LIMIT), options.size, options.padding);
  const maxPoints = Math.max(2, options.maxPoints);
  let tolerance = 0.35;
  let simplified = simplifyPolyline(fitted, tolerance);
  // Coarsen until the budget holds (a few rounds at most: tolerance doubles).
  for (let round = 0; simplified.length > maxPoints && round < 12; round += 1) {
    tolerance *= 2;
    simplified = simplifyPolyline(fitted, tolerance);
  }
  if (simplified.length > maxPoints) simplified = decimate(simplified, maxPoints);
  const start = simplified[0];
  if (start === undefined) return null;
  // A single fix still gets a (zero-length) path so the start dot has a line.
  const path = toSvgPath(simplified.length === 1 ? [start, start] : simplified);
  return { path, start, pointCount: simplified.length };
}
