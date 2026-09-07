import { signedDeltaDeg } from '@core/signal/heading';

/**
 * Map-bearing thresholds for the compass badge's north needle and the
 * snap-back detent (#248).
 *
 * Two separate questions, two separate thresholds:
 *
 * 1. **Is the map north-up?** ({@link isNorthUp}, {@link NORTH_UP_EPSILON_DEG})
 *    — decides whether the red north needle is drawn at all. A fraction of a
 *    degree of residue left by a camera animation is not a rotation a user can
 *    see, and a needle that flickers on at 0.2° would be worse than none.
 * 2. **Is this rotation accidental?** ({@link shouldSnapToNorth},
 *    {@link NORTH_SNAP_DEG}) — decides whether the camera springs back to
 *    north when the gesture settles.
 *
 * Pure so both live under the coverage gate: the screen only supplies the
 * settled bearing and obeys the answers.
 */

/**
 * Below this the map counts as north-up: no red needle, and nothing to snap.
 *
 * Also what makes the detent safe against re-entrancy — the snap animation
 * itself ends in a settle, and that settle lands inside this window, so it can
 * never ask for another snap.
 */
export const NORTH_UP_EPSILON_DEG = 1;

/**
 * Snap-back detent half-width, in degrees.
 *
 * MapLibre's two-finger pinch starts rotating after a very small twist, so a
 * plain zoom leaves the map a few degrees off north. 8° is wide enough to
 * swallow that drift and narrow enough that a deliberate twist — which lands
 * tens of degrees away — is always kept.
 */
export const NORTH_SNAP_DEG = 8;

/**
 * Bearing wrapped to the signed range (-180, 180], i.e. how far the map is
 * rotated and in which direction. 350° reads as -10°, not "nearly a full turn".
 * Exactly-antipodal (180°) reads as +180.
 */
export function normalizeBearingDeg(bearingDeg: number): number {
  return signedDeltaDeg(0, bearingDeg);
}

/**
 * True when the map is close enough to north-up that no rotation is visible
 * (|bearing| ≤ {@link NORTH_UP_EPSILON_DEG}).
 */
export function isNorthUp(bearingDeg: number, epsilonDeg = NORTH_UP_EPSILON_DEG): boolean {
  return Math.abs(normalizeBearingDeg(bearingDeg)) <= epsilonDeg;
}

/**
 * Should a settled camera at `bearingDeg` spring back to north?
 *
 * True for a rotation that is **visible but small** — outside the north-up
 * window and no further than `thresholdDeg` from north, in either direction.
 * Boundaries, deliberately:
 *
 * - `|bearing| ≤ thresholdDeg` snaps (8.0° exactly snaps; 8.1° is kept). The
 *   detent owns its own edge — a bearing sitting exactly on the threshold is
 *   still far more likely to be pinch drift than an intended 8° rotation.
 * - `|bearing| ≤ NORTH_UP_EPSILON_DEG` does **not** snap: there is nothing to
 *   correct, and returning false here is what stops the snap's own settle from
 *   triggering another snap.
 * - Anything beyond the threshold (45°, 180°, -90°) is a deliberate rotation
 *   and is kept.
 */
export function shouldSnapToNorth(bearingDeg: number, thresholdDeg = NORTH_SNAP_DEG): boolean {
  const off = Math.abs(normalizeBearingDeg(bearingDeg));
  return off > NORTH_UP_EPSILON_DEG && off <= thresholdDeg;
}
