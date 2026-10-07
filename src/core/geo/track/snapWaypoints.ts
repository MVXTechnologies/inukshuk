import type { TrackPoint } from '@core/models';
import type { GpxWaypoint } from '@core/geo/gpx';
import { haversineMeters } from '@core/geo/geomath';
import { buildTrackAxis } from './trackAxis';

/** A note to seed on an imported trail, anchored by distance along it. */
export interface ImportedNote {
  distanceM: number;
  text: string;
}

const labelOf = (w: GpxWaypoint): string => {
  const name = w.name?.trim();
  const desc = w.description?.trim();
  if (name && desc) return `${name} — ${desc}`;
  return name || desc || 'Waypoint';
};

/**
 * Convert GPX <wpt> markers into distance-anchored trail notes by snapping each
 * waypoint to the nearest track point and using that point's cumulative
 * distance from the start — on `buildTrackAxis`, so a multi-`<trkseg>` file's
 * gaps add nothing (#325). Pure — unit-tested independently of import I/O.
 */
export function snapWaypointsToNotes(
  points: readonly TrackPoint[],
  waypoints: readonly GpxWaypoint[],
  segmentStarts: readonly number[] = [],
): ImportedNote[] {
  if (points.length === 0 || waypoints.length === 0) return [];

  // Cumulative distance to each point index.
  const cum = buildTrackAxis(points, segmentStarts).cumM;

  const notes = waypoints.map((w) => {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = haversineMeters(points[i]!, w);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return { distanceM: cum[bestIdx]!, text: labelOf(w) };
  });

  return notes.sort((a, b) => a.distanceM - b.distanceM);
}
