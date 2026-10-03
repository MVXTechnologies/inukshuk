/**
 * View-frustum culling against axis-aligned boxes, in the projection
 * matrix's own space (x_px, y_px, z_m). Planes come straight from the matrix
 * rows (Gribb–Hartmann), so the same code culls against MapLibre's matrix on
 * device and the reference camera in tests.
 *
 * Only the four side planes plus "in front of the eye" (w > 0) are used: the
 * terrain draws with its own depth range, so MapLibre's near/far planes must
 * not cull a mountain, and the fog distance does the far cut.
 */
import type { Mat4 } from './mat4';

/** a·x + b·y + c·z + d ≥ 0 means inside. */
export type Plane = [number, number, number, number];

export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

function row(P: Mat4, i: number): Plane {
  return [P[i]!, P[4 + i]!, P[8 + i]!, P[12 + i]!];
}

function add(a: Plane, b: Plane, sign: 1 | -1): Plane {
  return [a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2], a[3] + sign * b[3]];
}

function normalize(p: Plane): Plane {
  const l = Math.hypot(p[0], p[1], p[2]);
  return l > 0 ? [p[0] / l, p[1] / l, p[2] / l, p[3] / l] : p;
}

/** Left, right, bottom, top, front-of-eye. */
export function frustumPlanes(P: Mat4): Plane[] {
  const r0 = row(P, 0);
  const r1 = row(P, 1);
  const r3 = row(P, 3);
  return [add(r3, r0, 1), add(r3, r0, -1), add(r3, r1, 1), add(r3, r1, -1), r3].map(normalize);
}

/**
 * True when the box is entirely outside at least one plane (conservative:
 * a box straddling a frustum corner may be reported visible).
 */
export function aabbOutside(planes: readonly Plane[], b: Aabb): boolean {
  for (const p of planes) {
    const x = p[0] >= 0 ? b.maxX : b.minX;
    const y = p[1] >= 0 ? b.maxY : b.minY;
    const z = p[2] >= 0 ? b.maxZ : b.minZ;
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return true;
  }
  return false;
}

/** True when a point is inside every plane. */
export function pointInside(planes: readonly Plane[], x: number, y: number, z: number): boolean {
  for (const p of planes) if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  return true;
}

/**
 * Distance from a point to a box, with z scaled by `zScale` first (metres →
 * pixels) so all three axes share a unit. 0 when the point is inside.
 */
export function distanceToAabb(
  px: number,
  py: number,
  pz: number,
  b: Aabb,
  zScale: number,
): number {
  const dx = Math.max(b.minX - px, 0, px - b.maxX);
  const dy = Math.max(b.minY - py, 0, py - b.maxY);
  const dz = Math.max(b.minZ - pz, 0, pz - b.maxZ) * zScale;
  return Math.hypot(dx, dy, dz);
}
