import { haversineMeters } from '@core/geo/geomath';
import type { LngLat } from '@core/models';

import { positionAtTime, type TrackIndex } from './trackIndex';

/**
 * The camera-clock check (#587): photos that carry BOTH a time and a GPS
 * position tell us whether the camera's clock agrees with the recording's.
 *
 * For a candidate offset, each such photo's time (+ offset) gives a position on
 * the recording; the median distance from those positions to the photos' own
 * GPS positions is the residual. A right clock has a residual of a few metres
 * to tens of metres (phone GPS under canopy); a camera left on another time
 * zone, or a DSLR clock that drifted, has a residual of kilometres — until the
 * search finds the offset that collapses it.
 *
 * Convention: the offset is ADDED to the EXIF time to get the true time. A
 * camera showing 09:00 at a true 10:00 is "1 h behind" and needs +1 h.
 */

export interface ClockSample {
  /** The photo's EXIF time, epoch ms, before any correction. */
  takenAt: number;
  lngLat: LngLat;
}

export type ClockStatus =
  /** The clock agrees with the recording (offset 0). */
  | 'ok'
  /** A non-zero offset makes the photos agree with the recording. */
  | 'corrected'
  /** Too few photos with both time and GPS, or no offset fits: leave it to the user. */
  | 'unknown';

export interface ClockEstimate {
  status: ClockStatus;
  /** The correction to add to every EXIF time from this camera (0 unless `corrected`). */
  offsetMs: number;
  /** Median photo-to-recording distance at that offset, metres (undefined if never measurable). */
  medianResidualM?: number;
  /** How many photos had both time and GPS. */
  samples: number;
}

export interface ClockOptions {
  /** A median residual at or under this means "the clock agrees" (m). */
  okResidualM?: number;
  /** Fewer usable photos than this → `unknown`. */
  minSamples?: number;
  /** Search range either side of zero (ms). Time zones span −12 h … +14 h. */
  rangeMs?: number;
  /** Coarse step (ms): quarter hours cover every real time zone. */
  coarseStepMs?: number;
  /** Fine step around the coarse best (ms). */
  fineStepMs?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const MAX_CLOCK_OFFSET_MS = 14 * HOUR;

/**
 * Median distance between the photos and the recording at `offsetMs`, or
 * Infinity when fewer than half the photos (or fewer than `minSamples`) fall
 * inside the recording at that offset — an offset that pushes most photos
 * off either end explains nothing.
 */
export function clockResidualM(
  index: TrackIndex,
  samples: readonly ClockSample[],
  offsetMs: number,
  minSamples = 3,
): number {
  const ds: number[] = [];
  for (const s of samples) {
    // No end margin here: clamping every out-of-range photo onto the last fix
    // would make a wrong offset look like a match for photos taken near the end.
    const pos = positionAtTime(index, s.takenAt + offsetMs, { marginMs: 0 });
    if (!pos) continue;
    ds.push(
      haversineMeters(
        { latitude: s.lngLat[1], longitude: s.lngLat[0] },
        { latitude: pos.lngLat[1], longitude: pos.lngLat[0] },
      ),
    );
  }
  if (ds.length < minSamples || ds.length * 2 < samples.length) return Infinity;
  return median(ds);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A residual this close to the best counts as a tie; the smaller offset wins. */
const TIE_M = 5;

/**
 * Estimate the camera-clock offset from photos with both time and GPS. A
 * coarse scan in quarter hours (every real time-zone difference) then a fine
 * scan in minutes around the best finds both a wrong zone and a drifted clock.
 * About 113 + 31 residual evaluations — a few ms for 50 photos.
 */
export function estimateClockOffset(
  index: TrackIndex,
  samples: readonly ClockSample[],
  {
    okResidualM = 75,
    minSamples = 3,
    rangeMs = MAX_CLOCK_OFFSET_MS,
    coarseStepMs = 15 * MINUTE,
    fineStepMs = MINUTE,
  }: ClockOptions = {},
): ClockEstimate {
  const n = samples.length;
  if (n < minSamples || index.startMs === undefined) {
    return { status: 'unknown', offsetMs: 0, samples: n };
  }
  const at = (offset: number) => clockResidualM(index, samples, offset, minSamples);
  const zero = at(0);
  if (zero <= okResidualM) return { status: 'ok', offsetMs: 0, medianResidualM: zero, samples: n };

  let best = { offset: 0, residual: zero };
  const consider = (offset: number) => {
    const residual = at(offset);
    if (
      residual < best.residual - TIE_M ||
      (Math.abs(residual - best.residual) <= TIE_M && Math.abs(offset) < Math.abs(best.offset))
    ) {
      best = { offset, residual };
    }
  };
  for (let o = -rangeMs; o <= rangeMs; o += coarseStepMs) consider(o);
  const center = best.offset;
  for (let o = center - coarseStepMs; o <= center + coarseStepMs; o += fineStepMs) {
    if (Math.abs(o) <= rangeMs) consider(o);
  }

  if (best.residual <= okResidualM && best.offset !== 0) {
    return {
      status: 'corrected',
      offsetMs: best.offset,
      medianResidualM: best.residual,
      samples: n,
    };
  }
  const estimate: ClockEstimate = { status: 'unknown', offsetMs: 0, samples: n };
  if (Number.isFinite(zero)) estimate.medianResidualM = zero;
  return estimate;
}

/** The Adjust stepper's buttons. */
export type ClockStep = '-1h' | '-1m' | '+1m' | '+1h';

const STEP_MS: Record<ClockStep, number> = {
  '-1h': -HOUR,
  '-1m': -MINUTE,
  '+1m': MINUTE,
  '+1h': HOUR,
};

/** Apply one Adjust step, snapped to whole minutes and clamped to ±14 h. */
export function stepClockOffset(offsetMs: number, step: ClockStep): number {
  const next = Math.round((offsetMs + STEP_MS[step]) / MINUTE) * MINUTE;
  return Math.max(-MAX_CLOCK_OFFSET_MS, Math.min(MAX_CLOCK_OFFSET_MS, next));
}

/** A photo's true time under an offset. */
export function adjustedTime(takenAt: number, offsetMs: number): number {
  return takenAt + offsetMs;
}

/** `"1 h 3 min"`, `"45 min"`, `"2 h"` for a magnitude in ms (rounded to minutes). */
export function formatOffsetMagnitude(ms: number): string {
  const total = Math.round(Math.abs(ms) / MINUTE);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The Add-photos sheet's clock line: what the camera clock does relative to
 * the recording. A positive offset means the camera was BEHIND (its photos
 * say an earlier time than the truth).
 */
export function describeClock(estimate: Pick<ClockEstimate, 'status' | 'offsetMs'>): string {
  if (estimate.status === 'unknown' && estimate.offsetMs === 0) return 'Camera clock not checked';
  const offset = estimate.offsetMs;
  if (Math.round(Math.abs(offset) / MINUTE) === 0) return 'Camera clock matches your GPS';
  const mag = formatOffsetMagnitude(offset);
  return offset > 0 ? `Camera clock is ${mag} behind` : `Camera clock is ${mag} ahead`;
}
