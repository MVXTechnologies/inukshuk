import type { TrackPoint } from '@core/models';

/** Metres per degree of latitude (haversine with R = 6 371 008.8 m). */
export const M_PER_DEG_LAT = (Math.PI / 180) * 6_371_008.8;

export interface Leg {
  /** Ground covered northward, metres (0 = standing still). */
  m: number;
  /** Duration, seconds. */
  s: number;
  /** Altitude change over the leg, metres. */
  rise?: number;
}

/**
 * A synthetic outing heading due north from (46.8, -71.2): one fix every
 * `stepS` seconds, legs walked at constant speed and grade. Test-only.
 */
export function walk(
  legs: readonly Leg[],
  opts?: { stepS?: number; startAlt?: number; t0?: number; timed?: boolean },
): TrackPoint[] {
  const stepS = opts?.stepS ?? 5;
  const timed = opts?.timed ?? true;
  let lat = 46.8;
  let alt = opts?.startAlt ?? 200;
  let t = opts?.t0 ?? Date.UTC(2026, 8, 28, 13, 0, 0);
  const pts: TrackPoint[] = [];
  const push = () =>
    pts.push({
      latitude: lat,
      longitude: -71.2,
      altitude: alt,
      time: timed ? t : 0,
      ...(timed ? {} : { hasTime: false }),
    });
  push();
  for (const leg of legs) {
    const n = Math.max(1, Math.round(leg.s / stepS));
    for (let i = 0; i < n; i++) {
      lat += leg.m / n / M_PER_DEG_LAT;
      alt += (leg.rise ?? 0) / n;
      t += (leg.s / n) * 1000;
      push();
    }
  }
  return pts;
}
