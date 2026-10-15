/**
 * Display-rate heading motion: how the filtered heading MOVES on screen
 * between sensor samples.
 *
 * ## Why a filter is not enough
 *
 * `./bearingFilter` decides WHERE the heading is; it runs once per sensor
 * sample. On Android that stream arrives at ~5–10 Hz, irregularly (the native
 * module forwards a reading only once it moved ≥ 2°), and on iOS in 1° steps.
 * Rendering each filtered sample as it lands is a staircase: during a 60°/s
 * turn the cone, the camera and the tape sit still for 100–200 ms and then
 * jump 6–12° — "staccato" (owner, 2.6.0), however good the filter.
 *
 * ## The follower
 *
 * Every consumer instead draws a *follower* of the filtered heading, advanced
 * once per display frame:
 *
 * 1. **Critically damped** (a spring with ζ = 1): the fastest approach to a
 *    new target without overshoot, with continuous velocity — a new sample
 *    bends the motion, it never restarts it. Integrated in closed form, so
 *    the motion is the same whatever the frame rate (60, 90, 120 Hz) and a
 *    dropped frame costs a bigger step, never a different path.
 * 2. **Lead**: a critically damped follower trails a steady turn by `2/ω`.
 *    The goal is therefore placed ahead of the last target by the stream's
 *    own (lightly smoothed) turn rate times that lag, capped, and only while
 *    samples keep coming (`staleMs`): a steady turn is followed with no added
 *    lag, and when the turn stops the lead decays with the rate.
 * 3. **Circular**: targets are unwrapped onto the follower's continuous scale
 *    by the shortest arc, so 359° → 1° turns 2°, never 358°. The output is
 *    continuous (unwrapped) — what an animated rotation needs — and
 *    `normalizeDeg` gives the compass angle.
 * 4. **Settles**: once within `settleDeg` of the goal, slower than
 *    `settleDegPerSec` and with no lead left, it lands exactly on the target
 *    and reports `settled`; a target that does not move the goal (the filter
 *    holding still while Android keeps sending noise) does not wake it. So a
 *    phone at rest costs no frames at all (the animator stops).
 *
 * Per frame: one `exp`, a handful of multiplications; no allocation.
 * Pure (no platform imports); measured in `headingMotion.test.ts`.
 */
import { alphaForCutoff } from './oneEuro';
import { normalizeDeg, unwrapDeg } from './heading';

export interface HeadingFollowerOptions {
  /** Natural frequency of the follower, rad/s. Higher = tighter, less smoothing. */
  omega?: number;
  /** Share of the follower's steady-turn lag (2/ω) the lead compensates, 0…1. */
  lead?: number;
  /** The lead never places the goal further ahead than this, °. */
  maxLeadDeg?: number;
  /** Cutoff of the low-pass on the targets' turn rate (the lead), Hz. */
  rateCutoffHz?: number;
  /** No new target for this long = the turn has stopped: no lead, ms. */
  staleMs?: number;
  /** Within this of the goal… */
  settleDeg?: number;
  /** …and slower than this, the follower lands on the goal and stops. */
  settleDegPerSec?: number;
}

export interface HeadingFollower {
  /**
   * A new filtered heading (any range), read at `nowMs`. The first one (or
   * the first after `reset`) places the follower on it directly.
   */
  setTarget(headingDeg: number, nowMs: number): void;
  /**
   * Advance to `nowMs` and return the display heading on the follower's
   * continuous scale (NaN before any target). Calls must not go back in time
   * (an earlier `nowMs` is treated as no time passing).
   */
  advance(nowMs: number): number;
  /** The display heading on the continuous scale, or null before any target. */
  value(): number | null;
  /** Its angular velocity, °/s (clockwise positive). */
  velocity(): number;
  /** True when at rest on the goal: no frame needs drawing until the next target. */
  isSettled(): boolean;
  /** Forget everything (a new subscription, another north). */
  reset(): void;
}

/**
 * Tuned on the replayed Android stream (`headingMotion.test.ts`): ω = 14 rad/s
 * follows a ~7 Hz staircase with no visible step (it covers ~60 % of a sample's
 * jump in one sample period) while adding ~140 ms of lag that the lead then
 * cancels on a steady turn.
 */
const DEFAULTS = {
  omega: 14,
  lead: 1,
  maxLeadDeg: 25,
  rateCutoffHz: 3,
  staleMs: 300,
  settleDeg: 0.05,
  settleDegPerSec: 0.5,
} as const;

/** A frame gap longer than this is clamped (a backgrounded app resumes calmly), s. */
const MAX_FRAME_S = 0.25;
/** Targets closer than this say nothing about a rate (same instant); longer gaps are clamped, s. */
const MIN_TARGET_DT_S = 0.01;
const MAX_TARGET_DT_S = 1;

/**
 * One exact step of a critically damped follower toward a fixed `goal`:
 * position `x`, velocity `v` (units/s), natural frequency `omega` (rad/s),
 * over `dtS` seconds. Returns the new [x, v].
 */
export function stepCriticallyDamped(
  x: number,
  v: number,
  goal: number,
  omega: number,
  dtS: number,
): [number, number] {
  const e0 = x - goal;
  const k = v + omega * e0;
  const decay = Math.exp(-omega * dtS);
  return [goal + (e0 + k * dtS) * decay, (v - omega * k * dtS) * decay];
}

/** Create a display-rate heading follower (see the module note). */
export function createHeadingFollower(options: HeadingFollowerOptions = {}): HeadingFollower {
  const o = { ...DEFAULTS, ...options };
  if (!(o.omega > 0)) throw new Error(`omega must be > 0, got ${o.omega}`);
  if (!(o.lead >= 0 && o.lead <= 1)) throw new Error(`lead must be in [0, 1], got ${o.lead}`);
  if (!(o.maxLeadDeg >= 0)) throw new Error(`maxLeadDeg must be ≥ 0, got ${o.maxLeadDeg}`);
  if (!(o.rateCutoffHz > 0)) throw new Error(`rateCutoffHz must be > 0, got ${o.rateCutoffHz}`);
  if (!(o.staleMs > 0)) throw new Error(`staleMs must be > 0, got ${o.staleMs}`);

  const leadS = (o.lead * 2) / o.omega;
  /** Display position (continuous) and velocity, °/s. */
  let x: number | null = null;
  let v = 0;
  /** Last target, on the continuous scale, and when it came. */
  let target = 0;
  let targetAt = 0;
  /** The targets' low-passed turn rate, °/s. */
  let rate = 0;
  /** Last advance time. */
  let at = 0;
  let settled = true;

  const goalAt = (nowMs: number): number => {
    if (nowMs - targetAt > o.staleMs) return target;
    const ahead = rate * leadS;
    return target + Math.max(-o.maxLeadDeg, Math.min(o.maxLeadDeg, ahead));
  };

  return {
    setTarget(headingDeg, nowMs) {
      if (!Number.isFinite(headingDeg) || !Number.isFinite(nowMs)) return;
      if (x === null) {
        x = normalizeDeg(headingDeg);
        v = 0;
        target = x;
        targetAt = nowMs;
        at = nowMs;
        rate = 0;
        settled = true;
        return;
      }
      // Unwrap next to the previous target: the short way round, on x's scale.
      const next = unwrapDeg(target, headingDeg);
      const gapMs = nowMs - targetAt;
      if (gapMs > o.staleMs) {
        // After a pause the turn had stopped: the rate starts again from rest,
        // and this one jump says nothing about a speed (no lead from it).
        rate = 0;
      } else if (gapMs >= MIN_TARGET_DT_S * 1000) {
        const dt = Math.min(MAX_TARGET_DT_S, gapMs / 1000);
        rate += alphaForCutoff(o.rateCutoffHz, dt) * ((next - target) / dt - rate);
      }
      target = next;
      targetAt = nowMs;
      // A resting stream (the filter holds still; Android keeps sending noise)
      // must not wake the animator: only a target that moves the goal does.
      if (!settled || Math.abs(goalAt(nowMs) - x) >= o.settleDeg) settled = false;
    },
    advance(nowMs) {
      if (x === null) return NaN;
      const dt = Math.min(MAX_FRAME_S, Math.max(0, (nowMs - at) / 1000));
      at = Math.max(at, nowMs);
      if (settled || dt === 0) return x;
      const goal = goalAt(nowMs);
      [x, v] = stepCriticallyDamped(x, v, goal, o.omega, dt);
      if (
        Math.abs(x - goal) < o.settleDeg &&
        Math.abs(v) < o.settleDegPerSec &&
        Math.abs(goal - target) < o.settleDeg
      ) {
        x = goal;
        v = 0;
        settled = true;
      }
      return x;
    },
    value() {
      return x;
    },
    velocity() {
      return v;
    },
    isSettled() {
      return settled;
    },
    reset() {
      x = null;
      v = 0;
      target = 0;
      targetAt = 0;
      rate = 0;
      at = 0;
      settled = true;
    },
  };
}
