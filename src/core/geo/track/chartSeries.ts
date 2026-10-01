import type { TrackPoint } from '@core/models';
import type { Stop } from './highlights';
import { interpolateOnAxis, type TrackAxis } from './trackAxis';

/**
 * The Charts tab's three synced series (#511, board C2), sampled at the same
 * evenly spaced distances along the trail so one cursor lines up across
 * Elevation, Pace/Speed and Heart rate.
 *
 * - Elevation: null when the trail carries no altitude.
 * - Speed (m/s): ground covered over a short window around each sample.
 *   Null where the window holds a stop or pause — the line breaks there and
 *   the stop gets a label instead of a plunge to zero. Null overall for an
 *   untimed route.
 * - Heart rate (bpm): null overall when no point carries it.
 */
export interface ChartSeries {
  /** Axis distance of each sample, metres (0 … totalM, evenly spaced). */
  distances: number[];
  totalM: number;
  elevation: (number | null)[] | null;
  speed: (number | null)[] | null;
  heartRate: (number | null)[] | null;
  /** Stops and pauses to mark on the pace chart, by axis distance. */
  stopMarks: { distanceM: number; durationS: number; kind: Stop['kind'] }[];
}

export interface ChartSeriesOpts {
  samples?: number;
  stops?: readonly Stop[];
  /** False for an untimed route: no speed series. */
  timed: boolean;
}

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/** Faster than this (m/s) is a GPS glitch, not a hiker, runner or rider. */
const MAX_PLAUSIBLE_SPEED_MPS = 40;

export function buildChartSeries(
  points: readonly TrackPoint[],
  axis: TrackAxis,
  opts: ChartSeriesOpts,
): ChartSeries {
  const n = Math.max(2, Math.floor(opts.samples ?? 240));
  const totalM = axis.totalM;
  const distances = Array.from({ length: n }, (_, i) => (totalM * i) / (n - 1));
  const stopMarks = (opts.stops ?? []).map((s) => ({
    distanceM: axis.cumM[s.startIndex] ?? 0,
    endM: axis.cumM[s.endIndex] ?? 0,
    durationS: s.durationS,
    kind: s.kind,
  }));

  const ats = distances.map((d) => interpolateOnAxis(points, axis, d));
  const hasAlt = points.some((p) => finite(p.altitude));
  const hasHr = points.some((p) => finite(p.heartRateBpm) && p.heartRateBpm > 0);

  const elevation = hasAlt ? ats.map((a) => (a && finite(a.elevation) ? a.elevation : null)) : null;
  const heartRate = hasHr
    ? ats.map((a) => (a && finite(a.heartRateBpm) && a.heartRateBpm > 0 ? a.heartRateBpm : null))
    : null;

  let speed: (number | null)[] | null = null;
  if (opts.timed && totalM > 0) {
    // ±75 m (or two samples) of ground: steady enough to read, short enough
    // to show a steep pitch slowing you down.
    const w = Math.max(75, (totalM / (n - 1)) * 2);
    speed = distances.map((d) => {
      const d0 = Math.max(0, d - w);
      const d1 = Math.min(totalM, d + w);
      // A stop inside the window would drag the average to a crawl: break the line.
      if (stopMarks.some((s) => s.endM >= d0 && s.distanceM <= d1)) return null;
      const t0 = interpolateOnAxis(points, axis, d0)?.time;
      const t1 = interpolateOnAxis(points, axis, d1)?.time;
      if (!finite(t0) || !finite(t1) || t1 <= t0) return null;
      const v = (d1 - d0) / ((t1 - t0) / 1000);
      return v > 0 && v < MAX_PLAUSIBLE_SPEED_MPS ? v : null;
    });
    if (speed.every((v) => v === null)) speed = null;
  }

  return {
    distances,
    totalM,
    elevation,
    speed,
    heartRate,
    stopMarks: stopMarks.map(({ distanceM, durationS, kind }) => ({ distanceM, durationS, kind })),
  };
}

/** The sample nearest a distance (the series are evenly spaced). */
export function sampleIndexAt(
  series: Pick<ChartSeries, 'distances' | 'totalM'>,
  d: number,
): number {
  const n = series.distances.length;
  if (n === 0 || !(series.totalM > 0)) return 0;
  return Math.min(n - 1, Math.max(0, Math.round((d / series.totalM) * (n - 1))));
}

/** Mean heart rate over the points that carry one, rounded; null without any. */
export function averageHeartRate(points: readonly TrackPoint[]): number | null {
  let sum = 0;
  let count = 0;
  for (const p of points) {
    if (finite(p.heartRateBpm) && p.heartRateBpm > 0) {
      sum += p.heartRateBpm;
      count += 1;
    }
  }
  return count > 0 ? Math.round(sum / count) : null;
}

export interface HeartRateBand {
  fromBpm: number;
  toBpm: number;
  label: string;
}

/**
 * Light effort bands for the heart-rate chart. Without the user's real
 * maximum, the outing's own peak stands in for it: "hard" is the top 10 %,
 * "moderate" the 10 % below — enough to see where the effort went.
 */
export function heartRateBands(series: readonly (number | null)[]): HeartRateBand[] {
  let max = 0;
  for (const v of series) if (v !== null && v > max) max = v;
  if (max <= 0) return [];
  return [
    { fromBpm: Math.round(max * 0.9), toBpm: Math.round(max), label: 'hard' },
    { fromBpm: Math.round(max * 0.8), toBpm: Math.round(max * 0.9), label: 'moderate' },
  ];
}
