/**
 * Track simplification for rendering large libraries (#465). A 1 Hz recording
 * carries a fix every 1–6 m; drawn on a map, or fed to the heat grid, that is
 * 10–50× more geometry than the eye (or a 25 m heat cell) can use. Every
 * consumer that draws a whole library works from this simplified geometry, so
 * 400 trails cost a few hundred thousand coordinates instead of millions.
 *
 * Pure: points in, `[lng, lat]` parts out. The GPX on disk is never touched —
 * inspection, stats, trimming and export still read the full recording.
 */

/** A trail simplified for drawing: one `[lng, lat]` polyline per `<trkseg>`. */
export interface TrackGeometry {
  /** One part per recording segment (pauses are never bridged). */
  parts: [number, number][][];
}

/** Default tolerance (metres): below GPS noise, far below a heat cell. */
export const TRACK_SIMPLIFY_TOLERANCE_M = 4;

const M_PER_DEG = 111_320;

type LatLng = { latitude: number; longitude: number };

function isValid(p: LatLng | undefined): p is LatLng {
  return (
    p !== undefined &&
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.latitude) <= 90 &&
    Math.abs(p.longitude) <= 180
  );
}

/**
 * Ramer–Douglas–Peucker over a polyline in local metres (equirectangular
 * around its first point — exact enough for any trail-sized extent).
 * Iterative, so a 100 000-point recording cannot blow the stack. Keeps both
 * endpoints; returns the kept indices in order.
 */
export function simplifyIndices(points: readonly LatLng[], toleranceM: number): number[] {
  const n = points.length;
  if (n <= 2) return points.map((_, i) => i);
  const first = points[0];
  if (!first) return [];
  const kx = M_PER_DEG * Math.cos((first.latitude * Math.PI) / 180);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (!p) continue;
    // Short arc across the dateline, like the heat trace.
    const dLng = ((((p.longitude - first.longitude + 180) % 360) + 360) % 360) - 180;
    xs[i] = dLng * kx;
    ys[i] = (p.latitude - first.latitude) * M_PER_DEG;
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tolSq = Math.max(0, toleranceM) ** 2;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const last = stack.pop() as number;
    const start = stack.pop() as number;
    const ax = xs[start] as number;
    const ay = ys[start] as number;
    const dx = (xs[last] as number) - ax;
    const dy = (ys[last] as number) - ay;
    const lenSq = dx * dx + dy * dy;
    let maxSq = -1;
    let index = -1;
    for (let i = start + 1; i < last; i++) {
      const px = (xs[i] as number) - ax;
      const py = (ys[i] as number) - ay;
      let t = lenSq === 0 ? 0 : (px * dx + py * dy) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - t * dx;
      const ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > maxSq) {
        maxSq = d;
        index = i;
      }
    }
    if (index !== -1 && maxSq > tolSq) {
      keep[index] = 1;
      stack.push(start, index, index, last);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) out.push(i);
  return out;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Simplify a recording for drawing: invalid fixes dropped, each segment
 * (see `segmentStarts`) simplified on its own with {@link simplifyIndices},
 * coordinates rounded to 1e-6° (~0.1 m). Segments left with a single fix are
 * kept (a lone fix still marks where the trail was).
 */
export function simplifyTrack(
  points: readonly LatLng[],
  segmentStarts: readonly number[] = [],
  toleranceM: number = TRACK_SIMPLIFY_TOLERANCE_M,
): TrackGeometry {
  const bounds = [0, ...segmentStarts.filter((s) => s > 0 && s < points.length), points.length];
  const parts: [number, number][][] = [];
  for (let b = 0; b + 1 < bounds.length; b++) {
    const from = bounds[b] as number;
    const to = bounds[b + 1] as number;
    if (to <= from) continue;
    const segment: LatLng[] = [];
    for (let i = from; i < to; i++) {
      const p = points[i];
      if (isValid(p)) segment.push(p);
    }
    if (segment.length === 0) continue;
    const part: [number, number][] = [];
    for (const i of simplifyIndices(segment, toleranceM)) {
      const p = segment[i];
      if (p) part.push([round6(p.longitude), round6(p.latitude)]);
    }
    parts.push(part);
  }
  return { parts };
}

/** Total vertex count of a geometry. */
export function geometryVertexCount(geometry: TrackGeometry): number {
  let n = 0;
  for (const part of geometry.parts) n += part.length;
  return n;
}

/**
 * Validate a geometry read back from a cache file: parts of `[lng, lat]`
 * pairs with finite, in-range numbers. Returns null for anything else, so a
 * corrupt or foreign cache entry is recomputed rather than drawn.
 */
export function parseTrackGeometry(value: unknown): TrackGeometry | null {
  if (typeof value !== 'object' || value === null) return null;
  const parts = (value as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const out: [number, number][][] = [];
  for (const part of parts) {
    if (!Array.isArray(part)) return null;
    const coords: [number, number][] = [];
    for (const c of part) {
      if (!Array.isArray(c) || c.length !== 2) return null;
      const [lng, lat] = c as unknown[];
      if (
        typeof lng !== 'number' ||
        typeof lat !== 'number' ||
        !Number.isFinite(lng) ||
        !Number.isFinite(lat) ||
        Math.abs(lng) > 180 ||
        Math.abs(lat) > 90
      ) {
        return null;
      }
      coords.push([lng, lat]);
    }
    out.push(coords);
  }
  return { parts: out };
}

/** The geometry's parts as lat/lng fixes (for the heat trace and thumbnails). */
export function geometryPoints(geometry: TrackGeometry): { latitude: number; longitude: number }[] {
  const out: { latitude: number; longitude: number }[] = [];
  for (const part of geometry.parts) {
    for (const [longitude, latitude] of part) out.push({ latitude, longitude });
  }
  return out;
}
