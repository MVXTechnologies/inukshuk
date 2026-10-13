import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import type { LatLng } from '@core/models';
import { nextFollowTarget, type FollowTarget, type FollowTargets } from './followTargets';
import { latchLow, OFF_TRAIL_OUT_M, ON_TRAIL_IN_M } from './hysteresis';
import { pointAtAlong, projectionPoint, type PreparedTrail } from './trailIndex';
import { createTrailTracker, type TrailFix, type TrailTrackerOptions } from './trailTracker';

/**
 * Following a trail (#678, basic): one fix in, everything the compass and the
 * map draw out. Pure, so the whole behaviour — switchbacks, off-trail
 * hysteresis, target advance — is tested on real-shaped tracks.
 *
 * Targets advance with your furthest progress along the trail, so noise
 * around a waypoint you just reached doesn't flip the flag back to it.
 *
 * Per fix: one tracker update (see `trailTracker.ts` for its cost), one
 * O(log n) lookahead point, one O(log k) target pick and three haversines.
 */

/** The trail direction is read towards the point this far ahead along the trail, metres. */
export const LOOKAHEAD_M = 40;

/**
 * Walking back more than this below your furthest point along the trail
 * means you turned around: the targets follow you back, metres. Less than
 * this is GPS noise along the trail, and a target you just reached must not
 * come back because a fix landed a few metres behind it.
 */
export const TURN_BACK_M = 30;

export interface FollowReadout {
  /** Your distance along the trail (at your nearest point), metres. */
  alongM: number;
  /** Distance from you to the trail, metres. */
  crossTrackM: number;
  /** Latched: off past 30 m, back on within 20 m. */
  onTrail: boolean;
  /** Your nearest point of the trail (the dashed line's end when off it). */
  nearest: LatLng;
  /**
   * The orange bar: the bearing to the point {@link LOOKAHEAD_M} ahead along
   * the trail while on it, to the nearest point of the trail when off it.
   * Null only for a trail with no length.
   */
  trailBearingDeg: number | null;
  /** The sage flag's target. */
  target: FollowTarget;
  /** Bearing from you to the target, degrees. */
  targetBearingDeg: number;
  /**
   * How far the target is, metres: what is left along the trail plus the way
   * back to it, and never less than the straight line.
   */
  targetDistanceM: number;
  /** The tracker's work for this fix. */
  cost: TrailFix['cost'];
}

/**
 * Bearing from `from` towards the point `aheadM` along the trail from
 * `alongM`. At the very end of the trail (nothing left ahead) it is the
 * trail's own final direction. Null for a zero-length trail.
 */
export function lookaheadBearingDeg(
  trail: PreparedTrail,
  from: LatLng,
  alongM: number,
  aheadM = LOOKAHEAD_M,
): number | null {
  if (trail.lengthM <= 0) return null;
  const ahead = pointAtAlong(trail, alongM + aheadM);
  if (haversineMeters(from, ahead) >= 1) return initialBearingDeg(from, ahead);
  const back = pointAtAlong(trail, Math.max(0, trail.lengthM - aheadM));
  const end = pointAtAlong(trail, trail.lengthM);
  return initialBearingDeg(back, end);
}

export interface FollowSession {
  update(fix: LatLng): FollowReadout;
  /**
   * Swap the target list (a waypoint was added, moved or deleted, a note
   * edited) WITHOUT starting over: where you are on the trail, your furthest
   * progress and the on/off-trail latch all stay. Rebuilding the session
   * instead would throw the tracker's window away, and its whole-trail
   * re-acquisition can land on the other leg of an out-and-back.
   */
  setTargets(targets: FollowTargets): void;
}

export function createFollowSession(
  trail: PreparedTrail,
  targets: FollowTargets,
  options: TrailTrackerOptions = {},
): FollowSession {
  const tracker = createTrailTracker(trail, options);
  // Following starts "on the trail": an approach from 25 m away doesn't open
  // on an amber warning, and the latch only trips past 30 m.
  let onTrail = true;
  // Furthest point reached along the trail (see TURN_BACK_M).
  let progressM = -Infinity;
  let current = targets;
  return {
    setTargets(next) {
      current = next;
    },
    update(fix) {
      const pos = tracker.update(fix);
      if (pos.alongM > progressM || pos.alongM < progressM - TURN_BACK_M) progressM = pos.alongM;
      onTrail = latchLow(onTrail, pos.distM, ON_TRAIL_IN_M, OFF_TRAIL_OUT_M);
      const nearest = projectionPoint(trail, pos);
      const trailBearingDeg = onTrail
        ? lookaheadBearingDeg(trail, fix, pos.alongM)
        : initialBearingDeg(fix, nearest);
      const target = nextFollowTarget(current, progressM);
      const straight = haversineMeters(fix, target.at);
      const viaTrail = Math.max(0, target.alongM - pos.alongM) + pos.distM;
      return {
        alongM: pos.alongM,
        crossTrackM: pos.distM,
        onTrail,
        nearest,
        trailBearingDeg,
        target,
        targetBearingDeg: initialBearingDeg(fix, target.at),
        targetDistanceM: Math.max(straight, viaTrail),
        cost: pos.cost,
      };
    },
  };
}
