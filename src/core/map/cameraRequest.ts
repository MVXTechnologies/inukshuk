/**
 * When a one-shot camera request from another screen ("On map" from a trail,
 * #710; "View on map" from the Library) may run. Pure.
 *
 * A fit issued while the map screen is hidden, before the map has loaded, or
 * while the camera still follows the GPS dot is lost: the hidden camera does
 * nothing, and native follow mode snaps straight back to my position. So the
 * request waits for the map, then turns follow mode off (a rendered change),
 * and only then fits — the same order as the team's "show on the map".
 */
export type CameraRequestStep = 'idle' | 'wait' | 'stopFollowing' | 'run';

export function cameraRequestStep(i: {
  /** A request is pending. */
  pending: boolean;
  /** The map screen is focused and its map has loaded. */
  ready: boolean;
  /** The camera follows my position (native tracking). */
  following: boolean;
}): CameraRequestStep {
  if (!i.pending) return 'idle';
  if (!i.ready) return 'wait';
  return i.following ? 'stopFollowing' : 'run';
}
