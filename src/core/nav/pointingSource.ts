import type { PointingLineDirection } from '@core/map/pointingLineSettings';
import { normalizeDeg, signedDeltaDeg } from '@core/signal/heading';
import { COG_MIN_SPEED_MPS, type CourseSample } from './headingTape';

/**
 * Which way the pointing line points (#681), and how often it may move.
 *
 * Direction rules (mockup §7's recommended answer, the compass tape's rule):
 * - Heading: the compass. With no magnetometer (no heading sample), the
 *   course over ground above {@link COG_MIN_SPEED_MPS}, labelled "COG";
 *   below it the line hides — never a frozen line.
 * - Course: the course over ground above that speed, else hidden.
 * - Fixed: the fixed bearing, always.
 */
export interface PointingBearing {
  bearingDeg: number;
  kind: 'compass' | 'cog' | 'fixed';
}

export function choosePointingBearing(
  direction: PointingLineDirection,
  fixedBearingDeg: number,
  compassDeg: number | null,
  course: CourseSample,
): PointingBearing | null {
  if (direction === 'fixed') {
    return Number.isFinite(fixedBearingDeg)
      ? { bearingDeg: normalizeDeg(fixedBearingDeg), kind: 'fixed' }
      : null;
  }
  if (direction === 'heading' && compassDeg !== null && Number.isFinite(compassDeg)) {
    return { bearingDeg: normalizeDeg(compassDeg), kind: 'compass' };
  }
  if (course.courseDeg !== null && course.speedMps > COG_MIN_SPEED_MPS) {
    return { bearingDeg: normalizeDeg(course.courseDeg), kind: 'cog' };
  }
  return null;
}

/** The pointing line's heading rate: 4 Hz at most. */
export const POINTING_HEADING_INTERVAL_MS = 250;
/** …and only for a turn of at least 1°. */
export const POINTING_HEADING_DEADBAND_DEG = 1;

/**
 * The pointing line on the MAP moves at up to 10 Hz, for turns of ≥ 0.75°
 * (#704): the shared heading is smooth now, and at 4 Hz a 500 m line's far
 * end stepped ~30 m at a time on a walking turn. Per accepted tick: one
 * feature collection (O(ticks), capped) and one native source update.
 */
export const POINTING_LINE_HEADING_INTERVAL_MS = 100;
export const POINTING_LINE_HEADING_DEADBAND_DEG = 0.75;

export type HeadingGateResult =
  | { kind: 'emit'; headingDeg: number }
  /** Too soon: hold it, and call `flush` after `inMs`. */
  | { kind: 'wait'; inMs: number }
  /** Within the dead-band of what is shown: nothing to do. */
  | { kind: 'drop' };

export interface HeadingGate {
  push(headingDeg: number, nowMs: number): HeadingGateResult;
  /** The held heading once its time has come, else null. */
  flush(nowMs: number): number | null;
}

/**
 * A throttle with a dead-band for a heading stream that feeds a render:
 * a sample within `deadbandDeg` of the shown heading is dropped (and clears
 * any held one: the heading came back); otherwise it is emitted if
 * `intervalMs` has passed since the last emit, or held as the trailing value
 * to flush when it has. So a steady turn renders at most every `intervalMs`
 * and the last position of a turn is never lost. O(1) per sample.
 */
export function createHeadingGate(
  intervalMs = POINTING_HEADING_INTERVAL_MS,
  deadbandDeg = POINTING_HEADING_DEADBAND_DEG,
): HeadingGate {
  let shown: number | null = null;
  let shownAt = -Infinity;
  let held: number | null = null;
  const emit = (deg: number, now: number): number => {
    shown = deg;
    shownAt = now;
    held = null;
    return deg;
  };
  return {
    push(headingDeg, nowMs) {
      if (shown !== null && Math.abs(signedDeltaDeg(shown, headingDeg)) < deadbandDeg) {
        held = null;
        return { kind: 'drop' };
      }
      const elapsed = nowMs - shownAt;
      if (elapsed >= intervalMs) return { kind: 'emit', headingDeg: emit(headingDeg, nowMs) };
      held = headingDeg;
      return { kind: 'wait', inMs: intervalMs - elapsed };
    },
    flush(nowMs) {
      if (held === null || nowMs - shownAt < intervalMs) return null;
      return emit(held, nowMs);
    },
  };
}
