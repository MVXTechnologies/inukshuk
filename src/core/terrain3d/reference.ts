/**
 * The terrain's reference height — MapLibre's camera is relative to sea
 * level, so the terrain is drawn relative to `hRef` (GL JS's "centre
 * altitude"). We take the highest ground under the bottom edge of the view:
 * nothing in front of the camera can then rise into the frame from below,
 * where the flat map has no pixels to drape (see docs/plans/native-terrain.md).
 */
import { groundAtNdc } from './camera';
import { invert, type Mat4 } from './mat4';

/** NDC points under the bottom edge the reference is sampled at. */
export const REFERENCE_NDC: readonly (readonly [number, number])[] = [
  [-0.9, -0.98],
  [0, -0.98],
  [0.9, -0.98],
];

/** The reference from height samples: the max of the finite ones (0 if none). */
export function referenceHeight(samples: readonly (number | null | undefined)[]): number {
  let best = -Infinity;
  for (const s of samples) if (typeof s === 'number' && Number.isFinite(s) && s > best) best = s;
  return best === -Infinity ? 0 : best;
}

/** World points (x_px, y_px) under the reference NDC points; nulls above the horizon. */
export function referencePoints(P: Mat4): ([number, number] | null)[] {
  const inv = invert(P);
  if (!inv) return REFERENCE_NDC.map(() => null);
  return REFERENCE_NDC.map(([x, y]) => groundAtNdc(inv, x, y));
}

/**
 * Exponential smoothing toward `target` over `dtMs` with time constant
 * `tauMs`; snaps when within `epsilon` (and on the first sample, `current`
 * null).
 */
export function smoothToward(
  current: number | null,
  target: number,
  dtMs: number,
  tauMs = 150,
  epsilon = 0.05,
): number {
  if (current === null || !Number.isFinite(current)) return target;
  if (!Number.isFinite(dtMs) || dtMs <= 0) return current;
  const a = 1 - Math.exp(-dtMs / Math.max(tauMs, 1e-6));
  const next = current + (target - current) * a;
  return Math.abs(next - target) < epsilon ? target : next;
}
