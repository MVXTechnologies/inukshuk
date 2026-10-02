import type { TrackPoint, TrackStats } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';

/**
 * Moving time (#504): the part of a trail's time actually spent moving, like
 * Strava's "Moving Time". Pure, platform-free.
 *
 * Why not "every fix-to-fix step faster than X"? A phone standing still
 * wanders: 1 Hz fixes jump 2–5 m in random directions, i.e. 2–5 m/s of
 * apparent speed per step, so a naive per-step threshold books a café stop
 * as walking. Instead:
 *
 * 1. **Smoothed speed.** For each fix-to-fix interval we average the fixes in
 *    the {@link MovingTimeOpts.windowS window} before and after its midpoint
 *    into two centroids and take centroid-to-centroid speed. Averaging N
 *    fixes shrinks random jitter by ~√N, while real motion survives intact.
 *    With sparse fixes (one per 30 s) each half holds one fix and this is
 *    simply the step's own speed.
 * 2. **Activity threshold.** An interval is slow when that speed is below
 *    the trail's {@link MovingProfile.stopSpeedMps} — a bike crawling at
 *    1 m/s is stopped, a hiker on a steep climb at 0.6 m/s is not.
 * 3. **Sustained stops only.** A run of slow intervals is a stop — and
 *    excluded — only once it lasts {@link MovingTimeOpts.minStopS}; a
 *    two-second hesitation at a junction is still moving.
 * 4. **Gaps.** A step with no fix for longer than the gap limit (60 s, or
 *    4× the trail's typical sampling interval when it records sparsely) is
 *    never moving: that's an auto-pause, a tunnel or a phone in a pocket,
 *    and nothing says it was spent moving. Callers measure each `<trkseg>`
 *    on its own, so time between segments never counts either.
 *
 * Moving distance is the summed step distance over moving intervals, so the
 * jitter wander during a stop doesn't inflate the moving pace/speed.
 */

/** Threshold family for an activity. */
export type MovingProfileId = 'foot' | 'run' | 'trail-run' | 'bike' | 'ski' | 'paddle';

export interface MovingProfile {
  id: MovingProfileId;
  /** Smoothed speed below which the trail is considered stopped, in m/s. */
  stopSpeedMps: number;
  /** How an average is shown for this activity: min/km (foot) or km/h. */
  display: 'pace' | 'speed';
}

const PROFILES: Record<MovingProfileId, MovingProfile> = {
  // 0.5 m/s = 1.8 km/h: well under a slow uphill hike, above GPS drift.
  foot: { id: 'foot', stopSpeedMps: 0.5, display: 'pace' },
  run: { id: 'run', stopSpeedMps: 1.0, display: 'pace' },
  // Trail runners power-hike the steep climbs — those still count.
  'trail-run': { id: 'trail-run', stopSpeedMps: 0.7, display: 'pace' },
  bike: { id: 'bike', stopSpeedMps: 1.5, display: 'speed' },
  // Covers skinning/XC climbs (~0.6–1 m/s); waiting in a lift line is a stop.
  ski: { id: 'ski', stopSpeedMps: 0.8, display: 'speed' },
  // Drifting on a current while resting is not paddling.
  paddle: { id: 'paddle', stopSpeedMps: 0.8, display: 'speed' },
};

/** Built-in category ids (see `@core/library/categories`) → threshold family. */
const CATEGORY_PROFILE: Record<string, MovingProfileId> = {
  hike: 'foot',
  walk: 'foot',
  snowshoe: 'foot',
  navigation: 'foot',
  other: 'foot',
  run: 'run',
  'trail-run': 'trail-run',
  bike: 'bike',
  ski: 'ski',
  // Not built-ins today; recognised so a future paddling category just works.
  paddle: 'paddle',
  kayak: 'paddle',
  canoe: 'paddle',
};

/** The moving profile for a trail's category; uncategorized/custom → on foot. */
export function movingProfileFor(category?: string | null): MovingProfile {
  const id = (category ? CATEGORY_PROFILE[category] : undefined) ?? 'foot';
  return PROFILES[id];
}

/**
 * Bump when the algorithm changes: stored stats carrying an older key are
 * recomputed lazily the next time their points are loaded.
 */
export const MOVING_MODEL_VERSION = 1;

/** The `TrackStats.movingModel` stamp for stats computed now for `category`. */
export function movingModelKey(category?: string | null): string {
  return `v${MOVING_MODEL_VERSION}:${movingProfileFor(category).id}`;
}

/**
 * True when `stats`' moving time/speed were computed by the current algorithm
 * for `category`'s profile — false for trails saved before #504 and for ones
 * whose category changed since (a walk re-filed as a bike ride).
 */
export function hasCurrentMovingStats(
  stats: Pick<TrackStats, 'movingModel'>,
  category?: string | null,
): boolean {
  return stats.movingModel === movingModelKey(category);
}

export interface MovingTimeOpts {
  /** Stop threshold in m/s (default: the on-foot profile's). */
  stopSpeedMps?: number;
  /** Total smoothing window around each interval, in seconds. */
  windowS?: number;
  /** A slow stretch must last this long to be excluded as a stop, in seconds. */
  minStopS?: number;
  /** Minimum gap limit in seconds; a step with no fix for longer never counts. */
  maxGapS?: number;
}

export interface MovingTimeResult {
  movingTimeS: number;
  movingDistanceM: number;
}

export const DEFAULT_WINDOW_S = 30;
export const DEFAULT_MIN_STOP_S = 15;
export const DEFAULT_MAX_GAP_S = 60;
/** Sparse recorders: the gap limit grows to this many typical intervals. */
const GAP_INTERVALS = 4;

const isTimed = (p: TrackPoint): boolean => p.hasTime !== false && Number.isFinite(p.time);

/** Median of positive step durations (seconds), 0 when there are none. */
function medianStepS(points: readonly TrackPoint[]): number {
  const dts: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (!isTimed(a) || !isTimed(b)) continue;
    const dt = (b.time - a.time) / 1000;
    if (dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return 0;
  dts.sort((x, y) => x - y);
  return dts[Math.floor(dts.length / 2)] ?? 0;
}

/** {@link classifyMovingSteps}: the step from fix k-1 to fix k is not measurable (untimed, backwards). */
export const STEP_INVALID = 0;
/** The step counts as moving time. */
export const STEP_MOVING = 1;
/** The step is part of a sustained stop (slow for at least `minStopS`). */
export const STEP_STOPPED = 2;
/** No fix for longer than the gap limit: never moving time. */
export const STEP_GAP = 3;
/** A `<trkseg>` / recording-pause boundary (only from {@link classifySegmentedSteps}). */
export const STEP_BREAK = 4;

/**
 * Per-step verdict for ONE continuous segment: `out[k]` describes the step
 * from fix `k-1` to fix `k` (`out[0]` is unused, {@link STEP_INVALID}). This
 * is the classifier {@link computeMovingTime} sums, exposed so splits and
 * stop detection (the trail view's Timeline, #511) agree with the moving
 * time to the second.
 */
export function classifyMovingSteps(
  points: readonly TrackPoint[],
  opts?: MovingTimeOpts,
): Uint8Array {
  const out = new Uint8Array(points.length);
  const stopSpeedMps = opts?.stopSpeedMps ?? PROFILES.foot.stopSpeedMps;
  const halfWindowMs = ((opts?.windowS ?? DEFAULT_WINDOW_S) * 1000) / 2;
  const minStopS = opts?.minStopS ?? DEFAULT_MIN_STOP_S;
  const maxGapS = Math.max(opts?.maxGapS ?? DEFAULT_MAX_GAP_S, GAP_INTERVALS * medianStepS(points));

  // Walk "runs": maximal stretches of timed fixes whose steps are all
  // forward in time and no longer than the gap limit. Duplicate timestamps
  // (dt = 0) stay inside a run; they add no time.
  let i = 0;
  while (i < points.length) {
    if (!isTimed(points[i]!)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < points.length) {
      const a = points[j]!;
      const b = points[j + 1]!;
      if (!isTimed(b)) break;
      const dt = (b.time - a.time) / 1000;
      if (dt < 0) break;
      if (dt > maxGapS) {
        out[j + 1] = STEP_GAP;
        break;
      }
      j += 1;
    }
    if (j > i) classifyRun(points, i, j, stopSpeedMps, halfWindowMs, minStopS, out);
    i = j + 1;
  }
  return out;
}

/**
 * {@link classifyMovingSteps} over a whole multi-segment trail: each segment
 * is classified on its own and the step INTO each segment start is
 * {@link STEP_BREAK}, so nothing bridges a pause.
 */
export function classifySegmentedSteps(
  points: readonly TrackPoint[],
  segmentStarts: readonly number[],
  opts?: MovingTimeOpts,
): Uint8Array {
  const out = new Uint8Array(points.length);
  const bounds = [
    0,
    ...Array.from(
      new Set(segmentStarts.filter((s) => Number.isInteger(s) && s > 0 && s < points.length)),
    ).sort((a, b) => a - b),
    points.length,
  ];
  for (let b = 0; b + 1 < bounds.length; b++) {
    const from = bounds[b]!;
    const to = bounds[b + 1]!;
    const steps = classifyMovingSteps(points.slice(from, to), opts);
    out.set(steps, from);
    if (from > 0) out[from] = STEP_BREAK;
  }
  return out;
}

/**
 * Moving time and moving distance of ONE continuous segment (callers split
 * `<trkseg>`s / recording pauses first — see `computeSegmentedTrackStats`).
 */
export function computeMovingTime(
  points: readonly TrackPoint[],
  opts?: MovingTimeOpts,
): MovingTimeResult {
  const steps = classifyMovingSteps(points, opts);
  let movingTimeS = 0;
  let movingDistanceM = 0;
  for (let k = 1; k < points.length; k++) {
    if (steps[k] !== STEP_MOVING) continue;
    const a = points[k - 1]!;
    const b = points[k]!;
    movingTimeS += (b.time - a.time) / 1000;
    movingDistanceM += haversineMeters(a, b);
  }
  return { movingTimeS, movingDistanceM };
}

/** Classify the steps of `points[from..to]`, a gap-free run of timed fixes, into `out`. */
function classifyRun(
  points: readonly TrackPoint[],
  from: number,
  to: number,
  stopSpeedMps: number,
  halfWindowMs: number,
  minStopS: number,
  out: Uint8Array,
): void {
  const n = to - from + 1;
  // Prefix sums (relative to the run's first fix, longitude unwrapped across
  // the antimeridian) so each window centroid is O(1).
  const first = points[from]!;
  const sumLat = new Float64Array(n + 1);
  const sumLng = new Float64Array(n + 1);
  const sumT = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    const p = points[from + k]!;
    let dLng = p.longitude - first.longitude;
    if (dLng > 180) dLng -= 360;
    else if (dLng < -180) dLng += 360;
    sumLat[k + 1] = sumLat[k]! + (p.latitude - first.latitude);
    sumLng[k + 1] = sumLng[k]! + dLng;
    sumT[k + 1] = sumT[k]! + (p.time - first.time);
  }
  const centroid = (lo: number, hi: number) => {
    // Inclusive local indices lo..hi.
    const c = hi - lo + 1;
    return {
      latitude: first.latitude + (sumLat[hi + 1]! - sumLat[lo]!) / c,
      longitude: first.longitude + (sumLng[hi + 1]! - sumLng[lo]!) / c,
      t: (sumT[hi + 1]! - sumT[lo]!) / c,
    };
  };

  // Classify each step k (fix k-1 → k, local indices) as slow or not.
  const slow = new Uint8Array(n); // slow[k] for k in 1..n-1
  let lo = 0;
  let hi = 0;
  const tAt = (local: number) => points[from + local]!.time - first.time;
  for (let k = 1; k < n; k++) {
    const mid = (tAt(k - 1) + tAt(k)) / 2;
    // Back half: fixes lo..k-1 within half a window before the midpoint;
    // front half: k..hi within half a window after it. Both pointers only
    // ever advance, so the whole pass is O(n).
    while (lo < k - 1 && tAt(lo) < mid - halfWindowMs) lo += 1;
    if (hi < k) hi = k;
    while (hi + 1 < n && tAt(hi + 1) <= mid + halfWindowMs) hi += 1;
    const back = centroid(lo, k - 1);
    const front = centroid(k, hi);
    const dtS = (front.t - back.t) / 1000;
    const speed = dtS > 0 ? haversineMeters(back, front) / dtS : 0;
    slow[k] = speed < stopSpeedMps ? 1 : 0;
  }

  // Slow stretches lasting at least minStopS are stops; everything else moves.
  let k = 1;
  while (k < n) {
    let end = k;
    while (end + 1 < n && slow[end + 1] === slow[k]) end += 1;
    let spanS = 0;
    for (let m = k; m <= end; m++) {
      spanS += (points[from + m]!.time - points[from + m - 1]!.time) / 1000;
    }
    const verdict = slow[k] === 1 && spanS >= minStopS ? STEP_STOPPED : STEP_MOVING;
    for (let m = k; m <= end; m++) out[from + m] = verdict;
    k = end + 1;
  }
}

/** What the trail summary shows for time and average pace/speed. */
export interface TrailTiming {
  /** Recorded time (pauses between segments excluded), seconds. */
  elapsedS: number;
  movingTimeS: number;
  /** Pace (min/km, min/mi) for foot activities, speed for bike/ski/paddle. */
  display: 'pace' | 'speed';
  /** Distance ÷ elapsed time, m/s (0 when untimed). */
  elapsedSpeedMps: number;
  /** Distance ÷ moving time, m/s (0 when nothing moved). */
  movingSpeedMps: number;
}

/**
 * The time rows of a trail summary, or null for an untimed trail (a planned
 * route has no time to show). Older stats without a moving average fall back
 * to distance ÷ moving time.
 */
export function trailTiming(
  stats: Pick<TrackStats, 'distanceM' | 'durationS' | 'movingTimeS' | 'avgSpeedMps'>,
  category?: string | null,
): TrailTiming | null {
  const elapsedS = Number.isFinite(stats.durationS) ? Math.max(0, stats.durationS) : 0;
  const movingTimeS = Number.isFinite(stats.movingTimeS) ? Math.max(0, stats.movingTimeS) : 0;
  if (elapsedS <= 0 && movingTimeS <= 0) return null;
  const distanceM = Number.isFinite(stats.distanceM) ? Math.max(0, stats.distanceM) : 0;
  const movingSpeedMps =
    Number.isFinite(stats.avgSpeedMps) && stats.avgSpeedMps > 0
      ? stats.avgSpeedMps
      : movingTimeS > 0
        ? distanceM / movingTimeS
        : 0;
  return {
    elapsedS,
    movingTimeS,
    display: movingProfileFor(category).display,
    elapsedSpeedMps: elapsedS > 0 ? distanceM / elapsedS : 0,
    movingSpeedMps,
  };
}
