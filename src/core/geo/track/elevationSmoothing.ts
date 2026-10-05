import type { TrackPoint } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';

/**
 * Distance-window smoothing of a track's elevation profile, for climb/descent.
 *
 * Why: route files planned on a server (a Garmin Connect course, most
 * route planners) carry elevations looked up in a terrain model for points a
 * few metres apart, and the lookup is nearest-pixel. Wherever the line runs
 * across a slope — a traverse, a balcony path, a road above a valley — it
 * hops between neighbouring pixels that differ by tens of metres, and every
 * hop is a real-looking step the 3 m hysteresis happily counts. A 40 km
 * Alpine course with ≈2 500 m of real climb measured ≈4 500 m that way (the
 * "D+ over 4000 m" report): the hysteresis dead-band is about noise
 * AMPLITUDE, and these steps are far above any sane threshold.
 *
 * The cure is to look at the profile at the scale a climb happens on: each
 * sample becomes the mean height of the profile over the `windowM` metres of
 * trail centred on it (the exact mean of the piecewise-linear profile, so the
 * result does not depend on how densely the file is sampled). Sustained
 * climbs survive whole; pixel hopping averages out.
 *
 * Distance runs along every point; points without an elevation are skipped
 * (they stay undefined) and the profile is interpolated across them.
 */
export function smoothElevationsByDistance(
  points: readonly TrackPoint[],
  windowM: number,
): (number | undefined)[] {
  const out: (number | undefined)[] = points.map((p) => finiteAltitude(p));
  if (!(windowM > 0)) return out;

  // The profile: (distance along the track, elevation) for every point with one.
  const dist: number[] = [];
  const ele: number[] = [];
  const index: number[] = [];
  let d = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) d += haversineMeters(points[i - 1]!, p);
    const h = out[i];
    if (h === undefined) continue;
    dist.push(d);
    ele.push(h);
    index.push(i);
  }
  const n = dist.length;
  if (n < 3) return out;

  // area[k]: integral of the profile from its start to sample k (trapezoids).
  const area = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    area[k] = area[k - 1]! + ((ele[k]! + ele[k - 1]!) / 2) * (dist[k]! - dist[k - 1]!);
  }
  const first = dist[0]!;
  const last = dist[n - 1]!;
  if (last - first <= 0) return out;

  // Integral of the profile up to distance x (first ≤ x ≤ last). `hint` is
  // the segment the previous call ended in: the queries only move forward.
  const integralTo = (x: number, hint: { k: number }): number => {
    let k = hint.k;
    while (k < n - 2 && dist[k + 1]! < x) k++;
    hint.k = k;
    const d0 = dist[k]!;
    const d1 = dist[k + 1]!;
    const span = d1 - d0;
    const t = span > 0 ? Math.min(1, Math.max(0, (x - d0) / span)) : 0;
    const hx = ele[k]! + (ele[k + 1]! - ele[k]!) * t;
    return area[k]! + ((ele[k]! + hx) / 2) * (x - d0);
  };

  const half = windowM / 2;
  const lo = { k: 0 };
  const hi = { k: 0 };
  for (let k = 0; k < n; k++) {
    const a = Math.max(first, dist[k]! - half);
    const b = Math.min(last, dist[k]! + half);
    if (b - a <= 0) continue;
    out[index[k]!] = (integralTo(b, hi) - integralTo(a, lo)) / (b - a);
  }
  return out;
}

/** Bump when {@link climbElevations} changes: stored climbs are recomputed lazily. */
export const CLIMB_MODEL_VERSION = 1;

/** The `TrackStats.climbModel` stamp for a climb measured by {@link climbElevations}. */
export const CLIMB_MODEL_KEY = `v${CLIMB_MODEL_VERSION}`;

/** Window of the smoothed profile (≈ two 30 m terrain-model pixels). */
export const CLIMB_SMOOTHING_WINDOW_M = 60;

/**
 * Raw climb+descent more than this many times the smoothed profile's is not
 * terrain any more but sample-to-sample stepping (see
 * {@link smoothElevationsByDistance}). Clean profiles — a barometric watch,
 * a bilinear terrain lookup, phone GPS on a hill — stay well under it (≈1.1–1.25
 * on a 40 km Alpine course); nearest-pixel course elevations run 1.6–1.9.
 */
export const CLIMB_NOISE_RATIO = 1.3;

/** …and by at least this much, so a short or flat trail never flips on a few metres. */
export const CLIMB_NOISE_MIN_EXCESS_M = 30;

/**
 * The elevation series a trail's climb/descent should be measured on: its own
 * elevations, unless they are stepping noise — raw climb+descent far above
 * (×{@link CLIMB_NOISE_RATIO}) that of the {@link CLIMB_SMOOTHING_WINDOW_M}
 * smoothed profile — in which case the smoothed profile.
 *
 * Deliberately a switch, not "always smooth": a clean recording (a
 * barometric watch, whose D+ people compare with Garmin/Strava) keeps its
 * numbers to the metre; only a profile that is visibly broken is replaced.
 */
export function climbElevations(
  points: readonly TrackPoint[],
  threshold: number,
): (number | undefined)[] {
  const raw = points.map(finiteAltitude);
  const rawTotal = hysteresisTotal(raw, threshold);
  if (rawTotal <= CLIMB_NOISE_MIN_EXCESS_M) return raw;
  const smooth = smoothElevationsByDistance(points, CLIMB_SMOOTHING_WINDOW_M);
  const smoothTotal = hysteresisTotal(smooth, threshold);
  const noisy =
    rawTotal > smoothTotal * CLIMB_NOISE_RATIO && rawTotal - smoothTotal > CLIMB_NOISE_MIN_EXCESS_M;
  return noisy ? smooth : raw;
}

/** Climb + descent of a series under the hysteresis rule (as `elevationGainLoss`). */
function hysteresisTotal(series: readonly (number | undefined)[], threshold: number): number {
  let reference: number | undefined;
  let total = 0;
  for (const h of series) {
    if (h === undefined) continue;
    if (reference === undefined) {
      reference = h;
      continue;
    }
    const delta = Math.abs(h - reference);
    if (delta >= threshold) {
      total += delta;
      reference = h;
    }
  }
  return total;
}

function finiteAltitude(p: TrackPoint): number | undefined {
  return p.altitude !== undefined && Number.isFinite(p.altitude) ? p.altitude : undefined;
}
