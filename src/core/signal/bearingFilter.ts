/**
 * The pointing bearing filter (#704): the compass heading the app points
 * with — the compass badge, the direction cone, the pointing line, the
 * navigation compass, the rotate-with-heading camera and the info strip all
 * read this one stream (`useCompass`).
 *
 * ## Why a new output stage
 *
 * 2.5's `createHeadingFilter` held the heading perfectly still at rest and
 * then, once a turn was detected, SNAPPED to the filtered estimate: on a slow
 * turn the hold broke only after ~10° of drift, so the needle and the
 * pointing line (500 m long: a 10° snap moves its far end ~90 m) jumped 10–16°
 * in one sample; at a brisk turn's onset it jumped ~20°. The hold also latched
 * onto the very first (noisy) sample, so it could rest several degrees off.
 *
 * ## The filter
 *
 * 1. **Circular**: every reading is unwrapped onto a continuous scale by the
 *    shortest arc (359° → 361°, never a 358° backflip), so the linear stages
 *    below are valid across north. The output is wrapped back into [0, 360).
 * 2. **Adaptive one-euro** on the unwrapped angle (`./oneEuro`, with the speed
 *    taken on the filtered signal): heavy at rest, nearly transparent while
 *    turning. This is the estimate.
 * 3. **A soft rest gate** on the output, instead of a hold that snaps: each
 *    sample the output moves toward the estimate by a FRACTION `w` of the gap,
 *    where `w` rises smoothly (smoothstep) with the turn rate and with the gap
 *    itself. At rest both are small and `w` is 0: the output does not move, so
 *    the slow wander a one-euro leaves on a σ≈5° sensor never shows. As a turn
 *    builds, `w` eases from 0 to 1: there is no instant at which the output
 *    jumps, and during the turn it sits on the estimate (no added lag).
 * 4. **A glide limit**: the output never moves faster than the estimate's own
 *    (lightly smoothed) turn rate plus `catchUpDegPerSec`. A gap that built
 *    up while the gate was shut (a very slow turn) is closed as a glide at
 *    ~20°/s, never as one snap; a real fast turn is not slowed (its rate is
 *    the allowance). It only caps a step, never forces one, so the output
 *    stops where the turn stops.
 * 5. **Settling**: for the first `settleMs` after (re)start the gate is open,
 *    so the output glides from the first noisy sample to the estimate instead
 *    of resting on it.
 *
 * Per sample: O(1), a handful of multiplications; no allocation.
 *
 * Pure (no platform imports); measured by replaying simulated Android
 * streams in `bearingFilter.test.ts`.
 */
import { normalizeDeg, unwrapDeg } from './heading';
import { alphaForCutoff, createOneEuroFilter } from './oneEuro';

/** One raw heading reading. */
export interface BearingSample {
  /** Heading, degrees (any range). */
  degrees: number;
  /** When it was read, ms. Lets the filter honour the real, irregular rate. */
  timestampMs: number;
  /** Calibration 0 (worst) … 3 (best); null/undefined = unknown, trusted. */
  accuracy?: number | null;
}

export interface BearingFilterOptions {
  /** One-euro cutoff at rest, Hz. */
  minCutoffHz?: number;
  /** One-euro speed coefficient, Hz per °/s. */
  beta?: number;
  /** Cutoff of the low-pass on the speed estimate, Hz. */
  dCutoffHz?: number;
  /** Turn rate (°/s) where the gate starts to open… */
  gateRateLoDegPerSec?: number;
  /** …and where it is fully open. */
  gateRateHiDegPerSec?: number;
  /** Gap to the estimate (°) where the gate starts to open regardless of rate… */
  gateGapLoDeg?: number;
  /** …and where it is fully open (the safety net for a very slow turn). */
  gateGapHiDeg?: number;
  /** After a (re)start the gate stays open this long, ms. */
  settleMs?: number;
  /**
   * The output never moves faster than the estimated turn rate plus this
   * (°/s): a gap that built up behind the shut gate closes as a glide.
   */
  catchUpDegPerSec?: number;
  /** Cutoff of the low-pass on the estimate's turn rate (the glide allowance), Hz. */
  rateCutoffHz?: number;
  /** Cutoff/beta multiplier at calibration 0, ramping to 1 at 3. */
  lowAccuracyScale?: number;
}

export interface BearingFilter {
  /** Feed a reading; returns the filtered bearing in [0, 360) (NaN before any valid one). */
  push(sample: BearingSample): number;
  /** The current bearing in [0, 360), or null before the first sample. */
  value(): number | null;
  /** The estimated turn rate, °/s (clockwise positive). */
  turnRateDegPerSec(): number;
  /** Forget everything (a new sensor subscription, another north). */
  reset(): void;
}

/**
 * Tuned on the simulated Android stream (σ 5°, ≥2° change gate, ~7 Hz); the
 * replay tests pin each margin:
 * - the one-euro stage keeps 2.5's values (τ ≈ 3 s at rest, transparent
 *   past ~60°/s);
 * - resting noise never lifts the speed estimate past ~5°/s nor carries the
 *   estimate more than ~7° from the output, so the gate is shut below those
 *   (4°/s, 5°) and fully open at 10°/s or 12°.
 */
const DEFAULTS = {
  minCutoffHz: 0.05,
  beta: 0.15,
  dCutoffHz: 0.15,
  gateRateLoDegPerSec: 4,
  gateRateHiDegPerSec: 10,
  gateGapLoDeg: 5,
  gateGapHiDeg: 12,
  settleMs: 1500,
  catchUpDegPerSec: 20,
  rateCutoffHz: 0.7,
  lowAccuracyScale: 0.5,
} as const;

/** Sample gaps outside this range are clamped (as in `./oneEuro`), seconds. */
const MIN_DT_S = 0.001;
const MAX_DT_S = 1;

/** 0 below `lo`, 1 above `hi`, a smooth S between (zero slope at both ends). */
export function smoothstep(lo: number, hi: number, x: number): number {
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  const t = (x - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}

/** Create a pointing bearing filter (see the module note). */
export function createBearingFilter(options: BearingFilterOptions = {}): BearingFilter {
  const o = { ...DEFAULTS, ...options };
  if (!(o.gateRateHiDegPerSec > o.gateRateLoDegPerSec && o.gateRateLoDegPerSec >= 0)) {
    throw new Error('gateRateLoDegPerSec must be ≥ 0 and below gateRateHiDegPerSec');
  }
  if (!(o.gateGapHiDeg > o.gateGapLoDeg && o.gateGapLoDeg >= 0)) {
    throw new Error('gateGapLoDeg must be ≥ 0 and below gateGapHiDeg');
  }
  if (!(o.lowAccuracyScale > 0 && o.lowAccuracyScale <= 1)) {
    throw new Error(`lowAccuracyScale must be in (0, 1], got ${o.lowAccuracyScale}`);
  }
  if (!(o.settleMs >= 0)) throw new Error(`settleMs must be ≥ 0, got ${o.settleMs}`);

  const euro = createOneEuroFilter({
    minCutoffHz: o.minCutoffHz,
    beta: o.beta,
    dCutoffHz: o.dCutoffHz,
  });
  /** The raw input, unwrapped. */
  let raw: number | null = null;
  /** The output, unwrapped (continuous). */
  let out: number | null = null;
  let startedAt = 0;
  let lastAt = 0;
  let lastEstimate = 0;
  /** The estimate's own turn rate, low-passed at `rateCutoffHz`, °/s. */
  let rate = 0;

  const trust = (accuracy: number | null | undefined): number => {
    if (accuracy === null || accuracy === undefined || !Number.isFinite(accuracy)) return 1;
    const level = Math.min(3, Math.max(0, accuracy)) / 3;
    return o.lowAccuracyScale + (1 - o.lowAccuracyScale) * level;
  };

  return {
    push({ degrees, timestampMs, accuracy }) {
      // A non-finite reading is ignored (the sensor's "no heading").
      if (!Number.isFinite(degrees) || !Number.isFinite(timestampMs)) {
        return out === null ? NaN : normalizeDeg(out);
      }
      const deg = normalizeDeg(degrees);
      raw = raw === null ? deg : unwrapDeg(raw, deg);
      const estimate = euro.push(raw, timestampMs, trust(accuracy));
      if (out === null) {
        out = estimate;
        startedAt = timestampMs;
        lastAt = timestampMs;
        lastEstimate = estimate;
        rate = 0;
        return normalizeDeg(out);
      }
      const gap = estimate - out;
      const w =
        timestampMs - startedAt < o.settleMs
          ? 1
          : Math.max(
              smoothstep(o.gateRateLoDegPerSec, o.gateRateHiDegPerSec, Math.abs(euro.speed())),
              smoothstep(o.gateGapLoDeg, o.gateGapHiDeg, Math.abs(gap)),
            );
      // Never further than the estimate itself moved, plus a gentle catch-up:
      // a gap that built up behind the shut gate closes as a glide, not a snap.
      // The limit only caps a step, never forces one: a floor of
      // (rate − catchUp)·dt would carry the output past a turn that stopped.
      const dt = Math.min(MAX_DT_S, Math.max(MIN_DT_S, (timestampMs - lastAt) / 1000));
      rate += alphaForCutoff(o.rateCutoffHz, dt) * ((estimate - lastEstimate) / dt - rate);
      const lo = Math.min(0, (rate - o.catchUpDegPerSec) * dt);
      const hi = Math.max(0, (rate + o.catchUpDegPerSec) * dt);
      lastAt = timestampMs;
      lastEstimate = estimate;
      out += Math.max(lo, Math.min(hi, w * gap));
      return normalizeDeg(out);
    },
    value() {
      return out === null ? null : normalizeDeg(out);
    },
    turnRateDegPerSec() {
      return euro.speed();
    },
    reset() {
      euro.reset();
      raw = null;
      out = null;
      startedAt = 0;
      lastAt = 0;
      rate = 0;
    },
  };
}
