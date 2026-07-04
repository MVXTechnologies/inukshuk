import type { TrackPoint } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';

/**
 * Pure GPS-fix gating for the recorder. Raw fixes used to be appended verbatim;
 * a single bad fix (poor accuracy under tree cover, or a cold-start "teleport"
 * hundreds of metres away) permanently inflates distance and D+/D- — the
 * headline stats. This filter rejects those before they reach the track.
 */

/** Fixes with a reported horizontal accuracy radius worse than this are dropped. */
export const MAX_ACCURACY_M = 35;

/**
 * Fixes implying a speed from the previous accepted point above this are
 * dropped as teleport outliers (40 m/s = 144 km/h — beyond anything on a trail).
 */
export const MAX_SPEED_MPS = 40;

/**
 * Fixes closer in time than this to the previous accepted point are dropped as
 * near-duplicates. This is the belt against double-feeding when both the
 * background location task and the foreground watch deliver the same fix.
 */
export const MIN_INTERVAL_MS = 250;

export interface GpsFilterOptions {
  /** Max acceptable horizontal accuracy radius in metres. Default {@link MAX_ACCURACY_M}. */
  maxAccuracyM?: number;
  /** Max plausible implied speed from the previous point, m/s. Default {@link MAX_SPEED_MPS}. */
  maxSpeedMps?: number;
  /** Min time gap from the previous point, ms. Default {@link MIN_INTERVAL_MS}. */
  minIntervalMs?: number;
}

/**
 * Decide whether a GPS fix should be appended to the recorded track.
 *
 * - Fixes with a reported `accuracy` worse than `maxAccuracyM` are rejected.
 * - Fixes WITHOUT an accuracy are accepted (older data, platforms that omit it).
 * - Fixes implying a speed from `prev` above `maxSpeedMps` are rejected as
 *   teleport outliers (this also rejects non-monotonic timestamps, whose
 *   implied speed is treated as infinite).
 * - Fixes within `minIntervalMs` of `prev` are rejected as duplicates.
 * - The first point of a track (`prev === undefined`) only has to pass the
 *   accuracy gate.
 */
export function shouldAcceptFix(
  prev: TrackPoint | undefined,
  next: TrackPoint,
  opts?: GpsFilterOptions,
): boolean {
  const maxAccuracyM = opts?.maxAccuracyM ?? MAX_ACCURACY_M;
  const maxSpeedMps = opts?.maxSpeedMps ?? MAX_SPEED_MPS;
  const minIntervalMs = opts?.minIntervalMs ?? MIN_INTERVAL_MS;

  if (next.accuracy !== undefined && next.accuracy > maxAccuracyM) return false;
  if (!prev) return true;

  const dtMs = next.time - prev.time;
  if (dtMs < minIntervalMs) return false; // duplicate / out-of-order delivery

  const impliedSpeed = haversineMeters(prev, next) / (dtMs / 1000);
  return impliedSpeed <= maxSpeedMps;
}
