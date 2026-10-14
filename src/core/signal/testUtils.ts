/**
 * Test-only: a replay of the real Android heading stream (see `useCompass`):
 * azimuth from accelerometer + magnetometer (σ ≈ 5° even on a table),
 * evaluated every 100 ms, and forwarded only when it moved > 2° from the last
 * value sent and ≥ 50 ms passed — so at rest the app receives nothing but
 * noise excursions, at irregular intervals. Shared by the filter and the
 * display-motion tests; never shipped.
 */
import type { BearingSample } from './bearingFilter';
import { normalizeDeg, signedDeltaDeg } from './heading';

/** Deterministic gaussian noise (Box–Muller over a seeded LCG). */
export function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) / 16777216 || 1e-9;
  };
  return () => Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next());
}

/** What `watchHeadingAsync` hands the app for a true heading `truth(t)`. */
export function androidStream(
  truth: (tMs: number) => number,
  durationMs: number,
  seed: number,
  noiseDeg = 5,
): BearingSample[] {
  const noise = gaussian(seed);
  const out: BearingSample[] = [];
  let lastSent: number | null = null;
  let lastAt = -Infinity;
  for (let t = 0; t <= durationMs; t += 100) {
    const raw = normalizeDeg(truth(t) + noise() * noiseDeg);
    const moved = lastSent === null || Math.abs(signedDeltaDeg(lastSent, raw)) > 2.03;
    if (moved && t - lastAt > 50) {
      lastSent = raw;
      lastAt = t;
      out.push({ degrees: raw, timestampMs: t, accuracy: 3 });
    }
  }
  return out;
}

/** Peak-to-peak spread of headings, the circular short way. */
export function peakToPeak(headings: readonly number[]): number {
  const first = headings[0];
  if (first === undefined) return 0;
  let lo = 0;
  let hi = 0;
  for (const h of headings) {
    const d = signedDeltaDeg(first, h);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return hi - lo;
}
