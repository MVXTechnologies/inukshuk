/**
 * Compass-angle arithmetic: wrapping, the shortest signed arc, unwrapping.
 * The heading FILTER is `./bearingFilter` (#704).
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
 * degrees while the phone lies still; one that holds still and then catches
 * up in one step snaps. `./bearingFilter` does neither.
 */

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
