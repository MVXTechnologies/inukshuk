/**
 * A leading + trailing throttle for camera-settle events.
 *
 * Why: MapLibre reports a camera "settle" (`onRegionDidChange`) after every
 * programmatic camera move, and on Android after every `moveCamera` — so a
 * camera turned by the compass at display rate (heading-up, see
 * `useHeadingCamera`) would "settle" up to 60–120 times a second, and every
 * settle re-renders the whole map screen. While such a stream runs, settles
 * are let through at most once per `intervalMs` (the first at once), and the
 * last one is always delivered when its time comes, so the settled state
 * (scale bar, bounds, north needle) is never left stale. Events outside a
 * stream (a person's gesture, a fly-to) pass straight through and drop any
 * held one: the newer view wins.
 *
 * Pure; the caller owns the timer. O(1) per event.
 */
export type SettleDecision =
  /** Handle this event now. */
  | { kind: 'run' }
  /** Hold it as the trailing event; call `flush` after `inMs`. */
  | { kind: 'defer'; inMs: number };

export interface SettleThrottle {
  /**
   * An event at `nowMs`. `streaming` = it belongs to a programmatic stream
   * that may be thinned (true), or must be handled now (false).
   */
  push(nowMs: number, streaming: boolean): SettleDecision;
  /** Whether the held event should run now (and forget it); false if none or too soon. */
  flush(nowMs: number): boolean;
  /** Whether an event is being held. */
  holding(): boolean;
}

export function createSettleThrottle(intervalMs: number): SettleThrottle {
  if (!(intervalMs > 0)) throw new Error(`intervalMs must be > 0, got ${intervalMs}`);
  let lastRunAt = -Infinity;
  let held = false;
  return {
    push(nowMs, streaming) {
      const elapsed = nowMs - lastRunAt;
      if (!streaming || elapsed >= intervalMs) {
        lastRunAt = nowMs;
        held = false;
        return { kind: 'run' };
      }
      held = true;
      return { kind: 'defer', inMs: intervalMs - elapsed };
    },
    flush(nowMs) {
      if (!held || nowMs - lastRunAt < intervalMs) return false;
      held = false;
      lastRunAt = nowMs;
      return true;
    },
    holding() {
      return held;
    },
  };
}
