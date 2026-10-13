/**
 * Two-threshold latch: a state that turns on at one value and off at another,
 * so a reading hovering at the threshold doesn't flicker (#672, #678).
 *
 * The latch is "on" while the value is LOW: it switches on once the value is
 * at or below `onAt`, and stays on until the value rises above `offAt`
 * (`offAt` ≥ `onAt`). Both uses in navigation have that shape:
 *
 * - On course: |turn| ≤ 10° → on; off again only past 15°.
 * - On trail: distance to the trail ≤ 20 m → on; off only past 30 m.
 *
 * A non-finite value leaves the state as it was (no reading, no change).
 */
export function latchLow(wasOn: boolean, value: number, onAt: number, offAt: number): boolean {
  if (!Number.isFinite(value)) return wasOn;
  return wasOn ? value <= offAt : value <= onAt;
}

/** "On course": within 10° of the target bearing, out again past 15° (#672). */
export const ON_COURSE_IN_DEG = 10;
export const ON_COURSE_OUT_DEG = 15;

/** Off the trail past 30 m, back on within 20 m (#678; GPS under trees wanders 10–20 m). */
export const ON_TRAIL_IN_M = 20;
export const OFF_TRAIL_OUT_M = 30;
