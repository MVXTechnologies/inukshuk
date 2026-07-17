/**
 * Pure ray↔terrain intersection for the 3D screens' picking gestures
 * (pinch-zoom toward the fingers, tap-to-query, double-tap zoom). The terrain
 * is an analytic heightfield `y = heightAt(x, z)` in scene units; the ray
 * comes from unprojecting a screen point through the camera (feature layer).
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Terrain surface height (scene units) at a ground x/z. */
export type GroundHeightFn = (x: number, z: number) => number;

export interface RayMarchOptions {
  /** How far along the ray to search (scene units). */
  maxDist?: number;
  /** Coarse march steps across maxDist (first sign change is then bisected). */
  coarseSteps?: number;
  /** Bisection refinement iterations after the coarse hit. */
  refineIters?: number;
}

/**
 * March a ray against the heightfield and return the first ground hit, or
 * null when the ray never meets the terrain (e.g. pointing at the sky). The
 * coarse march finds the first interval where the ray dips below the surface;
 * bisection then refines the crossing. If the origin already starts under the
 * surface (a camera clipped into a peak), the ground point directly at the
 * origin is returned so callers always get something sensible to zoom toward.
 */
export function rayGroundHit(
  origin: Vec3Like,
  dir: Vec3Like,
  heightAt: GroundHeightFn,
  opts: RayMarchOptions = {},
): Vec3Like | null {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (!(len > 0)) return null;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;
  const maxDist = opts.maxDist ?? 24;
  const steps = opts.coarseSteps ?? 320;
  const refineIters = opts.refineIters ?? 24;

  /** Signed clearance of the ray point at distance t above the surface. */
  const clearance = (t: number) =>
    origin.y + dy * t - heightAt(origin.x + dx * t, origin.z + dz * t);

  if (clearance(0) <= 0) {
    return { x: origin.x, y: heightAt(origin.x, origin.z), z: origin.z };
  }
  const step = maxDist / steps;
  let prevT = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i * step;
    if (clearance(t) <= 0) {
      let lo = prevT;
      let hi = t;
      for (let j = 0; j < refineIters; j++) {
        const mid = (lo + hi) / 2;
        if (clearance(mid) <= 0) hi = mid;
        else lo = mid;
      }
      const tHit = (lo + hi) / 2;
      const hx = origin.x + dx * tHit;
      const hz = origin.z + dz * tHit;
      return { x: hx, y: heightAt(hx, hz), z: hz };
    }
    prevT = t;
  }
  return null;
}

/** A point on the ground plane (scene units). */
export interface GroundXZ {
  x: number;
  z: number;
}

/**
 * Move an orbit centre for a zoom by `scale` anchored at ground point `hit`:
 * `center' = H + (center − H)·s`. With the orbit radius scaled by the same
 * factor, the anchored point stays (approximately) fixed under the fingers —
 * the map-app "zoom toward the pinch" feel.
 */
export function zoomTowardPoint(center: GroundXZ, hit: GroundXZ, scale: number): GroundXZ {
  return {
    x: hit.x + (center.x - hit.x) * scale,
    z: hit.z + (center.z - hit.z) * scale,
  };
}
