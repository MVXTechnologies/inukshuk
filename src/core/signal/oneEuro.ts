/**
 * The **1-Euro filter** (Casiez, Roussel & Vogel, CHI 2012) — a low-pass filter
 * whose cutoff frequency adapts to how fast the signal is actually moving.
 *
 * It exists to solve exactly the jitter-vs-lag trade-off a plain EMA cannot:
 *
 * - **Still / slow** → the cutoff sits at `minCutoffHz`, the filter is heavy and
 *   sensor noise is crushed. The output is *steady*.
 * - **Moving** → the estimated speed opens the cutoff (`+ beta · |ẋ|`), the
 *   filter turns light and follows with little lag. The output is *responsive*.
 *
 * The knob that matters is therefore the *speed of the signal*, not the
 * *deviation of the latest sample*. A filter that opens up whenever a sample
 * lands far from the estimate cannot tell a noise spike from a real move — it
 * chases noise, which is precisely what makes a compass jitter at rest.
 *
 * ## Deviation from the paper: the speed is measured on the *filtered* signal
 *
 * The paper differentiates the raw input: `ẋ = (xₙ − xₙ₋₁) / dt`. With a noisy
 * sensor that estimate is dominated by noise — a ±3° wobble arriving at 10 Hz
 * reads as ~30–60°/s of phantom speed — which opens the cutoff and re-admits
 * the very jitter we are filtering. Differentiating the *filtered* value
 * instead keeps the speed estimate honest: it only reports motion the filter
 * has actually accepted. The cost is a slightly slower reaction at the onset of
 * a turn (the estimate has to bootstrap), which `beta` compensates for within a
 * few samples.
 *
 * Pure: no platform deps, unit-tested independently of any sensor.
 */

/** Weight of a first-order low-pass with cutoff `cutoffHz` at a step of `dtSeconds`. */
export function alphaForCutoff(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

export interface OneEuroOptions {
  /**
   * Cutoff (Hz) while the signal is at rest. Lower = steadier when still,
   * laggier at low speeds. This is the knob that decides how still "still" looks.
   */
  minCutoffHz?: number;
  /**
   * How aggressively speed opens the cutoff (Hz per unit-of-x per second).
   * Higher = less lag while moving.
   */
  beta?: number;
  /** Cutoff (Hz) of the low-pass applied to the speed estimate itself. */
  dCutoffHz?: number;
  /** Interval assumed when a sample arrives without a usable timestamp (ms). */
  defaultIntervalMs?: number;
}

export interface OneEuroFilter {
  /**
   * Feed a sample; returns the filtered value.
   *
   * `cutoffScale` (default 1) multiplies both `minCutoffHz` and `beta` for this
   * one sample — a per-sample "trust" dial. Below 1 the filter is heavier (used
   * for readings the sensor flags as poorly calibrated).
   */
  push(value: number, timestampMs?: number, cutoffScale?: number): number;
  /** Current filtered value, or null before the first sample. */
  value(): number | null;
  /** Current (low-passed) speed estimate, in units per second. */
  speed(): number;
  /** Forget all history. */
  reset(): void;
}

/** Sensor gaps outside this range are clamped rather than trusted. */
const MIN_DT_S = 0.001;
const MAX_DT_S = 1;

/**
 * Create a 1-Euro filter over a plain (non-circular) scalar. For headings use
 * `createHeadingFilter` in `./heading`, which wraps this with angle unwrapping
 * and a rest deadband.
 */
export function createOneEuroFilter(options: OneEuroOptions = {}): OneEuroFilter {
  const { minCutoffHz = 0.5, beta = 0.02, dCutoffHz = 1, defaultIntervalMs = 100 } = options;
  if (!(minCutoffHz > 0)) throw new Error(`minCutoffHz must be > 0, got ${minCutoffHz}`);
  if (!(beta >= 0)) throw new Error(`beta must be >= 0, got ${beta}`);
  if (!(dCutoffHz > 0)) throw new Error(`dCutoffHz must be > 0, got ${dCutoffHz}`);
  if (!(defaultIntervalMs > 0)) {
    throw new Error(`defaultIntervalMs must be > 0, got ${defaultIntervalMs}`);
  }

  let filtered: number | null = null;
  let prevFiltered: number | null = null;
  let speedEstimate = 0;
  let lastTs: number | null = null;

  return {
    push(value, timestampMs, cutoffScale = 1) {
      if (!Number.isFinite(value)) throw new Error(`value must be finite, got ${value}`);
      if (!(cutoffScale > 0)) throw new Error(`cutoffScale must be > 0, got ${cutoffScale}`);

      if (filtered === null) {
        filtered = value;
        prevFiltered = null;
        speedEstimate = 0;
        lastTs = timestampMs ?? null;
        return value;
      }

      let dt = defaultIntervalMs / 1000;
      if (timestampMs !== undefined && lastTs !== null && timestampMs > lastTs) {
        dt = (timestampMs - lastTs) / 1000;
      }
      dt = Math.min(MAX_DT_S, Math.max(MIN_DT_S, dt));
      if (timestampMs !== undefined) lastTs = timestampMs;

      // Speed of the *filtered* signal over the last step (0 on the 2nd sample,
      // where there is no previous filtered value yet), then low-passed.
      const rawSpeed = prevFiltered === null ? 0 : (filtered - prevFiltered) / dt;
      speedEstimate += alphaForCutoff(dCutoffHz, dt) * (rawSpeed - speedEstimate);

      const cutoff = (minCutoffHz + beta * Math.abs(speedEstimate)) * cutoffScale;
      prevFiltered = filtered;
      filtered += alphaForCutoff(cutoff, dt) * (value - filtered);
      return filtered;
    },
    value() {
      return filtered;
    },
    speed() {
      return speedEstimate;
    },
    reset() {
      filtered = null;
      prevFiltered = null;
      speedEstimate = 0;
      lastTs = null;
    },
  };
}
