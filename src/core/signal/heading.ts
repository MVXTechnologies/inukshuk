/**
 * Compass-heading smoothing. The raw heading stream jitters rapidly; we smooth
 * it with a circular exponential moving average. Averaging is done on the
 * heading's unit vector (cos/sin) rather than the angle directly, so the 0°/360°
 * wraparound is handled correctly (e.g. 359° and 1° smooth toward 0°, not 180°).
 *
 * Two smoothers live here:
 * - `createHeadingSmoother` — fixed-alpha EMA (kept as the simple primitive).
 * - `createAdaptiveHeadingSmoother` — the one the app uses: alpha scales with
 *   how far the new sample deviates from the current estimate (snappy while
 *   you turn, steady while you stand still), is corrected for irregular sample
 *   intervals, and is damped when the sensor reports poor calibration.
 *
 * Pure (no platform deps) so the smoothing is unit-tested independently of the
 * sensor; `useCompass` just feeds it raw readings.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Wrap any angle into [0, 360). */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Circular mean of headings in degrees. Returns 0 for empty / fully-opposed input. */
export function circularMeanDeg(degrees: readonly number[]): number {
  let x = 0;
  let y = 0;
  for (const d of degrees) {
    const r = d * DEG2RAD;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  // Near-zero resultant (empty, or antipodal samples that cancel) has no defined
  // direction — return 0 rather than a noisy atan2 of floating-point dust.
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return 0;
  return normalizeDeg(Math.atan2(y, x) * RAD2DEG);
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
 * which is what animated rotations need to avoid a 350° spin-the-wrong-way at
 * the 0/360 boundary.
 */
export function unwrapDeg(prevContinuousDeg: number, headingDeg: number): number {
  return prevContinuousDeg + signedDeltaDeg(prevContinuousDeg, headingDeg);
}

export interface HeadingSmoother {
  /** Feed a raw heading (deg); returns the updated smoothed heading [0,360). */
  push(deg: number): number;
  /** Current smoothed heading, or null before the first sample. */
  value(): number | null;
  /** Forget all history (e.g. when the sensor subscription restarts). */
  reset(): void;
}

/**
 * Circular exponential moving average over the heading unit vector.
 * `alpha` in (0, 1]: lower = smoother but laggier. 0.2 tames sensor jitter while
 * staying responsive within ~1s at typical update rates.
 */
export function createHeadingSmoother(alpha = 0.2): HeadingSmoother {
  if (!(alpha > 0 && alpha <= 1)) {
    throw new Error(`alpha must be in (0, 1], got ${alpha}`);
  }
  let x: number | null = null;
  let y = 0;

  const current = (): number | null =>
    x === null ? null : normalizeDeg(Math.atan2(y, x) * RAD2DEG);

  return {
    push(deg) {
      const r = normalizeDeg(deg) * DEG2RAD;
      const cx = Math.cos(r);
      const cy = Math.sin(r);
      if (x === null) {
        x = cx;
        y = cy;
      } else {
        x += alpha * (cx - x);
        y += alpha * (cy - y);
      }
      return normalizeDeg(Math.atan2(y, x) * RAD2DEG);
    },
    value: current,
    reset() {
      x = null;
      y = 0;
    },
  };
}

/** One raw heading reading fed to the adaptive smoother. */
export interface HeadingSample {
  /** Heading in degrees (any range; normalized internally). */
  degrees: number;
  /** Wall-clock time of the reading (ms). Enables sample-rate correction. */
  timestampMs?: number;
  /**
   * Sensor calibration level as reported by expo-location: 0 (uncalibrated)
   * … 3 (high accuracy). `null`/`undefined` = unknown (treated as trusted).
   */
  accuracy?: number | null;
}

export interface AdaptiveHeadingSmootherOptions {
  /** Alpha when the sample agrees with the estimate (standing still). */
  minAlpha?: number;
  /** Alpha when the sample deviates by `deltaForMaxAlphaDeg` or more (turning). */
  maxAlpha?: number;
  /** Deviation (deg) at which alpha reaches `maxAlpha`. */
  deltaForMaxAlphaDeg?: number;
  /** Sample interval (ms) the alphas are tuned for; other rates are corrected. */
  refIntervalMs?: number;
  /** Alpha multiplier at calibration level 0 (ramps linearly to 1 at level 3). */
  lowAccuracyAlphaScale?: number;
}

export interface AdaptiveHeadingSmoother {
  /** Feed a reading; returns the updated smoothed heading [0, 360). */
  push(sample: HeadingSample): number;
  /** Current smoothed heading, or null before the first sample. */
  value(): number | null;
  /** Forget all history (e.g. when the sensor subscription restarts). */
  reset(): void;
}

/**
 * Circular EMA with adaptive alpha:
 *
 * - **Deviation-adaptive**: alpha grows linearly from `minAlpha` (sample close
 *   to the estimate → jitter, smooth hard) to `maxAlpha` (sample far away →
 *   a real turn, follow quickly). This is what makes the needle both steady
 *   when still and snappy when turning.
 * - **Rate-corrected**: with timestamps, alpha is converted to an equivalent
 *   per-sample weight for the actual interval (`1 - (1-a)^(dt/ref)`), so the
 *   smoothing time-constant is the same whether the sensor fires at 5 or 50 Hz.
 * - **Accuracy-gated**: readings the OS flags as poorly calibrated pull the
 *   estimate less (alpha scaled down toward `lowAccuracyAlphaScale`).
 *
 * Smoothing runs on the heading unit vector, so the 0/360 wraparound is
 * handled correctly; the vector is renormalized each step for numeric health.
 */
export function createAdaptiveHeadingSmoother(
  options: AdaptiveHeadingSmootherOptions = {},
): AdaptiveHeadingSmoother {
  const {
    minAlpha = 0.06,
    maxAlpha = 0.5,
    deltaForMaxAlphaDeg = 30,
    refIntervalMs = 100,
    lowAccuracyAlphaScale = 0.3,
  } = options;
  if (!(minAlpha > 0 && minAlpha <= 1)) {
    throw new Error(`minAlpha must be in (0, 1], got ${minAlpha}`);
  }
  if (!(maxAlpha >= minAlpha && maxAlpha <= 1)) {
    throw new Error(`maxAlpha must be in [minAlpha, 1], got ${maxAlpha}`);
  }
  if (!(deltaForMaxAlphaDeg > 0)) {
    throw new Error(`deltaForMaxAlphaDeg must be > 0, got ${deltaForMaxAlphaDeg}`);
  }
  if (!(refIntervalMs > 0)) {
    throw new Error(`refIntervalMs must be > 0, got ${refIntervalMs}`);
  }
  if (!(lowAccuracyAlphaScale >= 0 && lowAccuracyAlphaScale <= 1)) {
    throw new Error(`lowAccuracyAlphaScale must be in [0, 1], got ${lowAccuracyAlphaScale}`);
  }

  let x: number | null = null;
  let y = 0;
  let lastTs: number | null = null;

  return {
    push(sample) {
      const deg = normalizeDeg(sample.degrees);
      const r = deg * DEG2RAD;
      const cx = Math.cos(r);
      const cy = Math.sin(r);
      const ts = sample.timestampMs ?? null;

      if (x === null) {
        x = cx;
        y = cy;
        lastTs = ts;
        return deg;
      }

      const current = normalizeDeg(Math.atan2(y, x) * RAD2DEG);
      const deviation = Math.abs(signedDeltaDeg(current, deg));
      let alpha = minAlpha + (maxAlpha - minAlpha) * Math.min(1, deviation / deltaForMaxAlphaDeg);

      const acc = sample.accuracy;
      if (acc !== null && acc !== undefined && Number.isFinite(acc)) {
        const trust = Math.min(1, Math.max(0, acc / 3));
        alpha *= lowAccuracyAlphaScale + (1 - lowAccuracyAlphaScale) * trust;
      }

      if (ts !== null && lastTs !== null && ts > lastTs) {
        // Equivalent weight for the actual interval, clamped so a long sensor
        // gap can't overshoot and a burst of readings can't zero out alpha.
        const frames = Math.min(10, Math.max(0.1, (ts - lastTs) / refIntervalMs));
        alpha = 1 - Math.pow(1 - alpha, frames);
      }
      if (ts !== null) lastTs = ts;

      let nx = x + alpha * (cx - x);
      let ny = y + alpha * (cy - y);
      const mag = Math.hypot(nx, ny);
      if (mag < 1e-9) {
        // Degenerate (near-antipodal flip collapsed the vector): adopt the sample.
        nx = cx;
        ny = cy;
      } else {
        nx /= mag;
        ny /= mag;
      }
      x = nx;
      y = ny;
      return normalizeDeg(Math.atan2(ny, nx) * RAD2DEG);
    },
    value() {
      return x === null ? null : normalizeDeg(Math.atan2(y, x) * RAD2DEG);
    },
    reset() {
      x = null;
      y = 0;
      lastTs = null;
    },
  };
}
