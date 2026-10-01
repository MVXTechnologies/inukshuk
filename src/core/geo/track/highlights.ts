import type { TrackPoint } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';
import { STEP_BREAK, STEP_GAP, STEP_STOPPED } from './movingTime';
import { indexAtDistance, type TrackAxis } from './trackAxis';

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
  /** Shortest stretch measured, metres of ground (default 200): one steep step is noise. */
  minLengthM?: number;
  /** Below this |grade| (%) the trail is flat and nothing is reported. */
  minGradePct?: number;
  /**
   * A stretch steeper than this (%) is treated as noise and ignored — a DEM
   * cliff edge or a GPS altitude jump, not a trail (default 60 %).
   */
  maxGradePct?: number;
  /** Elevation smoothing: moving average over ± this many metres (default 50). */
  smoothHalfWindowM?: number;
  /** Pause boundaries: a stretch never spans two segments. */
  segmentStarts?: readonly number[];
}

export interface SteepestStretches {
  /** The steepest climb (positive grade), or null on a trail that never climbs steeply. */
  climb: SteepStretch | null;
  /** The steepest descent (negative grade), or null. */
  descent: SteepStretch | null;
}

/** A segment's elevation resampled every `step` metres of ground, then smoothed. */
interface Grid {
  /** Axis distance of sample 0. */
  startM: number;
  step: number;
  ele: Float64Array;
}

function smoothedGrid(
  dist: readonly number[],
  alt: readonly number[],
  step: number,
  halfWindowM: number,
): Grid | null {
  const startM = dist[0]!;
  const endM = dist[dist.length - 1]!;
  const n = Math.floor((endM - startM) / step) + 1;
  if (n < 2) return null;
  const raw = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const d = startM + i * step;
    while (k + 1 < dist.length - 1 && dist[k + 1]! < d) k += 1;
    const d0 = dist[k]!;
    const d1 = dist[k + 1] ?? d0;
    const t = d1 > d0 ? Math.min(1, Math.max(0, (d - d0) / (d1 - d0))) : 0;
    raw[i] = alt[k]! + ((alt[k + 1] ?? alt[k]!) - alt[k]!) * t;
  }
  // Centred moving average (prefix sums), shrinking at the ends.
  const h = Math.max(0, Math.round(halfWindowM / step));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i]! + raw[i]!;
  const ele = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - h);
    const hi = Math.min(n - 1, i + h);
    ele[i] = (pre[hi + 1]! - pre[lo]!) / (hi - lo + 1);
  }
  return { startM, step, ele };
}

/**
 * The steepest climb and the steepest descent at least `minLengthM` long.
 *
 * Robust to GPS and DEM noise (#511 review: a test hike reported "−51 % over
 * 362 m" off a DEM cliff edge): elevation is resampled every few metres of
 * ground and smoothed over ±50 m before any grade is measured, windows are at
 * least 200 m of ground, and anything steeper than `maxGradePct` is
 * discarded as noise. The winner is widened over neighbouring windows that
 * hold 90 % of its grade, so a long wall reads as "+24 % over 400 m".
 */
export function findSteepestStretches(
  points: readonly TrackPoint[],
  axis: TrackAxis,
  opts?: SteepOpts,
): SteepestStretches {
  const minLen = opts?.minLengthM ?? 200;
  const minGrade = opts?.minGradePct ?? 3;
  const maxGrade = opts?.maxGradePct ?? 60;
  const halfWindowM = opts?.smoothHalfWindowM ?? 50;
  const step = Math.max(10, axis.totalM / 20_000);
  const win = Math.max(1, Math.ceil(minLen / step));
  const starts = new Set(opts?.segmentStarts ?? []);

  type Best = { grid: Grid; i: number; g: number };
  let climb: Best | null = null;
  let descent: Best | null = null;
  const grids: Grid[] = [];

  // One grid per segment, from its altitude-bearing points.
  let dist: number[] = [];
  let alt: number[] = [];
  const flush = () => {
    if (dist.length >= 2) {
      const g = smoothedGrid(dist, alt, step, halfWindowM);
      if (g) grids.push(g);
    }
    dist = [];
    alt = [];
  };
  for (let i = 0; i < points.length; i++) {
    if (starts.has(i)) flush();
    const a = points[i]!.altitude;
    if (a === undefined || !Number.isFinite(a)) continue;
    const d = axis.cumM[i]!;
    if (dist.length > 0 && d <= dist[dist.length - 1]!) continue; // no ground covered
    dist.push(d);
    alt.push(a);
  }
  flush();

  const gradeAt = (grid: Grid, i: number, j: number) =>
    ((grid.ele[j]! - grid.ele[i]!) / ((j - i) * grid.step)) * 100;
  for (const grid of grids) {
    for (let i = 0; i + win < grid.ele.length; i++) {
      const g = gradeAt(grid, i, i + win);
      if (Math.abs(g) > maxGrade) continue;
      if (g > 0 && (climb === null || g > climb.g)) climb = { grid, i, g };
      if (g < 0 && (descent === null || g < descent.g)) descent = { grid, i, g };
    }
  }

  const widen = (b: Best | null): SteepStretch | null => {
    if (b === null || Math.abs(b.g) < minGrade) return null;
    const { grid } = b;
    const holds = (i: number) => {
      if (i < 0 || i + win >= grid.ele.length) return false;
      const g = gradeAt(grid, i, i + win);
      return Math.abs(g) <= maxGrade && g * Math.sign(b.g) >= Math.abs(b.g) * 0.9;
    };
    let first = b.i;
    let last = b.i;
    while (holds(first - 1)) first -= 1;
    while (holds(last + 1)) last += 1;
    const lo = first;
    const hi = last + win;
    const fromM = grid.startM + lo * grid.step;
    const toM = grid.startM + hi * grid.step;
    return {
      startIndex: indexAtDistance(axis, fromM),
      endIndex: Math.min(points.length - 1, indexAtDistance(axis, toM) + 1),
      gradePct: gradeAt(grid, lo, hi),
      lengthM: toM - fromM,
    };
  };
  return { climb: widen(climb), descent: widen(descent) };
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
