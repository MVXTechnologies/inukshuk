import type { TrackPoint } from '@core/models';
import type { ElevationSample } from './elevationProfile';
import { interpolateTrackAtDistance, type TrackPointAt } from './interpolate';

/**
 * Pure chart-scrub math: map a horizontal touch position on the elevation
 * profile (a 0..1 ratio of the chart width) to the profile sample under the
 * finger and the interpolated position on the trail itself, so the UI can move
 * a marker along the trace as the user scrubs. No platform dependencies.
 */

export interface ProfileScrub {
  /** Index of the nearest profile sample (drives the chart cursor). */
  sampleIndex: number;
  /** Interpolated on-trail position and attributes at that sample's distance. */
  at: TrackPointAt;
}

/**
 * Resolve a chart-x ratio (touchX / chartWidth) to the nearest elevation-profile
 * sample and the corresponding interpolated point on the track.
 *
 * The ratio is clamped to [0, 1]; a non-finite ratio, an empty profile or an
 * empty track yields null. Samples are evenly distance-spaced (see
 * buildElevationProfile), so the nearest sample is simply `round(ratio * last)`.
 */
export function scrubProfileAtRatio(
  points: readonly TrackPoint[],
  samples: readonly ElevationSample[],
  ratio: number,
): ProfileScrub | null {
  if (samples.length === 0 || !Number.isFinite(ratio)) return null;
  const lastIdx = samples.length - 1;
  const clamped = Math.max(0, Math.min(1, ratio));
  const sampleIndex = Math.min(lastIdx, Math.max(0, Math.round(clamped * lastIdx)));
  const sample = samples[sampleIndex];
  if (!sample) return null;
  const at = interpolateTrackAtDistance(points, sample.distanceM);
  return at ? { sampleIndex, at } : null;
}
