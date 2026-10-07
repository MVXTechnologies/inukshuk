import type { TrackPoint } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';
import type { TrackPointAt } from './interpolate';

/**
 * The distance axis of a trail, computed once: cumulative along-track
 * distance at every point. It is the SAME axis the elevation profile, the
 * scrubber and the note anchors use, so a position found here lands exactly
 * under the profile cursor.
 *
 * The axis never bridges a segment boundary (#325): the hop from the last fix
 * before a pause to the first fix after it adds nothing, exactly as the
 * trail's distance stat (`computeSegmentedTrackStats`) and the recorder's
 * waypoint anchors count it. Bridging it ran a 391 m trail's profile to
 * 1.39 km after a relocation pause, and drew elevation across the gap.
 *
 * `interpolateTrackAtDistance` walks the points from the start on every call
 * (O(n)); the trail view asks for positions on every chip tap, timeline tap
 * and readout refresh on 50k-point trails, so this keeps a prefix array and
 * binary-searches it instead (O(log n)).
 */
export interface TrackAxis {
  /** Cumulative distance at each point, in metres (`cumM[0] === 0`). */
  cumM: Float64Array;
  totalM: number;
}

/**
 * Indices of `points` that open a new segment, as a set (junk dropped). A
 * local copy of `normalizeSegmentStarts`: `segments.ts` imports the track
 * index, which imports this module.
 */
export function segmentStartSet(starts: readonly number[], length: number): ReadonlySet<number> {
  return new Set(starts.filter((i) => Number.isInteger(i) && i > 0 && i < length));
}

/**
 * Cumulative distance along `points`, segment gaps excluded — the one
 * primitive every distance-along-trail consumer shares (#325). With no
 * `segmentStarts` it is the plain haversine arc length.
 */
export function buildTrackAxis(
  points: readonly TrackPoint[],
  segmentStarts: readonly number[] = [],
): TrackAxis {
  const starts = segmentStartSet(segmentStarts, points.length);
  const cumM = new Float64Array(points.length);
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    if (!starts.has(i)) d += haversineMeters(points[i - 1]!, points[i]!);
    cumM[i] = d;
  }
  return { cumM, totalM: d };
}

/**
 * Index of the last point at or before `distanceM` (clamped to the trail). At
 * a segment gap's distance that is the first point of the later segment.
 */
export function indexAtDistance(axis: TrackAxis, distanceM: number): number {
  const n = axis.cumM.length;
  if (n === 0) return -1;
  if (!(distanceM > 0)) return 0;
  let lo = 0;
  let hi = n - 1;
  if (axis.cumM[hi]! <= distanceM) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (axis.cumM[mid]! <= distanceM) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const isTimed = (p: TrackPoint): boolean => p.hasTime !== false && Number.isFinite(p.time);

function lerpLng(a: number, b: number, t: number): number {
  let delta = b - a;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  const lng = a + delta * t;
  if (lng > 180) return lng - 360;
  if (lng < -180) return lng + 360;
  return lng;
}

function lerpOpt(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (a === undefined || Number.isNaN(a)) return b;
  if (b === undefined || Number.isNaN(b)) return a;
  return a + (b - a) * t;
}

/** The point itself, as a {@link TrackPointAt} on the axis. */
export function pointAtIndex(
  points: readonly TrackPoint[],
  axis: TrackAxis,
  index: number,
): TrackPointAt | null {
  const p = points[index];
  if (!p) return null;
  return {
    latitude: p.latitude,
    longitude: p.longitude,
    distanceM: axis.cumM[index] ?? 0,
    elevation: p.altitude,
    speed: p.speed,
    time: isTimed(p) ? p.time : undefined,
    heartRateBpm: p.heartRateBpm,
  };
}

/**
 * Position (and altitude/time) at `distanceM` along the axis — the same
 * answer as `interpolateTrackAtDistance`, in O(log n).
 */
export function interpolateOnAxis(
  points: readonly TrackPoint[],
  axis: TrackAxis,
  distanceM: number,
): TrackPointAt | null {
  const i = indexAtDistance(axis, distanceM);
  if (i < 0) return null;
  const a = points[i]!;
  const b = points[i + 1];
  if (!b) return pointAtIndex(points, axis, i);
  const segM = axis.cumM[i + 1]! - axis.cumM[i]!;
  const t = segM > 0 ? Math.min(1, Math.max(0, (distanceM - axis.cumM[i]!) / segM)) : 0;
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    longitude: lerpLng(a.longitude, b.longitude, t),
    distanceM: axis.cumM[i]! + segM * t,
    elevation: lerpOpt(a.altitude, b.altitude, t),
    speed: lerpOpt(a.speed, b.speed, t),
    time: isTimed(a) && isTimed(b) ? a.time + (b.time - a.time) * t : undefined,
    heartRateBpm: lerpOpt(a.heartRateBpm, b.heartRateBpm, t),
  };
}

/**
 * Grade (%) around `distanceM`: elevation change over a window of
 * ±`halfWindowM` (clamped to the trail), so the readout under the cursor
 * doesn't flicker with every GPS altitude wobble. Null without elevation or
 * on a trail too short to measure.
 */
export function gradeAtDistance(
  points: readonly TrackPoint[],
  axis: TrackAxis,
  distanceM: number,
  halfWindowM = 50,
): number | null {
  if (axis.totalM <= 0) return null;
  const from = Math.max(0, distanceM - halfWindowM);
  const to = Math.min(axis.totalM, distanceM + halfWindowM);
  if (to - from < 1) return null;
  const a = interpolateOnAxis(points, axis, from)?.elevation;
  const b = interpolateOnAxis(points, axis, to)?.elevation;
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
    return null;
  }
  return ((b - a) / (to - from)) * 100;
}
