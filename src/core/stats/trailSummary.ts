import { haversineMeters, stepElevationGainLoss, type ElevationAccumulator } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';

import { bestEffortTimes } from './bestEfforts';

/**
 * The per-trail statistics summary the Logbook's Statistics, Personal records
 * and heart-rate zones read (computed ONCE per trail revision, from its
 * points, and cached — see `@data/trailStatsStore`). Everything here needs
 * the full point list; everything that the library index already carries
 * (distance, moving time, climb, highest point) is read from there instead.
 */

/** Bump when the summary's shape or meaning changes: every cached one is recomputed. */
export const TRAIL_STATS_VERSION = 1;

/** Distances timed for "fastest" records, metres (run: 1k…marathon; bike: 5/20/40 km). */
export const EFFORT_DISTANCES_M = [1000, 5000, 10000, 20000, 21097.5, 40000, 42195] as const;

/** Climbs timed for the hiking "fastest climbs", metres of ascent. */
export const EFFORT_CLIMBS_M = [100, 500, 1000] as const;

/** A step faster than this (m/s) is a GPS jump, not movement: the effort chain breaks there. */
export const MAX_PLAUSIBLE_SPEED_MPS = 30;

/** A heart-rate sample counts for at most this long (a longer gap is a dropout). */
export const MAX_HR_SAMPLE_S = 30;

/** Heart rates outside this range are sensor junk. */
const MIN_BPM = 25;
const MAX_BPM = 250;

/**
 * Heart rate over one trail as sparse histograms by whole bpm (ascending):
 * time spent at each rate (zones) and sample counts (the max-HR estimate).
 * Sparse arrays rather than zone totals so a changed max HR re-zones every
 * trail without reading a single GPX again.
 */
export interface HrHistogram {
  bpm: number[];
  seconds: number[];
  samples: number[];
}

export interface TrailStatsSummary {
  v: number;
  /** Fastest time (s) per {@link EFFORT_DISTANCES_M} entry; null: not long enough / untimed. */
  bestDistanceS: (number | null)[];
  /** Fastest time (s) per {@link EFFORT_CLIMBS_M} entry; null: not climbed / untimed. */
  bestClimbS: (number | null)[];
  /** Null when the trail has no heart-rate samples. */
  hr: HrHistogram | null;
}

/** Revision key of a trail: everything an edit (trim, merge, overwrite) changes. */
export function trailStatsKey(
  t: Pick<TrackSummary, 'id' | 'endedAt'> & {
    stats: Pick<TrackSummary['stats'], 'pointCount' | 'distanceM'>;
  },
): string {
  return `${TRAIL_STATS_VERSION}|${t.id}|${t.stats.pointCount}|${t.stats.distanceM}|${t.endedAt ?? ''}`;
}

function timed(p: TrackPoint): boolean {
  return p.hasTime !== false && Number.isFinite(p.time);
}

/**
 * The summary for one trail's points. O(n) per target; a 1 Hz three-hour
 * recording (≈10 k points) takes a few milliseconds.
 */
export function summarizeTrail(
  points: readonly TrackPoint[],
  segmentStarts: readonly number[] = [],
): TrailStatsSummary {
  const n = points.length;
  const dist = new Float64Array(n);
  const asc = new Float64Array(n);
  const timeS = new Float64Array(n);
  const breaks: number[] = [];
  const segmentSet = new Set(segmentStarts);
  let allTimed = n > 1;
  let elevation: ElevationAccumulator = { reference: undefined, ascentM: 0, descentM: 0 };

  for (let k = 0; k < n; k++) {
    const p = points[k]!;
    if (!timed(p)) allTimed = false;
    timeS[k] = p.time / 1000;
    if (k === 0) {
      elevation = stepElevationGainLoss(elevation, p.altitude);
      continue;
    }
    const prev = points[k - 1]!;
    const d = haversineMeters(prev, p);
    const dt = timeS[k]! - timeS[k - 1]!;
    const jump = dt < 0 || (dt === 0 ? d > 5 : d / dt > MAX_PLAUSIBLE_SPEED_MPS);
    if (jump || segmentSet.has(k)) {
      // A new chain: nothing is measured across it. The elevation reference
      // restarts too, so a climb is never counted across a GPS jump.
      breaks.push(k);
      dist[k] = dist[k - 1]!;
      elevation = { reference: undefined, ascentM: elevation.ascentM, descentM: 0 };
    } else {
      dist[k] = dist[k - 1]! + d;
    }
    elevation = stepElevationGainLoss(elevation, p.altitude);
    asc[k] = elevation.ascentM;
  }

  const bestDistanceS = allTimed
    ? bestEffortTimes({ cum: dist, timeS, breaks }, EFFORT_DISTANCES_M).map(roundS)
    : EFFORT_DISTANCES_M.map(() => null);
  const bestClimbS = allTimed
    ? bestEffortTimes({ cum: asc, timeS, breaks }, EFFORT_CLIMBS_M).map(roundS)
    : EFFORT_CLIMBS_M.map(() => null);

  return {
    v: TRAIL_STATS_VERSION,
    bestDistanceS,
    bestClimbS,
    hr: allTimed ? hrHistogram(points) : null,
  };
}

function roundS(s: number | null): number | null {
  return s === null ? null : Math.round(s * 10) / 10;
}

/** Sparse time/sample histograms of a timed point list's heart rate; null without any. */
export function hrHistogram(points: readonly TrackPoint[]): HrHistogram | null {
  const seconds = new Map<number, number>();
  const samples = new Map<number, number>();
  for (let k = 0; k < points.length; k++) {
    const hr = points[k]!.heartRateBpm;
    if (hr === undefined || !Number.isFinite(hr) || hr < MIN_BPM || hr > MAX_BPM) continue;
    const bpm = Math.round(hr);
    samples.set(bpm, (samples.get(bpm) ?? 0) + 1);
    const next = points[k + 1];
    if (next === undefined) continue;
    const dt = (next.time - points[k]!.time) / 1000;
    if (dt > 0 && dt <= MAX_HR_SAMPLE_S) seconds.set(bpm, (seconds.get(bpm) ?? 0) + dt);
  }
  if (samples.size === 0) return null;
  const bpm = [...samples.keys()].sort((a, b) => a - b);
  return {
    bpm,
    seconds: bpm.map((b) => Math.round((seconds.get(b) ?? 0) * 10) / 10),
    samples: bpm.map((b) => samples.get(b) ?? 0),
  };
}

/** Whether a parsed cached value is a summary of the current version (else recompute). */
export function isTrailStatsSummary(value: unknown): value is TrailStatsSummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<TrailStatsSummary>;
  return (
    v.v === TRAIL_STATS_VERSION &&
    Array.isArray(v.bestDistanceS) &&
    v.bestDistanceS.length === EFFORT_DISTANCES_M.length &&
    Array.isArray(v.bestClimbS) &&
    v.bestClimbS.length === EFFORT_CLIMBS_M.length &&
    (v.hr === null ||
      (typeof v.hr === 'object' &&
        v.hr !== undefined &&
        Array.isArray(v.hr.bpm) &&
        Array.isArray(v.hr.seconds) &&
        Array.isArray(v.hr.samples) &&
        v.hr.bpm.length === v.hr.seconds.length &&
        v.hr.bpm.length === v.hr.samples.length))
  );
}
