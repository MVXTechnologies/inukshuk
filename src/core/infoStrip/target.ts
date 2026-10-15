/**
 * Shared-target resolution (owner Q4): the strip has one target that every
 * target field (name, distance, bearing, ETE, ETA) follows, and each field
 * may pick its own instead.
 */
import { formatCoordinate } from '@core/convert/coordinateDisplay';
import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';

import type { DepsSnapshot, FollowSnapshot, ResolvedTarget, StripSubject, Target } from './types';

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
    case 'navTarget': {
      if (data.follow !== null) return fromFollow(data.follow);
      const n = data.navTarget;
      if (n === null) return null;
      // Set on a saved waypoint: it is that waypoint, drawn as its pin.
      if (n.waypointId !== undefined) {
        return {
          key: waypointKey(n.waypointId),
          name: n.name,
          point: n.point,
          glyph: 'place',
          pin: n.pin ?? {},
          alongTrailM: null,
        };
      }
      return { key: 'destination', name: n.name, point: n.point, glyph: 'flag', alongTrailM: null };
    }
    case 'nextOnTrail':
      return data.follow === null ? null : fromFollow(data.follow);
    case 'waypoint': {
      const w = data.waypoints[target.waypointId];
      return w === undefined
        ? null
        : {
            key: waypointKey(target.waypointId),
            name: w.name,
            point: w.point,
            glyph: 'place',
            pin: w.pin ?? {},
            alongTrailM: null,
          };
    }
    case 'coordinate':
      return {
        key: `point:${target.point.latitude},${target.point.longitude}`,
        name:
          target.label ??
          formatCoordinate(target.point.latitude, target.point.longitude, data.coordinateFormat),
        point: target.point,
        glyph: 'my_location',
        alongTrailM: null,
      };
  }
}

/** A saved waypoint's identity, whichever way a field reached it (picked, Navigate, the trail's next). */
function waypointKey(id: string): string {
  return `waypoint:${id}`;
}

function fromFollow(follow: FollowSnapshot): ResolvedTarget {
  const base = {
    name: follow.targetName,
    point: follow.targetPoint,
    alongTrailM: follow.targetDistanceM,
  };
  switch (follow.targetKind) {
    case 'waypoint':
      return {
        ...base,
        key: waypointKey(follow.targetId),
        glyph: 'place',
        pin: follow.targetPin ?? {},
      };
    case 'note':
      return { ...base, key: `note:${follow.targetId}`, glyph: 'notes' };
    case 'end':
      return { ...base, key: 'trailEnd', glyph: 'sports_score' };
  }
}

/** What a target field reads to, for its cell (`subject.ts`). */
export function targetSubject(t: ResolvedTarget): StripSubject {
  const out: StripSubject = { key: t.key, name: t.name, glyph: t.glyph };
  if (t.pin !== undefined) out.pin = t.pin;
  return out;
}

/**
 * What a tap on the target-name field opens (#696), on the map's own card
 * paths: a saved waypoint's card, or the point chip (coordinates, Navigate,
 * Waypoint, Convert) on any other point.
 */
export type TargetOpen =
  { kind: 'waypoint'; waypointId: string } | { kind: 'point'; point: LatLng };

/**
 * The card a target opens, or null when it names nothing right now (its
 * field is not even drawn then):
 * - a saved waypoint → its card;
 * - the followed trail's next target → the waypoint's card, or the point
 *   chip on the note or the trail's end;
 * - the destination pin set on a saved waypoint → that waypoint's card;
 * - any other destination pin, or a typed coordinate → the point chip there.
 */
export function targetOpen(target: Target, data: DepsSnapshot): TargetOpen | null {
  switch (target.kind) {
    case 'navTarget':
      if (data.follow !== null) return followOpen(data.follow);
      if (data.navTarget === null) return null;
      return data.navTarget.waypointId === undefined
        ? { kind: 'point', point: data.navTarget.point }
        : { kind: 'waypoint', waypointId: data.navTarget.waypointId };
    case 'nextOnTrail':
      return data.follow === null ? null : followOpen(data.follow);
    case 'waypoint':
      return data.waypoints[target.waypointId] === undefined
        ? null
        : { kind: 'waypoint', waypointId: target.waypointId };
    case 'coordinate':
      return { kind: 'point', point: target.point };
  }
}

function followOpen(follow: FollowSnapshot): TargetOpen {
  return follow.targetKind === 'waypoint'
    ? { kind: 'waypoint', waypointId: follow.targetId }
    : { kind: 'point', point: follow.targetPoint };
}

/** A destination this close to a saved waypoint takes its name, metres. */
export const DESTINATION_NAME_RADIUS_M = 2;

/**
 * The destination pin's name (the nav target's, and the slim destination
 * chip's): the saved waypoint it was set on (Navigate from a waypoint's
 * card), else "Destination".
 */
export function destinationName(
  at: LatLng,
  waypoints: readonly { latitude: number; longitude: number; label: string }[],
): string {
  return destinationWaypoint(at, waypoints)?.label ?? 'Destination';
}

/** The saved waypoint a destination was set on (within {@link DESTINATION_NAME_RADIUS_M}), if any. */
export function destinationWaypoint<W extends LatLng>(
  at: LatLng,
  waypoints: readonly W[],
): W | undefined {
  return waypoints.find((p) => haversineMeters(p, at) <= DESTINATION_NAME_RADIUS_M);
}

/**
 * The `limit` saved waypoints nearest `here`, nearest first (the target
 * picker's list); the first `limit` as stored without a place. O(n log n):
 * callers memo it on a coarse cell (`cellOf`), never per tick.
 */
export function nearestWaypoints<W extends LatLng>(
  waypoints: readonly W[],
  here: LatLng | null,
  limit: number,
): W[] {
  if (here === null) return waypoints.slice(0, limit);
  return waypoints
    .map((w) => ({ w, d: haversineMeters(here, w) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.w);
}
