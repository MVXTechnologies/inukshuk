import type { TrackPoint } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';

/** A position along a track plus its interpolated attributes. */
export interface TrackPointAt {
  latitude: number;
  longitude: number;
  /** Cumulative distance from the start, in metres. */
  distanceM: number;
  /** Interpolated altitude (m), if the track has elevation. */
  elevation?: number;
  /** Interpolated GPS speed (m/s), if recorded. */
  speed?: number;
  /** Interpolated timestamp (epoch ms), if recorded. */
  time?: number;
  /** Interpolated heart rate (bpm), if the track carries HR samples. */
  heartRateBpm?: number;
}

/** Linear interpolation of two optional numbers (undefined-safe). */
function lerpOpt(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + (b - a) * t;
}

/**
 * Interpolate a track's position (and altitude/speed/time) at a given distance
 * along it. Walks the haversine arc-length of the original GPS points and lerps
 * within the containing segment. Clamps `distanceM` to [0, totalLength]. Pure —
 * used to sync a map marker to the elevation-profile scrubber.
 */
export function interpolateTrackAtDistance(
  points: readonly TrackPoint[],
  distanceM: number,
): TrackPointAt | null {
  if (points.length === 0) return null;
  const first = points[0]!;
  if (points.length === 1) {
    return {
      latitude: first.latitude,
      longitude: first.longitude,
      distanceM: 0,
      elevation: first.altitude,
      speed: first.speed,
      time: first.time,
      heartRateBpm: first.heartRateBpm,
    };
  }

  const target = Math.max(0, distanceM);
  let cum = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = haversineMeters(a, b);
    if (cum + seg >= target) {
      const t = seg > 0 ? Math.min(1, Math.max(0, (target - cum) / seg)) : 0;
      return {
        latitude: a.latitude + (b.latitude - a.latitude) * t,
        longitude: a.longitude + (b.longitude - a.longitude) * t,
        distanceM: cum + seg * t,
        elevation: lerpOpt(a.altitude, b.altitude, t),
        speed: lerpOpt(a.speed, b.speed, t),
        time: lerpOpt(a.time, b.time, t),
        heartRateBpm: lerpOpt(a.heartRateBpm, b.heartRateBpm, t),
      };
    }
    cum += seg;
  }

  // Past the end → clamp to the last point.
  const last = points[points.length - 1]!;
  return {
    latitude: last.latitude,
    longitude: last.longitude,
    distanceM: cum,
    elevation: last.altitude,
    speed: last.speed,
    time: last.time,
    heartRateBpm: last.heartRateBpm,
  };
}
