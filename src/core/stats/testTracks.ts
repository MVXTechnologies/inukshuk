import type { TrackPoint, TrackSummary } from '@core/models';

/**
 * Test helpers for `@core/stats` (never imported by the app): synthetic
 * points and library summaries.
 */

/** Metres per degree of latitude on the haversine sphere the app uses. */
export const M_PER_DEG_LAT = (6371008.8 * Math.PI) / 180;

/**
 * A straight northward track: `stepM` metres and `stepS` seconds per fix,
 * with optional per-fix altitudes and heart rates.
 */
export function straightTrack(opts: {
  n: number;
  stepM: number;
  stepS: number;
  start?: number;
  altitude?: (k: number) => number | undefined;
  hr?: (k: number) => number | undefined;
}): TrackPoint[] {
  const start = opts.start ?? Date.UTC(2026, 0, 1, 12);
  const out: TrackPoint[] = [];
  for (let k = 0; k < opts.n; k++) {
    const p: TrackPoint = {
      latitude: 46 + (k * opts.stepM) / M_PER_DEG_LAT,
      longitude: -71,
      time: start + k * opts.stepS * 1000,
    };
    const alt = opts.altitude?.(k);
    if (alt !== undefined) p.altitude = alt;
    const hr = opts.hr?.(k);
    if (hr !== undefined) p.heartRateBpm = hr;
    out.push(p);
  }
  return out;
}

let seq = 0;

/** A performed-activity summary as the library index holds it. */
export function summary(
  over: Partial<Omit<TrackSummary, 'stats'>> & {
    startedAt: number;
    stats?: Partial<TrackSummary['stats']>;
  },
): TrackSummary {
  seq++;
  const { stats, ...rest } = over;
  return {
    id: `t${seq}`,
    name: `Trail ${seq}`,
    fileUri: `tracks/t${seq}.gpx`,
    category: 'run',
    ...rest,
    stats: {
      distanceM: 5000,
      ascentM: 50,
      descentM: 50,
      durationS: 1800,
      movingTimeS: 1500,
      avgSpeedMps: 3.3,
      maxSpeedMps: 4,
      pointCount: 100,
      ...stats,
    },
  };
}
