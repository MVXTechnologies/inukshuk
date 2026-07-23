import type { RgbaRaster } from './cropRaster';

/**
 * Tiny software rasterizer for the map maker's live preview (and for
 * compositing overlay tiles onto the basemap before it becomes a PDF JPEG):
 * alpha-over blending and simple thick-line polylines. No anti-aliasing —
 * at preview sizes a crisp 1–2 px line reads better than a blurred one, and
 * the print path draws real vectors instead.
 */

export type Rgba = [number, number, number, number];

/**
 * Composite `src` over `dst` in place (same dimensions), scaling the source's
 * own alpha by `opacity` (0..1). Destination alpha is left opaque.
 */
export function blendRgbaOver(dst: Uint8Array, src: Uint8Array, opacity: number): void {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i += 4) {
    const a = ((src[i + 3] ?? 0) / 255) * opacity;
    if (a <= 0) continue;
    const ia = 1 - a;
    dst[i] = Math.round(dst[i]! * ia + src[i]! * a);
    dst[i + 1] = Math.round(dst[i + 1]! * ia + src[i + 1]! * a);
    dst[i + 2] = Math.round(dst[i + 2]! * ia + src[i + 2]! * a);
  }
}

/** Paint one pixel (bounds-checked) with the colour's alpha. */
function plot(r: RgbaRaster, x: number, y: number, c: Rgba): void {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const i = (y * r.width + x) * 4;
  const a = c[3] / 255;
  const ia = 1 - a;
  r.data[i] = Math.round(r.data[i]! * ia + c[0] * a);
  r.data[i + 1] = Math.round(r.data[i + 1]! * ia + c[1] * a);
  r.data[i + 2] = Math.round(r.data[i + 2]! * ia + c[2] * a);
}

/**
 * Draw a polyline in raster pixel space (points may lie outside — plotting is
 * clipped per pixel). `thickness` 1 = single pixel, 2 = a 2×2 stamp, etc.
 */
export function drawPolylineRgba(
  r: RgbaRaster,
  points: { x: number; y: number }[],
  color: Rgba,
  thickness = 1,
): void {
  const stamp = (cx: number, cy: number) => {
    const half = Math.floor((thickness - 1) / 2);
    for (let dy = -half; dy < thickness - half; dy++)
      for (let dx = -half; dx < thickness - half; dx++) plot(r, cx + dx, cy + dy, color);
  };

  for (let s = 0; s < points.length - 1; s++) {
    let x0 = Math.round(points[s]!.x);
    let y0 = Math.round(points[s]!.y);
    const x1 = Math.round(points[s + 1]!.x);
    const y1 = Math.round(points[s + 1]!.y);
    // Bresenham.
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      stamp(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
}
