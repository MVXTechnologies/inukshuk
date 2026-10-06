import { haversineMeters } from '@core/geo/geomath';
import type { LngLat, TrackPoint } from '@core/models';

/**
 * A trail prepared once for many photo lookups: cumulative distances, and the
 * timed points in time order. Placing 200 photos (or scanning ~100 clock
 * offsets × 30 photos) is then a binary search each, not a walk of the GPX.
 */
export interface TrackIndex {
  /** Point positions, `[lng, lat]`. */
  lngLats: LngLat[];
  /** Elevation per point, when recorded. */
  elevations: (number | undefined)[];
  /** Cumulative distance per point, metres. */
  cumM: number[];
  totalM: number;
  /** Indices of points with a usable timestamp, in non-decreasing time order. */
  timed: number[];
  /** Each point's time (epoch ms; meaningful only at the `timed` indices). */
  times: number[];
  /** First and last usable time, or undefined for an untimed route. */
  startMs?: number;
  endMs?: number;
}

const hasUsableTime = (p: TrackPoint): boolean =>
  p.hasTime !== false && Number.isFinite(p.time) && p.time > 0;

export function indexTrack(points: readonly TrackPoint[]): TrackIndex {
  const lngLats: LngLat[] = [];
  const elevations: (number | undefined)[] = [];
  const cumM: number[] = [];
  const timed: number[] = [];
  const times: number[] = [];
  let cum = 0;
  let lastTime = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) cum += haversineMeters(points[i - 1]!, p);
    lngLats.push([p.longitude, p.latitude]);
    elevations.push(
      p.altitude !== undefined && Number.isFinite(p.altitude) ? p.altitude : undefined,
    );
    cumM.push(cum);
    times.push(p.time);
    // A fix whose clock went backwards (GPS week rollover, a merged file) is
    // left out of the time index rather than breaking the binary search.
    if (hasUsableTime(p) && p.time >= lastTime) {
      timed.push(i);
      lastTime = p.time;
    }
  }
  const index: TrackIndex = { lngLats, elevations, cumM, totalM: cum, timed, times };
  // A couple of stray timed points don't make a recording.
  if (timed.length >= 2) {
    index.startMs = points[timed[0]!]!.time;
    index.endMs = points[timed[timed.length - 1]!]!.time;
  }
  return index;
}

/** A position on the trail. */
export interface TrailPosition {
  distanceM: number;
  lngLat: LngLat;
  elevationM?: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpOpt(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return lerp(a, b, t);
}

/** The position between point `i` and point `j` at fraction `t`. */
function between(index: TrackIndex, i: number, j: number, t: number): TrailPosition {
  const a = index.lngLats[i]!;
  const b = index.lngLats[j]!;
  const pos: TrailPosition = {
    distanceM: lerp(index.cumM[i]!, index.cumM[j]!, t),
    lngLat: [lerp(a[0], b[0], t), lerp(a[1], b[1], t)],
  };
  const e = lerpOpt(index.elevations[i], index.elevations[j], t);
  if (e !== undefined) pos.elevationM = e;
  return pos;
}

/** The trail position at a distance along it (clamped to the trail). */
export function positionAtDistance(index: TrackIndex, distanceM: number): TrailPosition | null {
  const n = index.cumM.length;
  if (n === 0) return null;
  if (n === 1 || distanceM <= 0) return between(index, 0, 0, 0);
  if (distanceM >= index.totalM) return between(index, n - 1, n - 1, 0);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (index.cumM[mid]! <= distanceM) lo = mid;
    else hi = mid;
  }
  const span = index.cumM[hi]! - index.cumM[lo]!;
  return between(index, lo, hi, span > 0 ? (distanceM - index.cumM[lo]!) / span : 0);
}

export interface TimeLookupOptions {
  /** How far before the first / after the last fix a time still counts (ms). */
  marginMs?: number;
  /**
   * A gap between two fixes longer than this (a pause, a lost signal) is not
   * interpolated across: the photo goes to the nearer side (ms).
   */
  maxGapMs?: number;
}

export const DEFAULT_TIME_MARGIN_MS = 10 * 60_000;
export const DEFAULT_MAX_GAP_MS = 10 * 60_000;

/**
 * Where the recording was at an instant: interpolated between the two fixes
 * around it. Null for an untimed trail or a time outside
 * `[start − margin, end + margin]`; inside the margin it clamps to the end.
 */
export function positionAtTime(
  index: TrackIndex,
  epochMs: number,
  { marginMs = DEFAULT_TIME_MARGIN_MS, maxGapMs = DEFAULT_MAX_GAP_MS }: TimeLookupOptions = {},
): TrailPosition | null {
  const { timed, startMs, endMs } = index;
  if (startMs === undefined || endMs === undefined) return null;
  if (epochMs < startMs - marginMs || epochMs > endMs + marginMs) return null;
  const timeOf = (k: number) => timeAt(index, timed[k]!);
  if (epochMs <= startMs) return between(index, timed[0]!, timed[0]!, 0);
  if (epochMs >= endMs) {
    const last = timed[timed.length - 1]!;
    return between(index, last, last, 0);
  }
  let lo = 0;
  let hi = timed.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timeOf(mid) <= epochMs) lo = mid;
    else hi = mid;
  }
  const t0 = timeOf(lo);
  const t1 = timeOf(hi);
  const i = timed[lo]!;
  const j = timed[hi]!;
  if (t1 - t0 > maxGapMs) {
    // Standing still (or no signal): it was taken where one side of the gap is.
    const nearer = epochMs - t0 <= t1 - epochMs ? i : j;
    return between(index, nearer, nearer, 0);
  }
  return between(index, i, j, t1 > t0 ? (epochMs - t0) / (t1 - t0) : 0);
}

function timeAt(index: TrackIndex, i: number): number {
  return index.times[i]!;
}

/** The time of the fix nearest a distance, for "closest in time" tie-breaks. */
export function timeAtDistance(index: TrackIndex, distanceM: number): number | undefined {
  if (index.startMs === undefined) return undefined;
  const pos = positionAtDistance(index, distanceM);
  if (!pos) return undefined;
  // Nearest timed point by distance (timed points are in distance order too).
  let best: number | undefined;
  let bestD = Infinity;
  for (const i of index.timed) {
    const d = Math.abs(index.cumM[i]! - distanceM);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best === undefined ? undefined : timeAt(index, best);
}

/** One place the trail passes near a point. */
export interface TrailPass extends TrailPosition {
  /** Distance from the query point to the trail there, metres. */
  offTrackM: number;
}

const M_PER_DEG_LAT = (6371008.8 * Math.PI) / 180; // the haversine sphere

/**
 * Every separate place the trail passes within `maxM` of a point — one per
 * pass, so an out-and-back yields two (the way up and the way down) and a
 * loop that touches itself yields as many as it touches. Each pass is the
 * closest point of its run of nearby segments, in trail order.
 *
 * Projection is on a local equirectangular plane (exact enough within a few
 * hundred metres, which is all a photo-to-trail match spans).
 */
export function passesNear(index: TrackIndex, point: LngLat, maxM: number): TrailPass[] {
  const n = index.lngLats.length;
  if (n === 0) return [];
  const kx = M_PER_DEG_LAT * Math.cos((point[1] * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  // The query point is the origin of the local plane.
  const px = 0;
  const py = 0;
  const local = (p: LngLat): [number, number] => [(p[0] - point[0]) * kx, (p[1] - point[1]) * ky];

  if (n === 1) {
    const [x, y] = local(index.lngLats[0]!);
    const d = Math.hypot(x - px, y - py);
    return d <= maxM ? [{ ...between(index, 0, 0, 0), offTrackM: d }] : [];
  }

  const passes: TrailPass[] = [];
  // The closest point of the current run of in-range segments; a run ends at
  // the first segment out of range.
  let run: TrailPass | null = null;
  for (let i = 0; i < n - 1; i++) {
    const [ax, ay] = local(index.lngLats[i]!);
    const [bx, by] = local(index.lngLats[i + 1]!);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + dx * t - px, ay + dy * t - py);
    if (d <= maxM) {
      if (!run || d < run.offTrackM) run = { ...between(index, i, i + 1, t), offTrackM: d };
    } else if (run) {
      passes.push(run);
      run = null;
    }
  }
  if (run) passes.push(run);
  return passes;
}
