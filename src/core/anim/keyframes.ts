/**
 * Tiny keyframe sampler, CSS-`@keyframes`-shaped, for animations driven by a
 * single clock (ms). Pure and allocation-free per sample, and every function
 * is marked `'worklet'` so Reanimated can call it on the UI thread — the
 * directive is a plain string, so this stays an ordinary pure module under
 * Node/Jest.
 *
 * A track is a list of keyframes sorted by time. Each keyframe carries a
 * value vector (one number per channel) and the easing used from it to the
 * NEXT keyframe — exactly how CSS's per-keyframe `animation-timing-function`
 * works.
 */

/** cubic-bezier(x1, y1, x2, y2), CSS semantics (y may overshoot [0, 1]). */
export type Bezier = readonly [number, number, number, number];
/** 'step' holds the from-value until the next keyframe (a CSS jump). */
export type Ease = 'linear' | 'step' | Bezier;

export interface Keyframe {
  /** Time in ms. */
  t: number;
  /** Channel values at `t`. Every keyframe of a track has the same length. */
  v: readonly number[];
  /** Easing from this keyframe to the next. Ignored on the last one. */
  ease: Ease;
}

export type Track = readonly Keyframe[];

// CSS named easings.
export const EASE: Bezier = [0.25, 0.1, 0.25, 1];
export const EASE_IN_OUT: Bezier = [0.42, 0, 0.58, 1];

function bez(u: number, p1: number, p2: number): number {
  'worklet';
  // Bernstein form with P0 = 0, P3 = 1.
  const v = 1 - u;
  return 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u;
}

function bezSlope(u: number, p1: number, p2: number): number {
  'worklet';
  const v = 1 - u;
  return 3 * v * v * p1 + 6 * v * u * (p2 - p1) + 3 * u * u * (1 - p2);
}

/**
 * CSS cubic-bezier timing function: solve x(u) = x for the curve parameter u
 * (Newton, then bisection as a fallback), return y(u). x outside [0, 1] clamps.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  'worklet';
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let u = x;
  for (let i = 0; i < 8; i++) {
    const err = bez(u, x1, x2) - x;
    if (Math.abs(err) < 1e-7) return bez(u, y1, y2);
    const d = bezSlope(u, x1, x2);
    if (Math.abs(d) < 1e-7) break;
    u -= err / d;
    if (u < 0 || u > 1) break;
  }
  let lo = 0;
  let hi = 1;
  u = x;
  for (let i = 0; i < 40; i++) {
    const xu = bez(u, x1, x2);
    if (Math.abs(xu - x) < 1e-7) break;
    if (xu < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return bez(u, y1, y2);
}

/** Eased progress for p in [0, 1]. */
export function applyEase(ease: Ease, p: number): number {
  'worklet';
  if (ease === 'linear') return p;
  if (ease === 'step') return 0;
  return cubicBezier(ease[0], ease[1], ease[2], ease[3], p);
}

/**
 * Value of channel `ch` of `track` at time `t` (ms). Before the first
 * keyframe it holds the first value; after the last, the last value.
 */
export function sampleTrack(track: Track, t: number, ch: number): number {
  'worklet';
  const first = track[0];
  if (!first) return 0;
  if (t <= first.t) return first.v[ch] ?? 0;
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (!a || !b) break;
    if (t < b.t) {
      const from = a.v[ch] ?? 0;
      const to = b.v[ch] ?? 0;
      const span = b.t - a.t;
      const p = span > 0 ? (t - a.t) / span : 1;
      return from + (to - from) * applyEase(a.ease, p);
    }
  }
  const last = track[track.length - 1];
  return last ? (last.v[ch] ?? 0) : 0;
}
