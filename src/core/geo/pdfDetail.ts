import type { LngLat } from '@core/models';

/** Fractional page rectangle in unrotated visual space (origin top-left). */
export interface PdfCrop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface PdfDetailBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}
export interface PdfDetailPlan {
  crop: PdfCrop;
  targetWidthPx: number;
  coordinates: [LngLat, LngLat, LngLat, LngLat];
}

/** Self-contained: this same function is embedded in the PDF WebView. */
export function rasterCropGeometry(
  pageWidth: number,
  pageHeight: number,
  targetWidth: number,
  crop: PdfCrop | null,
) {
  const r = crop ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  if (
    ![pageWidth, pageHeight, targetWidth, r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) ||
    pageWidth <= 0 ||
    pageHeight <= 0 ||
    targetWidth <= 0 ||
    r.x0 < 0 ||
    r.y0 < 0 ||
    r.x1 > 1 ||
    r.y1 > 1 ||
    r.x1 <= r.x0 ||
    r.y1 <= r.y0
  )
    throw new Error('Invalid PDF crop dimensions');
  const width = pageWidth * (r.x1 - r.x0);
  const height = pageHeight * (r.y1 - r.y0);
  const edge = crop ? 2048 : 4096;
  const pixels = (crop ? 3 : 8) * 1024 * 1024;
  const scale = Math.min(
    targetWidth / width,
    edge / width,
    edge / height,
    Math.sqrt(pixels / (width * height)),
  );
  return {
    widthPx: Math.max(1, Math.floor(width * scale)),
    heightPx: Math.max(1, Math.floor(height * scale)),
    scale,
    offsetX: -r.x0 * pageWidth * scale,
    offsetY: -r.y0 * pageHeight * scale,
  };
}

/** Invert the same affine page mapping used by the overview, including rotation. */
export function planPdfDetail(
  corners: [LngLat, LngLat, LngLat, LngLat],
  page: { width: number; height: number },
  bounds: PdfDetailBounds,
  viewportWidthPx: number,
): PdfDetailPlan | null {
  if (
    ![...corners.flat(), page.width, page.height, ...Object.values(bounds), viewportWidthPx].every(
      Number.isFinite,
    ) ||
    bounds.east <= bounds.west ||
    bounds.north <= bounds.south ||
    viewportWidthPx <= 0 ||
    page.width <= 0 ||
    page.height <= 0
  )
    return null;
  if (
    corners.some((c) => Math.abs(c[1]) >= 85.051129) ||
    Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0])) > 180
  )
    return null;
  const project = ([lng, lat]: LngLat): LngLat => [
    (lng * Math.PI) / 180,
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  ];
  const unproject = ([x, y]: LngLat): LngLat => [
    (x * 180) / Math.PI,
    ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI,
  ];
  const [tl, tr, br, bl] = corners.map(project) as [LngLat, LngLat, LngLat, LngLat];
  const ax = tr[0] - tl[0],
    ay = tr[1] - tl[1];
  const bx = bl[0] - tl[0],
    by = bl[1] - tl[1];
  const rx = br[0] - tr[0] - bl[0] + tl[0],
    ry = br[1] - tr[1] - bl[1] + tl[1];
  const det = ax * by - ay * bx;
  const det2 = (ax + rx) * (by + ry) - (ay + ry) * (bx + rx);
  if (Math.abs(det) < 1e-16 || Math.abs(det2) < 1e-16 || det * det2 <= 0) return null;
  const unit = (lng: number, lat: number): LngLat => {
    const p = project([lng, lat]);
    const x = p[0] - tl[0],
      y = p[1] - tl[1];
    const u = (x * by - y * bx) / det,
      v = (ax * y - ay * x) / det;
    if (u + v <= 1) return [u, v];
    return [
      ((x + rx) * (by + ry) - (y + ry) * (bx + rx)) / det2,
      ((ax + rx) * (y + ry) - (ay + ry) * (x + rx)) / det2,
    ];
  };
  const points = [
    unit(bounds.west, bounds.north),
    unit(bounds.east, bounds.north),
    unit(bounds.east, bounds.south),
    unit(bounds.west, bounds.south),
  ];
  const xs = points.map((p) => p[0]!),
    ys = points.map((p) => p[1]!);
  const left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...ys),
    bottom = Math.max(...ys);
  if (right <= 0 || left >= 1 || bottom <= 0 || top >= 1) return null;
  const density = viewportWidthPx / (right - left);
  // The overview already supplies 2048 pixels across the page. Refine only
  // when the additional sampling is appreciable, avoiding work at fit-to-map.
  if (density < 2048 * 1.4) return null;
  const step = 2 ** Math.floor(Math.log2(Math.max(right - left, bottom - top) / 8));
  const low = (v: number) => Math.max(0, Math.floor(v / step - 1) * step);
  const high = (v: number) => Math.min(1, Math.ceil(v / step + 1) * step);
  let crop = { x0: low(left), y0: low(top), x1: high(right), y1: high(bottom) };
  if (crop.x0 + crop.y0 < 1 && crop.x1 + crop.y1 > 1) {
    // Native draws the quad as two triangles split at u+v=1. A crop crossing
    // that diagonal must keep the same split: expand it to a unit-space square
    // whose opposite corners lie on that line. Each resulting image triangle
    // then uses exactly the original affine transform, even for skewed maps.
    const size = Math.min(
      1,
      2 **
        Math.ceil(
          Math.log2(
            Math.max(
              crop.x1 - crop.x0,
              crop.y1 - crop.y0,
              crop.x1 + crop.y1 - 1,
              1 - crop.x0 - crop.y0,
            ),
          ),
        ),
    );
    const minX = Math.max(0, crop.x1 - size, 1 - size - crop.y0);
    const maxX = Math.min(1 - size, crop.x0, 1 - crop.y1);
    const x0 = Math.min(
      maxX,
      Math.max(minX, Math.floor((crop.x0 + crop.x1 - size) / 2 / step) * step),
    );
    crop = { x0, y0: 1 - size - x0, x1: x0 + size, y1: 1 - x0 };
  }
  const geometry = rasterCropGeometry(
    page.width,
    page.height,
    Math.ceil(density * (crop.x1 - crop.x0)),
    crop,
  );
  if (geometry.widthPx / (crop.x1 - crop.x0) < 2048 * 1.2) return null;
  const geo = (x: number, y: number): LngLat => {
    const diagonal = Math.max(0, x + y - 1);
    return unproject([
      tl[0] + ax * x + bx * y + rx * diagonal,
      tl[1] + ay * x + by * y + ry * diagonal,
    ]);
  };
  return {
    crop,
    targetWidthPx: geometry.widthPx,
    coordinates: [
      geo(crop.x0, crop.y0),
      geo(crop.x1, crop.y0),
      geo(crop.x1, crop.y1),
      geo(crop.x0, crop.y1),
    ],
  };
}
