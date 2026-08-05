import type { TrackPoint } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';

/**
 * Live/instantaneous speed for the recording HUD, in m/s.
 *
 * `TrackStats.avgSpeedMps` is a whole-session moving average (total distance /
 * total moving time) — great for a trail summary, but wrong for a live "how
 * fast am I going right now" readout: on a long recording it drifts toward
 * the ride's overall average and can look "stuck" even as the real speed
 * changes a lot (e.g. cruising at 110 km/h but the HUD reads ~100, the whole
 * trip's average). This function instead prefers the newest fix's own
 * GPS-reported speed (accurate, Doppler-derived, already instantaneous), and
 * only falls back to a short rolling-window average when that isn't
 * available or looks bogus.
 */

/** Default rolling-window length used when a fix has no usable `speed`. */
export const LIVE_SPEED_WINDOW_MS = 5000;

export interface LiveSpeedOptions {
  /** Rolling-window length in ms for the fallback path. Default {@link LIVE_SPEED_WINDOW_MS}. */
  windowMs?: number;
}

function isUsableSpeed(speed: number | undefined): speed is number {
  return speed !== undefined && Number.isFinite(speed) && speed >= 0;
}

/**
 * Instantaneous speed in m/s from an ordered list of ACCEPTED track points
 * (i.e. already passed through `shouldAcceptFix`).
 *
 * - Empty input → 0.
 * - The latest point's own `speed` is used when it's a finite, non-negative
 *   number (expo-location reports `coords.speed` in m/s; GPX imports may omit
 *   it or, rarely, report a negative sentinel).
 * - Otherwise, falls back to distance/time over the points within
 *   `windowMs` of the latest point's timestamp (a short rolling average —
 *   still far more "live" than the whole-session average).
 * - If the window contains only the latest point (no second point within
 *   `windowMs`), returns 0 rather than dividing by ~0.
 */
export function liveSpeed(points: readonly TrackPoint[], opts?: LiveSpeedOptions): number {
  const windowMs = opts?.windowMs ?? LIVE_SPEED_WINDOW_MS;
  const last = points[points.length - 1];
  if (!last) return 0;

  if (isUsableSpeed(last.speed)) return last.speed;

  const cutoff = last.time - windowMs;
  let startIdx = points.length - 1;
  while (startIdx > 0) {
    const candidate = points[startIdx - 1];
    if (!candidate || candidate.time < cutoff) break;
    startIdx--;
  }
  const first = points[startIdx];
  if (!first || first === last) return 0;

  const dtS = (last.time - first.time) / 1000;
  if (dtS <= 0) return 0;

  return haversineMeters(first, last) / dtS;
}
