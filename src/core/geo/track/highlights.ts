import type { TrackPoint } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';
import { STEP_BREAK, STEP_GAP, STEP_STOPPED } from './movingTime';
import type { TrackAxis } from './trackAxis';

/**
 * The landmarks of an outing for the trail view's Timeline and jump chips
 * (#511): where you stopped, the steepest stretch, the high point. Pure; each
 * finder is one O(n) pass over arrays the view already holds.
 */

export interface Stop {
  /** 'stop': stood still inside a segment; 'pause': the recording was paused. */
  kind: 'stop' | 'pause';
  /** First and last point of the stop (for a pause: the points either side of it). */
  startIndex: number;
  endIndex: number;
  durationS: number;
}

export interface StopOpts {
  /** Shortest stop worth listing, seconds (default 3 min). */
  minStopS?: number;
  /**
   * The activity's stop speed (m/s). A fix gap is part of a stop only when
   * the trail barely moved across it — a phone that lost signal in a forest
   * while you kept walking did not stop.
   */
  stopSpeedMps?: number;
}

const DEFAULT_MIN_LISTED_STOP_S = 180;

/**
 * Stops from the moving-time step classification: maximal runs of stopped
 * steps (and slow fix gaps) lasting at least `minStopS`, plus recording
 * pauses at least as long. Ordered along the trail.
 */
export function detectStops(
  points: readonly TrackPoint[],
  steps: Uint8Array,
  opts?: StopOpts,
): Stop[] {
  const minStopS = opts?.minStopS ?? DEFAULT_MIN_LISTED_STOP_S;
  const stopSpeed = opts?.stopSpeedMps ?? 0.5;
  const out: Stop[] = [];
  const dtAt = (k: number): number => (points[k]!.time - points[k - 1]!.time) / 1000;
  const still = (k: number): boolean => {
    const v = steps[k];
    if (v === STEP_STOPPED) return true;
    if (v !== STEP_GAP) return false;
    const dt = dtAt(k);
    return dt > 0 && haversineMeters(points[k - 1]!, points[k]!) / dt < stopSpeed;
  };

  let k = 1;
  while (k < points.length) {
    if (steps[k] === STEP_BREAK) {
      const dt = dtAt(k);
      if (Number.isFinite(dt) && dt >= minStopS) {
        out.push({ kind: 'pause', startIndex: k - 1, endIndex: k, durationS: dt });
      }
      k += 1;
      continue;
    }
    if (!still(k)) {
      k += 1;
      continue;
    }
    let end = k;
    let durationS = dtAt(k);
    while (end + 1 < points.length && still(end + 1)) {
      end += 1;
      durationS += dtAt(end);
    }
    if (durationS >= minStopS) {
      out.push({ kind: 'stop', startIndex: k - 1, endIndex: end, durationS });
    }
    k = end + 1;
  }
  return out;
}

export interface SteepStretch {
  startIndex: number;
  endIndex: number;
  /** Signed average grade over the stretch, % (negative = downhill). */
  gradePct: number;
  /** Length of the stretch along the trail, metres. */
  lengthM: number;
}

export interface SteepOpts {
  /** Shortest stretch measured, metres (default 200): one steep step is noise. */
  minLengthM?: number;
  /** Below this |grade| (%) the trail is flat and nothing is reported. */
  minGradePct?: number;
  /** Pause boundaries: a stretch never spans two segments. */
  segmentStarts?: readonly number[];
}

/**
 * The steepest stretch at least `minLengthM` long (by |grade|, climbs and
 * descents alike), widened while the grade holds within 90 % of its peak so
 * the Timeline can say "+24 % over 400 m" rather than always "over 200 m".
 */
export function findSteepestStretch(
  points: readonly TrackPoint[],
  axis: TrackAxis,
  opts?: SteepOpts,
): SteepStretch | null {
  const minLen = opts?.minLengthM ?? 200;
  const minGrade = opts?.minGradePct ?? 3;
  // Altitude-bearing points only, tagged with their segment.
  const idx: number[] = [];
  const seg: number[] = [];
  const starts = new Set(opts?.segmentStarts ?? []);
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    if (starts.has(i)) s += 1;
    const a = points[i]!.altitude;
    if (a !== undefined && Number.isFinite(a)) {
      idx.push(i);
      seg.push(s);
    }
  }
  if (idx.length < 2) return null;
  const d = (k: number) => axis.cumM[idx[k]!]!;
  const e = (k: number) => points[idx[k]!]!.altitude!;
  const grade = (i: number, j: number) => ((e(j) - e(i)) / (d(j) - d(i))) * 100;

  // Best window starting at each altitude point (end index, grade), O(n)
  // with two pointers since the window end only moves forward.
  const winEnd = new Int32Array(idx.length).fill(-1);
  const winGrade = new Float64Array(idx.length);
  let best = -1;
  let j = 0;
  for (let i = 0; i < idx.length; i++) {
    if (j < i) j = i;
    while (j < idx.length && seg[j] === seg[i] && d(j) - d(i) < minLen) j += 1;
    if (j >= idx.length) break;
    if (seg[j] !== seg[i]) continue; // the rest of this segment is too short
    winEnd[i] = j;
    winGrade[i] = grade(i, j);
    if (best < 0 || Math.abs(winGrade[i]!) > Math.abs(winGrade[best]!)) best = i;
  }
  if (best < 0 || Math.abs(winGrade[best]!) < minGrade) return null;

  // Widen over the neighbouring windows that stay within 90 % of the peak, so
  // a long steep wall reads as one stretch ("+24 % over 400 m").
  const peak = winGrade[best]!;
  const steep = (i: number) =>
    winEnd[i]! >= 0 &&
    seg[i] === seg[best] &&
    winGrade[i]! * Math.sign(peak) >= Math.abs(peak) * 0.9;
  let first = best;
  let last = best;
  while (first > 0 && steep(first - 1)) first -= 1;
  while (last + 1 < idx.length && steep(last + 1)) last += 1;
  const lo = first;
  const hi = winEnd[last]!;

  return {
    startIndex: idx[lo]!,
    endIndex: idx[hi]!,
    gradePct: grade(lo, hi),
    lengthM: d(hi) - d(lo),
  };
}

export interface ElevationExtremes {
  highIndex: number;
  lowIndex: number;
  highM: number;
  lowM: number;
}

/** Highest and lowest points (first occurrence); null without altitude. */
export function findElevationExtremes(points: readonly TrackPoint[]): ElevationExtremes | null {
  let out: ElevationExtremes | null = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!.altitude;
    if (a === undefined || !Number.isFinite(a)) continue;
    if (out === null) out = { highIndex: i, lowIndex: i, highM: a, lowM: a };
    else {
      if (a > out.highM) {
        out.highM = a;
        out.highIndex = i;
      }
      if (a < out.lowM) {
        out.lowM = a;
        out.lowIndex = i;
      }
    }
  }
  return out;
}
