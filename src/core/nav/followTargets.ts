import type { LatLng } from '@core/models';
import { nearestOnTrail, pointAtAlong, type PreparedTrail } from './trailIndex';

/**
 * The "next target" of a followed trail (#678): the next waypoint ahead, else
 * the next trail note, else the trail's end.
 *
 * Everything is ordered by **distance along the trail**, never by straight
 * line: on a switchback the waypoint on the next leg can be 20 m away as the
 * crow flies and 300 m away on foot, and it must not be chosen before the
 * one on your leg. A target counts as passed once you are within
 * {@link ARRIVE_M} of it along the trail, so you are never pointed back at
 * something you are standing on.
 */

/** A saved waypoint farther than this from the trail is not on it, metres. */
export const WAYPOINT_CORRIDOR_M = 50;
/** A target this close ahead (along the trail) counts as reached, metres. */
export const ARRIVE_M = 10;

export type FollowTargetKind = 'waypoint' | 'note' | 'end';

export interface FollowTarget {
  kind: FollowTargetKind;
  /** Stable id: the waypoint's / note's id, or "end". */
  id: string;
  /** What the compass shows under the distance. */
  name: string;
  /** Where it is. */
  at: LatLng;
  /** Its distance along the trail, metres. */
  alongM: number;
}

export interface FollowTargets {
  /** Waypoints on the trail, by distance along. */
  waypoints: FollowTarget[];
  /** Trail notes, by distance along. */
  notes: FollowTarget[];
  end: FollowTarget;
}

/** The longest name the compass shows; longer note texts are cut with an ellipsis. */
const NAME_MAX = 32;

/** A note's text as a target name: its first line, trimmed and cut. */
export function noteTargetName(text: string): string {
  const first = (text.split('\n')[0] ?? '').trim();
  if (first === '') return 'Trail note';
  return first.length > NAME_MAX ? `${first.slice(0, NAME_MAX - 1).trimEnd()}…` : first;
}

/**
 * Build the targets once when following starts. Waypoints are projected onto
 * the trail (one grid query each) and kept when within
 * {@link WAYPOINT_CORRIDOR_M}; notes sit at their own `distanceM`, which is
 * on the trail's axis by construction. O(w · query + k log k).
 */
export function buildFollowTargets(
  trail: PreparedTrail,
  waypoints: readonly { id: string; label: string; latitude: number; longitude: number }[],
  notes: readonly { id: string; text: string; distanceM: number }[],
): FollowTargets {
  const wps: FollowTarget[] = [];
  for (const w of waypoints) {
    if (!Number.isFinite(w.latitude) || !Number.isFinite(w.longitude)) continue;
    const p = nearestOnTrail(trail, w);
    if (p.distM > WAYPOINT_CORRIDOR_M) continue;
    wps.push({
      kind: 'waypoint',
      id: w.id,
      name: w.label.trim() || 'Waypoint',
      // The waypoint itself is what the flag points at; its projection only
      // orders it along the trail.
      at: { latitude: w.latitude, longitude: w.longitude },
      alongM: p.alongM,
    });
  }
  const ns: FollowTarget[] = [];
  for (const n of notes) {
    if (!Number.isFinite(n.distanceM)) continue;
    const alongM = Math.min(trail.lengthM, Math.max(0, n.distanceM));
    ns.push({
      kind: 'note',
      id: n.id,
      name: noteTargetName(n.text),
      at: pointAtAlong(trail, alongM),
      alongM,
    });
  }
  const byAlong = (a: FollowTarget, b: FollowTarget) => a.alongM - b.alongM || cmp(a.id, b.id);
  wps.sort(byAlong);
  ns.sort(byAlong);
  return {
    waypoints: wps,
    notes: ns,
    end: {
      kind: 'end',
      id: 'end',
      name: 'Trail end',
      at: pointAtAlong(trail, trail.lengthM),
      alongM: trail.lengthM,
    },
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The first target of a sorted list still ahead of `alongM` (binary search). */
function firstAhead(list: readonly FollowTarget[], alongM: number): FollowTarget | null {
  const limit = alongM + ARRIVE_M;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    // `mid` < `hi` <= length: always an element; a hole would read as "ahead".
    if ((list[mid]?.alongM ?? Infinity) > limit) hi = mid;
    else lo = mid + 1;
  }
  return list[lo] ?? null;
}

/**
 * The next target from `alongM` metres along the trail: the next waypoint
 * ahead, else the next note ahead, else the end. O(log k).
 */
export function nextFollowTarget(targets: FollowTargets, alongM: number): FollowTarget {
  return firstAhead(targets.waypoints, alongM) ?? firstAhead(targets.notes, alongM) ?? targets.end;
}
