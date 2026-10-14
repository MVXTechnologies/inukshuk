/**
 * Shared-target resolution (owner Q4): the strip has one target that every
 * target field (name, distance, bearing, ETE, ETA) follows, and each field
 * may pick its own instead.
 */
import { formatCoordinate } from '@core/convert/coordinateDisplay';

import type { DepsSnapshot, FollowSnapshot, ResolvedTarget, Target } from './types';

/** The strip's target unless the field picked its own (`params.target` non-null). */
export function effectiveTarget(
  fieldTarget: Target | null | undefined,
  stripTarget: Target,
): Target {
  return fieldTarget ?? stripTarget;
}

/**
 * A target against the live data, or null when it names nothing right now
 * (no destination, not following, a deleted waypoint): its fields step aside.
 */
export function resolveTarget(target: Target, data: DepsSnapshot): ResolvedTarget | null {
  switch (target.kind) {
    case 'navTarget':
      if (data.follow !== null) return fromFollow(data.follow);
      return data.navTarget === null
        ? null
        : { ...data.navTarget, glyph: 'flag', alongTrailM: null };
    case 'nextOnTrail':
      return data.follow === null ? null : fromFollow(data.follow);
    case 'waypoint': {
      const w = data.waypoints[target.waypointId];
      return w === undefined ? null : { ...w, glyph: 'place', alongTrailM: null };
    }
    case 'coordinate':
      return {
        name:
          target.label ??
          formatCoordinate(target.point.latitude, target.point.longitude, data.coordinateFormat, {
            compact: true,
          }),
        point: target.point,
        glyph: 'my_location',
        alongTrailM: null,
      };
  }
}

function fromFollow(follow: FollowSnapshot): ResolvedTarget {
  return {
    name: follow.targetName,
    point: follow.targetPoint,
    glyph: 'route',
    alongTrailM: follow.targetDistanceM,
  };
}
