/**
 * Compass-heading filtering.
 *
 * ## What the sensor actually gives us
 *
 * On Android, `expo-location`'s heading watch is *not* the gyro-fused rotation
 * vector: it derives the azimuth from the raw accelerometer + magnetometer
 * (`SensorManager.getRotationMatrix` / `getOrientation`) at `SENSOR_DELAY_NORMAL`.
 * That signal carries several degrees of noise even on a table. Worse, the
 * native module only forwards a reading when it differs from the **last one it
 * sent** by more than ~2° (and ≥50 ms have passed) — so at rest we are handed a
 * stream made *exclusively* of ≥2° noise excursions, arriving irregularly at up
 * to ~10 Hz. There is no such thing as a "quiet" sample to average against.
 *
 * Any filter whose responsiveness grows with the *deviation of the incoming
 * sample* therefore speeds up for noise, and the needle wanders by several
 * degrees while the phone lies still. (That was the previous
 * `createAdaptiveHeadingSmoother`, and it is why the compass still jittered.)
 *
 * ## What we do instead
 *
 * `createHeadingFilter` = **1-Euro filter** (see `./oneEuro`) + a **rest
 * deadband**:
 *
 * 1. The heading is *unwrapped* onto a continuous scale (359° → 361°, never a
 *    358° backflip), so ordinary linear filtering is valid across 0/360.
 * 2. The 1-Euro filter adapts on the *speed of the filtered signal*, not on the
 *    deviation of the sample: still phone → cutoff `minCutoffHz` → heavy
 *    smoothing; real turn → cutoff opens → follows within a few degrees.
 * 3. A circular **backlash (play) deadband** sits on the output: the reported
 *    heading does not move at all until the filtered heading has left a
 *    `deadbandDeg` window around it, and thereafter tracks it 1:1 (offset by
 *    the deadband). Unlike a plain threshold this never produces stair-steps —
 *    it is exactly zero motion at rest and continuous motion when turning.
 *
 * Net effect: **< 1° peak-to-peak while the phone is still**, and a turn is
 * tracked with a lag of a few degrees. Both are covered by the tests here.
 *
 * Pure (no platform deps) so the filtering is unit-tested independently of the
 * sensor; `useCompass` just feeds it raw readings.
 */

import { createOneEuroFilter } from './oneEuro';

/** Wrap any angle into [0, 360). */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Shortest signed arc from `fromDeg` to `toDeg`, in (-180, 180]. Positive means
 * clockwise. Antipodal inputs (exactly 180° apart) return +180.
 */
export function signedDeltaDeg(fromDeg: number, toDeg: number): number {
  const d = normalizeDeg(toDeg - fromDeg);
  return d > 180 ? d - 360 : d;
}

/**
 * Unwrap `headingDeg` (any angle, typically [0,360)) onto the continuous scale
 * of `prevContinuousDeg` by taking the shortest arc. Feeding successive
 * headings through this yields a continuous angle (e.g. 350 → 370, not → 10),
 * which is what animated rotations — and any linear filter — need in order to
 * cross the 0/360 boundary the short way.
 */
export function unwrapDeg(prevContinuousDeg: number, headingDeg: number): number {
  return prevContinuousDeg + signedDeltaDeg(prevContinuousDeg, headingDeg);
}

/** One raw heading reading fed to the filter. */
export interface HeadingSample {
  /** Heading in degrees (any range; normalized internally). */
  degrees: number;
  /** Wall-clock time of the reading (ms). Lets the filter honour the real rate. */
  timestampMs?: number;
  /**
   * Sensor calibration level as reported by expo-location: 0 (uncalibrated)
   * … 3 (high accuracy). `null`/`undefined` = unknown (treated as trusted).
   */
  accuracy?: number | null;
}

export interface HeadingFilterOptions {
  /** 1-Euro cutoff (Hz) at rest. Lower = steadier when still. */
  minCutoffHz?: number;
  /** 1-Euro speed coefficient (Hz per °/s). Higher = less lag while turning. */
  beta?: number;
  /**
   * Cutoff (Hz) of the low-pass on the speed estimate. Keep it low: the speed
   * of a noisy signal is zero-mean noise plus, when you really turn, a DC term.
   * A heavy low-pass keeps the DC and averages the noise away, so noise cannot
   * bootstrap itself into a phantom turn that opens the main cutoff.
   */
  dCutoffHz?: number;
  /**
   * Turn rate (°/s) that promotes the filter from "still" to "turning". Must sit
   * above the phantom rate that sensor noise alone produces (a few °/s).
   */
  enterTurnRateDegPerSec?: number;
  /** Turn rate (°/s) below which "turning" relaxes back to "still" (hysteresis). */
  exitTurnRateDegPerSec?: number;
  /**
   * How far (°) the filtered heading may drift from the held one before the hold
   * breaks even without a detected turn. This is the safety net for a rotation
   * so slow that it never trips `enterTurnRateDegPerSec`.
   */
  holdBreakoutDeg?: number;
  /** Backlash half-width (°) applied while turning. Keep small — it is pure lag. */
  turningDeadbandDeg?: number;
  /**
   * Cutoff/beta multiplier at calibration level 0, ramping linearly to 1 at
   * level 3: a badly calibrated compass is filtered harder.
   */
  lowAccuracyScale?: number;
  /** Interval assumed for a sample with no timestamp (ms). */
  defaultIntervalMs?: number;
}

export interface HeadingFilter {
  /** Feed a reading; returns the filtered heading in [0, 360). */
  push(sample: HeadingSample): number;
  /** Current filtered heading in [0, 360), or null before the first sample. */
  value(): number | null;
  /** Current turn rate estimate (°/s, signed clockwise). */
  turnRateDegPerSec(): number;
  /** Forget all history (e.g. when the sensor subscription restarts). */
  reset(): void;
}

/**
 * Defaults tuned against the simulated real Android stream (see the module
 * header and the tests): ~7 Hz, ≥2°-quantised, σ ≈ 5° of noise at rest.
 *
 * - `minCutoffHz: 0.05` → τ ≈ 3 s at rest. The empirical sweet spot: heavier
 *   than this and the estimate starts to *wander* (a very long time constant
 *   just turns white noise into slow drift) rather than settle.
 * - `beta: 0.15` → a 60°/s turn lifts the cutoff to ~9 Hz — effectively
 *   unfiltered — so a real rotation is followed within a few degrees.
 * - `dCutoffHz: 0.15` → the speed estimate is itself heavily low-passed, which
 *   is what stops resting noise from being mistaken for motion.
 * - The still/turning **hold** is the deciding trick, and it is not optional.
 *   Even at its best a low-pass of a σ≈5° sensor leaves a slow ±3° wander
 *   (averaging *that* away would need a ~1-minute time constant — the noise is
 *   simply that large), and a plain deadband does not help, because a backlash
 *   tracks slow drift 1:1 once it exceeds the band. So while the compass is not
 *   turning we do not move the reported heading **at all**. Rest jitter is then
 *   exactly 0°, by construction.
 * - The hold's two exits are sized off measurements of that resting signal
 *   (see the tests): noise alone never pushes the estimated turn rate past
 *   ~4°/s (hence `enterTurnRateDegPerSec: 8`) nor the filtered heading more
 *   than ~6° from where it was held (hence `holdBreakoutDeg: 10`). Both leave
 *   roughly a 2× margin, so noise cannot break the hold, while any real
 *   rotation trips the rate gate almost immediately.
 */
const DEFAULTS = {
  minCutoffHz: 0.05,
  beta: 0.15,
  dCutoffHz: 0.15,
  enterTurnRateDegPerSec: 8,
  exitTurnRateDegPerSec: 4,
  holdBreakoutDeg: 10,
  turningDeadbandDeg: 0.5,
  lowAccuracyScale: 0.5,
  defaultIntervalMs: 100,
} as const;

/**
 * Heading filter: 1-Euro on the unwrapped angle + a backlash deadband.
 * Steady when the phone is still, prompt when it turns, correct across 0/360.
 */
export function createHeadingFilter(options: HeadingFilterOptions = {}): HeadingFilter {
  const {
    minCutoffHz = DEFAULTS.minCutoffHz,
    beta = DEFAULTS.beta,
    dCutoffHz = DEFAULTS.dCutoffHz,
    enterTurnRateDegPerSec = DEFAULTS.enterTurnRateDegPerSec,
    exitTurnRateDegPerSec = DEFAULTS.exitTurnRateDegPerSec,
    holdBreakoutDeg = DEFAULTS.holdBreakoutDeg,
    turningDeadbandDeg = DEFAULTS.turningDeadbandDeg,
    lowAccuracyScale = DEFAULTS.lowAccuracyScale,
    defaultIntervalMs = DEFAULTS.defaultIntervalMs,
  } = options;
  if (!(enterTurnRateDegPerSec > 0)) {
    throw new Error(`enterTurnRateDegPerSec must be > 0, got ${enterTurnRateDegPerSec}`);
  }
  if (!(exitTurnRateDegPerSec >= 0 && exitTurnRateDegPerSec <= enterTurnRateDegPerSec)) {
    throw new Error(
      `exitTurnRateDegPerSec must be in [0, enterTurnRateDegPerSec], got ${exitTurnRateDegPerSec}`,
    );
  }
  if (!(holdBreakoutDeg > 0)) {
    throw new Error(`holdBreakoutDeg must be > 0, got ${holdBreakoutDeg}`);
  }
  if (!(turningDeadbandDeg >= 0 && turningDeadbandDeg < holdBreakoutDeg)) {
    throw new Error(
      `turningDeadbandDeg must be in [0, holdBreakoutDeg), got ${turningDeadbandDeg}`,
    );
  }
  if (!(lowAccuracyScale > 0 && lowAccuracyScale <= 1)) {
    throw new Error(`lowAccuracyScale must be in (0, 1], got ${lowAccuracyScale}`);
  }

  const euro = createOneEuroFilter({ minCutoffHz, beta, dCutoffHz, defaultIntervalMs });

  /** Continuous (unwrapped) scale of the raw input. */
  let rawContinuous: number | null = null;
  /** Continuous reported heading — what the UI shows. */
  let reported: number | null = null;
  /** Are we tracking a real turn, or holding still? */
  let turning = false;

  /** Calibration level → cutoff multiplier: worse calibration, heavier filter. */
  const trustFor = (accuracy: number | null | undefined): number => {
    if (accuracy === null || accuracy === undefined || !Number.isFinite(accuracy)) return 1;
    const level = Math.min(3, Math.max(0, accuracy)) / 3;
    return lowAccuracyScale + (1 - lowAccuracyScale) * level;
  };

  return {
    push(sample) {
      const deg = normalizeDeg(sample.degrees);
      rawContinuous = rawContinuous === null ? deg : unwrapDeg(rawContinuous, deg);
      const filtered = euro.push(rawContinuous, sample.timestampMs, trustFor(sample.accuracy));

      if (reported === null) {
        reported = filtered;
        return normalizeDeg(reported);
      }

      const rate = Math.abs(euro.speed());
      const drift = filtered - reported;

      // The 1-Euro stage keeps tracking even while the output is held, so both
      // triggers below stay live — the hold can always break. (Gating the
      // filter's *cutoff* on the rate instead would deadlock: it would have to
      // move in order to be allowed to move.)
      if (turning) {
        if (rate < exitTurnRateDegPerSec && Math.abs(drift) <= turningDeadbandDeg) turning = false;
      } else if (rate > enterTurnRateDegPerSec || Math.abs(drift) > holdBreakoutDeg) {
        turning = true;
      }

      if (!turning) return normalizeDeg(reported); // held: exactly 0° of jitter

      // Turning: backlash / play operator — dead inside a small band, 1:1
      // outside it, so it lags by at most `turningDeadbandDeg` and never
      // stair-steps.
      if (drift > turningDeadbandDeg) reported = filtered - turningDeadbandDeg;
      else if (drift < -turningDeadbandDeg) reported = filtered + turningDeadbandDeg;
      return normalizeDeg(reported);
    },
    value() {
      return reported === null ? null : normalizeDeg(reported);
    },
    turnRateDegPerSec() {
      return euro.speed();
    },
    reset() {
      euro.reset();
      rawContinuous = null;
      reported = null;
      turning = false;
    },
  };
}
