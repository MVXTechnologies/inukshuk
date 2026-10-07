import type { TrackPoint } from '@core/models';
import { buildTrackAxis } from './trackAxis';

/**
 * Pure elevation-profile sampling: turn a recorded track into an evenly
 * distance-spaced elevation series suitable for charting (x = distance along the
 * track, y = elevation). No platform dependencies — runs in Node (Jest) and the
 * RN JS runtime.
 */

export interface ElevationSample {
  /** Cumulative distance from the track start, in metres. */
  distanceM: number;
  /** Elevation at this distance, in metres (linearly interpolated). */
  elevationM: number;
}

export interface ElevationProfile {
  /** Evenly distance-spaced samples across the elevation-bearing span. */
  samples: ElevationSample[];
  /** Total horizontal (haversine) track distance, in metres. */
  totalDistanceM: number;
  minElevationM: number;
  maxElevationM: number;
  /** True only when at least two points carried usable altitude. */
  hasElevation: boolean;
}

const DEFAULT_SAMPLES = 64;

/**
 * Build an elevation profile from ordered track points.
 *
 * Altitude is plotted against distance-along-track (not point index), so an
 * even x-spacing reflects ground covered, matching how hikers read a profile.
 * Points without altitude still contribute to distance but are skipped for the
 * elevation series; the series is then resampled to `samples` evenly-spaced
 * points by linear interpolation. A track with fewer than two usable altitudes
 * yields `hasElevation: false` and no samples.
 *
 * The x axis is `buildTrackAxis`'s: a segment gap (`segmentStarts`, one per
 * pause) adds no distance (#325), so the axis ends at the trail's distance
 * stat and a relocation pause is a step in the curve, not a slope across the
 * water.
 */
export function buildElevationProfile(
  points: readonly TrackPoint[],
  opts?: { samples?: number; segmentStarts?: readonly number[] },
): ElevationProfile {
  const sampleCount = Math.max(2, Math.floor(opts?.samples ?? DEFAULT_SAMPLES));

  // Cumulative distance over the full track, plus the (distance, elevation)
  // series restricted to points that actually carry altitude.
  const { cumM, totalM: totalDistanceM } = buildTrackAxis(points, opts?.segmentStarts);
  const dists: number[] = [];
  const eles: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.altitude !== undefined && !Number.isNaN(p.altitude)) {
      dists.push(cumM[i]!);
      eles.push(p.altitude);
    }
  }

  if (eles.length < 2) {
    const only = eles.length === 1 ? eles[0]! : 0;
    return {
      samples: [],
      totalDistanceM,
      minElevationM: only,
      maxElevationM: only,
      hasElevation: false,
    };
  }

  let minElevationM = Infinity;
  let maxElevationM = -Infinity;
  for (const e of eles) {
    if (e < minElevationM) minElevationM = e;
    if (e > maxElevationM) maxElevationM = e;
  }

  const startD = dists[0]!;
  const endD = dists[dists.length - 1]!;
  const span = endD - startD;

  const samples: ElevationSample[] = new Array(sampleCount);
  let seg = 0;
  for (let i = 0; i < sampleCount; i++) {
    const target = span === 0 ? startD : startD + (span * i) / (sampleCount - 1);
    // Advance the segment cursor so dists[seg] <= target <= dists[seg+1].
    // `target` increases monotonically, so the cursor never needs to rewind.
    while (seg < dists.length - 2 && dists[seg + 1]! < target) seg++;
    const d0 = dists[seg]!;
    const d1 = dists[seg + 1]!;
    const t = d1 === d0 ? 0 : (target - d0) / (d1 - d0);
    const elevationM = eles[seg]! + (eles[seg + 1]! - eles[seg]!) * t;
    samples[i] = { distanceM: target, elevationM };
  }

  return { samples, totalDistanceM, minElevationM, maxElevationM, hasElevation: true };
}
