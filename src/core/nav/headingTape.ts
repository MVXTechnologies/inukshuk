import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import type { LatLng } from '@core/models';
import { normalizeDeg, signedDeltaDeg } from '@core/signal/heading';

/**
 * The linear navigation compass (#672): a heading tape whose scale scrolls
 * under a fixed centre index. Pure geometry for the component: which ticks
 * and labels are visible, where a bearing sits on the tape (or which edge it
 * is pinned to), the turn hint, and which heading drives the tape when the
 * phone has no magnetometer.
 */

/** Degrees visible either side of the centre index. */
export const TAPE_HALF_SPAN_DEG = 60;

const CARDINALS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

// ---------------------------------------------------------------------------
// The scrolling strip (display-rate tape, features/map/nav/NavCompass).
//
// The tape scrolls under its centre index at display rate without a React
// render per frame: the scale is drawn ONCE as a strip in absolute degrees,
// from −margin to 360 + margin, and only the strip's x offset changes per
// frame. The margins repeat the scale either side of north, so wrapping the
// offset at 0/360 is invisible: at 359.9° and at 0.1° the strip shows the
// same picture, shifted by exactly one turn.
// ---------------------------------------------------------------------------

/**
 * Degrees of scale drawn beyond 0 and 360: the visible half span plus room
 * for the heading to move between two React renders of what rides on the
 * strip (labels, flag) — 15° covers 150°/s at 10 Hz.
 */
export const TAPE_STRIP_MARGIN_DEG = TAPE_HALF_SPAN_DEG + 15;

/** One tick of the strip, at an absolute strip position. */
export interface StripTick {
  /** Position on the strip, degrees in [−margin, 360 + margin]. */
  at: number;
  /** Its bearing, [0, 360). */
  deg: number;
  major: boolean;
  medium: boolean;
  label: string | null;
}

/** Every tick of the strip, left to right. */
export function tapeStripTicks(marginDeg = TAPE_STRIP_MARGIN_DEG, stepDeg = 5): StripTick[] {
  const ticks: StripTick[] = [];
  const start = Math.ceil(-marginDeg / stepDeg) * stepDeg;
  for (let at = start; at <= 360 + marginDeg + 1e-9; at += stepDeg) {
    const deg = normalizeDeg(Math.round(at));
    const major = deg % 30 === 0;
    ticks.push({
      at,
      deg,
      major,
      medium: !major && deg % 10 === 0,
      label: major ? (CARDINALS[deg] ?? String(deg)) : null,
    });
  }
  return ticks;
}

/**
 * Where a bearing is drawn on the strip: every copy within it (a bearing near
 * north sits both near 0 and near 360), the copy nearest `headingDeg` first.
 */
export function tapeStripPositions(
  headingDeg: number,
  bearingDeg: number,
  marginDeg = TAPE_STRIP_MARGIN_DEG,
): number[] {
  const nearest = normalizeDeg(headingDeg) + signedDeltaDeg(headingDeg, bearingDeg);
  const out = [nearest];
  for (const other of [nearest - 360, nearest + 360]) {
    if (other >= -marginDeg - 1e-9 && other <= 360 + marginDeg + 1e-9) out.push(other);
  }
  return out;
}

/** The strip's x (px) of strip position `at` (degrees). */
export function tapeStripX(
  at: number,
  pxPerDeg: number,
  marginDeg = TAPE_STRIP_MARGIN_DEG,
): number {
  return (at + marginDeg) * pxPerDeg;
}

/**
 * The strip's translation (px) that puts `headingDeg` (any range: the
 * display heading is continuous) under the centre index at `centerPx`.
 */
export function tapeStripTranslatePx(
  headingDeg: number,
  centerPx: number,
  pxPerDeg: number,
  marginDeg = TAPE_STRIP_MARGIN_DEG,
): number {
  return centerPx - tapeStripX(normalizeDeg(headingDeg), pxPerDeg, marginDeg);
}

/** Where a bearing sits on the tape. */
export type TapeMarker =
  | { kind: 'on'; offset: number; deltaDeg: number }
  | { kind: 'edge'; side: 'left' | 'right'; deltaDeg: number };

/**
 * Place `bearingDeg` on a tape centred on `headingDeg`: inside ±half span it
 * is a marker at `offset` (fraction of the half span, right positive);
 * beyond, it is pinned to the edge on the side to turn towards.
 */
export function tapeMarker(
  headingDeg: number,
  bearingDeg: number,
  halfSpanDeg = TAPE_HALF_SPAN_DEG,
): TapeMarker {
  const deltaDeg = signedDeltaDeg(headingDeg, bearingDeg);
  if (Math.abs(deltaDeg) <= halfSpanDeg) {
    return { kind: 'on', offset: deltaDeg / halfSpanDeg, deltaDeg };
  }
  return { kind: 'edge', side: deltaDeg > 0 ? 'right' : 'left', deltaDeg };
}

/** A horizontal span of the tape something is drawn over, px: [from, to]. */
export type TapeSpan = readonly [number, number];

/** Half the width a tick label takes, px (bold ~10.5 pt digits, 13 pt cardinals). */
export function tapeLabelHalfWidth(label: string): number {
  return label.length === 1 ? 6 : label.length * 3.6 + 1;
}

/**
 * Whether a tick label centred at `x` stays clear of everything drawn over
 * the tape (the target flag, the edge arrow, the trail bar, "COG"). A label
 * that would sit under one is not drawn: a half-hidden "60" reads as a wrong
 * number (2.5.1 QA). `gapPx` keeps a little air between them.
 */
export function tapeLabelClear(
  x: number,
  label: string,
  blocked: readonly TapeSpan[],
  gapPx = 2,
): boolean {
  const half = tapeLabelHalfWidth(label) + gapPx;
  return blocked.every(([from, to]) => x + half <= from || x - half >= to);
}

/** "Right 62°" / "Left 12°" — whole degrees, the way to turn. */
export function turnHint(deltaDeg: number): string {
  const whole = Math.round(Math.abs(deltaDeg));
  return deltaDeg >= 0 ? `Right ${whole}°` : `Left ${whole}°`;
}

/** Below this ground speed, the course over ground is noise (#672). */
export const COG_MIN_SPEED_MPS = 0.5;
/** A course is only taken between fixes at least this far apart, metres (GPS jitter is 1–3 m). */
export const COG_MIN_STEP_M = 4;
/** An anchor older than this restarts the estimate, ms. */
const COG_MAX_AGE_MS = 15_000;

export interface CourseSample {
  /** Ground speed, m/s. */
  speedMps: number;
  /** Course over ground, degrees, or null before the first real step. */
  courseDeg: number | null;
}

export interface CourseTracker {
  /** Feed a fix and its time (ms); returns the current course estimate. */
  push(fix: LatLng, timeMs: number): CourseSample;
}

/**
 * Course over ground from successive fixes, for phones without a
 * magnetometer. The speed is measured from an anchor fix; the course is
 * taken only once the fixes are {@link COG_MIN_STEP_M} apart (then the anchor
 * moves up), so standing still with GPS jitter decays the speed instead of
 * spinning the course. O(1) per fix.
 */
export function createCourseTracker(): CourseTracker {
  let anchor: { at: LatLng; t: number } | null = null;
  let courseDeg: number | null = null;
  return {
    push(fix, timeMs) {
      if (anchor === null || timeMs - anchor.t > COG_MAX_AGE_MS || timeMs < anchor.t) {
        anchor = { at: fix, t: timeMs };
        courseDeg = null;
        return { speedMps: 0, courseDeg: null };
      }
      const d = haversineMeters(anchor.at, fix);
      const dt = (timeMs - anchor.t) / 1000;
      const speedMps = dt > 0 ? d / dt : 0;
      if (d >= COG_MIN_STEP_M) {
        courseDeg = initialBearingDeg(anchor.at, fix);
        anchor = { at: fix, t: timeMs };
      }
      return { speedMps, courseDeg };
    },
  };
}

/** What drives the tape: the compass, the course over ground, or nothing (hidden). */
export type TapeSource =
  { kind: 'compass'; headingDeg: number } | { kind: 'cog'; headingDeg: number };

/**
 * Pick the tape's heading. The compass wins whenever it has reported; with
 * no magnetometer, the course over ground drives the tape above
 * {@link COG_MIN_SPEED_MPS}; otherwise null, and the tape hides — never a
 * frozen scale.
 */
export function chooseTapeSource(
  compassHeadingDeg: number | null,
  course: CourseSample,
): TapeSource | null {
  if (compassHeadingDeg !== null && Number.isFinite(compassHeadingDeg)) {
    return { kind: 'compass', headingDeg: normalizeDeg(compassHeadingDeg) };
  }
  if (course.courseDeg !== null && course.speedMps > COG_MIN_SPEED_MPS) {
    return { kind: 'cog', headingDeg: normalizeDeg(course.courseDeg) };
  }
  return null;
}
