import { unwrapLng, type Pt } from './geo';
import type { DrawShape } from './view';

/**
 * Light smoothing for pencil lines when drawn (#683, mockup frame 4: "Douglas–
 * Peucker at 1.5 dp, then a Catmull-Rom curve when drawn", never snapped).
 * The record keeps the simplified points; only the drawn line is curved.
 * Uniform Catmull-Rom through every point, `steps` segments per span, at
 * most {@link MAX_SMOOTH_POINTS} points out (fewer steps for long lines).
 */
export const SMOOTH_STEPS = 4;
export const MAX_SMOOTH_POINTS = 2_000;

export function catmullRom(pts: readonly Pt[], steps = SMOOTH_STEPS): Pt[] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
  const ref = pts[0]![0];
  const u = pts.map((p): Pt => [unwrapLng(p[0], ref), p[1]]);
  const n = Math.max(1, Math.min(steps, Math.floor(MAX_SMOOTH_POINTS / (u.length - 1))));
  const out: Pt[] = [u[0]!];
  for (let i = 0; i < u.length - 1; i++) {
    const p0 = u[Math.max(0, i - 1)]!;
    const p1 = u[i]!;
    const p2 = u[i + 1]!;
    const p3 = u[Math.min(u.length - 1, i + 2)]!;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const at = (j: 0 | 1) =>
        0.5 *
        (2 * p1[j] +
          (-p0[j] + p2[j]) * t +
          (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 +
          (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
      out.push([at(0), at(1)]);
    }
  }
  return out;
}

/** The shapes as drawn: pencil lines curved, everything else as stored. */
export function smoothShapes<T extends Pick<DrawShape, 'sh' | 'pts'>>(shapes: readonly T[]): T[] {
  return shapes.map((s) => (s.sh === 'free' ? { ...s, pts: catmullRom(s.pts) } : s));
}
