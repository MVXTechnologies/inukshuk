/**
 * Trails, the active recording and planned routes as 3D polylines on the
 * terrain (owner, #551), and the per-tile water/glacier masks the surface
 * shader reads. Pure maths: lifting a line onto the displayed heights,
 * densifying it so it follows the relief between its points, the screen-space
 * extrusion the line shader performs, and a scanline polygon rasterizer.
 */

/** Points a long segment is split into so the lifted line hugs the terrain. */
export function densify(
  pts: readonly (readonly [number, number])[],
  maxStep: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (i > 0) {
      const q = pts[i - 1]!;
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      const n = Math.min(256, Math.ceil(d / Math.max(maxStep, 1e-12)));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t]);
      }
    }
    out.push([p[0], p[1]]);
  }
  return out;
}

/** Heights (m) for points from a sampler; unknown ground reads as `fallback`. */
export function liftHeights(
  pts: readonly (readonly [number, number])[],
  heightAt: (x: number, y: number) => number | null,
  fallback = 0,
): number[] {
  return pts.map(([x, y]) => heightAt(x, y) ?? fallback);
}

/**
 * The screen-space extrusion of one line vertex: given the two segment ends
 * in NDC, which end this vertex is, its side (±1) and the line width in px,
 * the NDC offset to add (perpendicular to the segment on screen).
 */
export function extrudeOffset(
  a: readonly [number, number],
  b: readonly [number, number],
  side: number,
  widthPx: number,
  viewport: readonly [number, number],
): [number, number] {
  const dx = (b[0] - a[0]) * viewport[0];
  const dy = (b[1] - a[1]) * viewport[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [0, 0];
  const nx = -dy / len;
  const ny = dx / len;
  // NDC spans 2 units per viewport: px → NDC is 2 / viewport.
  return [((nx * widthPx) / viewport[0]) * side, ((ny * widthPx) / viewport[1]) * side];
}

/**
 * Rasterize polygons (rings in the mask's own unit square, y down) into a
 * size × size coverage mask (0/255), even–odd fill, sampled at pixel centres.
 */
export function rasterizePolygons(
  rings: readonly (readonly (readonly [number, number])[])[],
  size: number,
): Uint8Array {
  const out = new Uint8Array(size * size);
  const xs: number[] = [];
  for (let row = 0; row < size; row++) {
    const y = (row + 0.5) / size;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % n]!;
        if (a[1] <= y === b[1] <= y) continue;
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k]! * size - 0.5));
      const c1 = Math.min(size - 1, Math.floor(xs[k + 1]! * size - 0.5));
      for (let c = c0; c <= c1; c++) out[row * size + c] = 255;
    }
  }
  return out;
}

/** Map a ring from mercator [0,1] into a tile's unit square (z, x, y tile). */
export function ringToTile(
  ring: readonly (readonly [number, number])[],
  z: number,
  tx: number,
  ty: number,
): [number, number][] {
  const n = 2 ** z;
  return ring.map(([mx, my]) => [mx * n - tx, my * n - ty]);
}

/** Does a ring's bbox touch the tile's unit square? */
export function ringTouchesTile(ring: readonly (readonly [number, number])[]): boolean {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 >= 0 && x0 <= 1 && y1 >= 0 && y0 <= 1;
}
