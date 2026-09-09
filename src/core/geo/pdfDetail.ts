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
/** Physical map-frame height and the bearing associated with its settled bounds. */
export interface PdfDetailViewport {
  heightPx: number;
  bearing: number;
}
export interface PdfDetailPlan {
  tileKey?: string;
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
  const edge = crop ? 3072 : 4096;
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
  // Padding must not force a viewport entirely in one affine triangle into
  // the much larger diagonal-aligned square. Trim only the excess padding;
  // all actual visible bounds remain inside the crop.
  if (left + top >= 1 && crop.x0 + crop.y0 < 1) {
    crop.x0 = Math.min(left, 1 - crop.y0);
    crop.y0 = 1 - crop.x0;
  } else if (right + bottom <= 1 && crop.x1 + crop.y1 > 1) {
    crop.x1 = Math.max(right, 1 - crop.y1);
    crop.y1 = 1 - crop.x1;
  }
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

/** Bounded page-grid tiles; every crossing cell shares the original diagonal. */
export function planPdfDetailTiles(
  corners: [LngLat, LngLat, LngLat, LngLat],
  page: { width: number; height: number },
  bounds: PdfDetailBounds,
  viewportWidthPx: number,
  pixelBudget = 6 * 1024 * 1024,
  viewport?: PdfDetailViewport,
): PdfDetailPlan[] {
  if (
    (viewport !== undefined &&
      (!Number.isFinite(viewport.heightPx) ||
        viewport.heightPx <= 0 ||
        !Number.isFinite(viewport.bearing))) ||
    ![
      ...corners.flat(),
      page.width,
      page.height,
      ...Object.values(bounds),
      viewportWidthPx,
      pixelBudget,
    ].every(Number.isFinite) ||
    page.width <= 0 ||
    page.height <= 0 ||
    viewportWidthPx <= 0 ||
    pixelBudget <= 0 ||
    bounds.east <= bounds.west ||
    bounds.north <= bounds.south ||
    Math.abs(bounds.south) >= 85.051129 ||
    Math.abs(bounds.north) >= 85.051129 ||
    corners.some((c) => Math.abs(c[1]) >= 85.051129) ||
    Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0])) > 180
  )
    return [];
  const project = ([lng, lat]: LngLat): LngLat => [
    (lng * Math.PI) / 180,
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  ];
  const unproject = ([x, y]: LngLat): LngLat => [
    (x * 180) / Math.PI,
    ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI,
  ];
  const [tl, tr, br, bl] = corners.map(project) as typeof corners;
  const ax = tr[0] - tl[0],
    ay = tr[1] - tl[1],
    bx = bl[0] - tl[0],
    by = bl[1] - tl[1];
  const rx = br[0] - tr[0] - bl[0] + tl[0],
    ry = br[1] - tr[1] - bl[1] + tl[1];
  const det = ax * by - ay * bx;
  const det2 = (ax + rx) * (by + ry) - (ay + ry) * (bx + rx);
  if (Math.abs(det) < 1e-16 || Math.abs(det2) < 1e-16 || det * det2 <= 0) return [];
  const firstUnit = ([px, py]: LngLat): LngLat => {
    const x = px - tl[0],
      y = py - tl[1];
    return [(x * by - y * bx) / det, (ax * y - ay * x) / det];
  };
  const unit = (point: LngLat): LngLat => {
    const first = firstUnit(point);
    if (first[0] + first[1] <= 1) return first;
    const x = point[0] - tl[0] + rx,
      y = point[1] - tl[1] + ry;
    return [(x * (by + ry) - y * (bx + rx)) / det2, ((ax + rx) * y - (ay + ry) * x) / det2];
  };
  const view = [
    project([bounds.west, bounds.north]),
    project([bounds.east, bounds.north]),
    project([bounds.east, bounds.south]),
    project([bounds.west, bounds.south]),
  ];
  const visible = view.map(unit);
  // An edge can bend at the native triangle boundary. Include its crossing
  // as well as the four corners, so the inverse viewport bounds have no holes.
  for (let i = 0; i < 4; i++) {
    const a = view[i]!,
      b = view[(i + 1) % 4]!;
    const ua = firstUnit(a),
      ub = firstUnit(b);
    const da = ua[0] + ua[1] - 1,
      db = ub[0] + ub[1] - 1;
    if (da * db < 0) {
      const t = da / (da - db);
      visible.push(unit([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]));
    }
  }
  const left = Math.max(0, Math.min(...visible.map((p) => p[0])));
  const right = Math.min(1, Math.max(...visible.map((p) => p[0])));
  const top = Math.max(0, Math.min(...visible.map((p) => p[1])));
  const bottom = Math.min(1, Math.max(...visible.map((p) => p[1])));
  if (right <= left || bottom <= top) return [];
  // Use the largest singular value of both page-to-screen affine transforms:
  // the inverse viewport bounding-box width alone undersamples rotated sheets.
  // Axis-aligned longitude bounds span the rotated frame's horizontal
  // projection, not its screen width. At 90 degrees a portrait view spans
  // its full physical height east-to-west.
  const bearing = ((viewport?.bearing ?? 0) % 360) * (Math.PI / 180);
  const horizontalPixels =
    Math.abs(Math.cos(bearing)) * viewportWidthPx +
    Math.abs(Math.sin(bearing)) * (viewport?.heightPx ?? 0);
  const screenScale = horizontalPixels / (view[1]![0] - view[0]![0]);
  const stretch = (a: number, b: number, c: number, d: number) => {
    const aa = a * a + c * c,
      bb = b * b + d * d,
      ab = a * b + c * d;
    return Math.sqrt((aa + bb + Math.sqrt((aa - bb) ** 2 + 4 * ab * ab)) / 2);
  };
  const density =
    screenScale *
    page.width *
    Math.max(
      stretch(ax / page.width, bx / page.height, ay / page.width, by / page.height),
      stretch(
        (ax + rx) / page.width,
        (bx + rx) / page.height,
        (ay + ry) / page.width,
        (by + ry) / page.height,
      ),
    );
  if (!Number.isFinite(density) || density < 2048 * 1.4) return [];
  let divisions = 2 ** Math.min(20, Math.max(0, Math.ceil(Math.log2(density / 768))));
  // Bound the inverse viewport span using both affine triangles' derivatives.
  // Unlike the clipped visible range, this depends only on zoom/frame and page
  // geometry: a pan across a cell edge must not resize every cached tile.
  const viewWidth = view[1]![0] - view[0]![0];
  const viewHeight = view[0]![1] - view[3]![1];
  const spanU =
    viewWidth * Math.max(Math.abs(by / det), Math.abs((by + ry) / det2)) +
    viewHeight * Math.max(Math.abs(bx / det), Math.abs((bx + rx) / det2));
  const spanV =
    viewWidth * Math.max(Math.abs(ay / det), Math.abs((ay + ry) / det2)) +
    viewHeight * Math.max(Math.abs(ax / det), Math.abs((ax + rx) / det2));
  // Mercator round-trips can turn an exact integer span into k +/- a few
  // trillionths of a cell. Snap only that numerical neighborhood, both when
  // reserving capacity and selecting endpoints, to avoid an extra row changing
  // every tile's resolution (or exceeding its reserved pixel budget).
  const snapCell = (value: number) => {
    const nearest = Math.round(value);
    return Math.abs(value - nearest) <= 1e-9 ? nearest : value;
  };
  // A span of k cells can touch ceil(k)+1 cells at its least favorable
  // alignment. Include that extra cell on each axis before allocating pixels.
  const capacity = (n: number) =>
    Math.min(n, Math.ceil(snapCell(spanU * n)) + 1) *
    Math.min(n, Math.ceil(snapCell(spanV * n)) + 1);
  const cells = (n: number) => ({
    x0: Math.floor(snapCell(left * n)),
    x1: Math.min(n - 1, Math.ceil(snapCell(right * n)) - 1),
    y0: Math.floor(snapCell(top * n)),
    y1: Math.min(n - 1, Math.ceil(snapCell(bottom * n)) - 1),
  });
  while (capacity(divisions) > 24 && divisions > 1) {
    divisions /= 2;
  }
  const range = cells(divisions);
  const aspect = page.height / page.width;
  const maximumWidth = Math.min(
    3072,
    3072 / aspect,
    Math.sqrt((3 * 1024 * 1024) / aspect),
    Math.sqrt(pixelBudget / capacity(divisions) / aspect),
  );
  const desiredWidth = Math.ceil(density / divisions / 32) * 32;
  const budgetWidth = Math.floor(maximumWidth / 32) * 32;
  const width = Math.min(desiredWidth, budgetWidth);
  if (width < 1 || width * divisions < 2048 * 1.2) return [];
  const geo = (u: number, v: number): LngLat => {
    const diagonal = Math.max(0, u + v - 1);
    return unproject([
      tl[0] + ax * u + bx * v + rx * diagonal,
      tl[1] + ay * u + by * v + ry * diagonal,
    ]);
  };
  const plans: PdfDetailPlan[] = [];
  for (let y = range.y0; y <= range.y1; y++)
    for (let x = range.x0; x <= range.x1; x++) {
      const crop = {
        x0: x / divisions,
        y0: y / divisions,
        x1: (x + 1) / divisions,
        y1: (y + 1) / divisions,
      };
      plans.push({
        crop,
        targetWidthPx: width,
        tileKey: `${divisions}:${x}:${y}:${width}`,
        coordinates: [
          geo(crop.x0, crop.y0),
          geo(crop.x1, crop.y0),
          geo(crop.x1, crop.y1),
          geo(crop.x0, crop.y1),
        ],
      });
    }
  const cx = (left + right) / 2,
    cy = (top + bottom) / 2;
  const distance = (p: PdfDetailPlan) =>
    ((p.crop.x0 + p.crop.x1) / 2 - cx) ** 2 + ((p.crop.y0 + p.crop.y1) / 2 - cy) ** 2;
  return plans.sort((a, b) => distance(a) - distance(b));
}
