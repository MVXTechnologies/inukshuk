import type { BoundingBox, CornerCoordinates, LatLng, LngLat, PointRect } from '@core/models';

/**
 * Pure 2D geometry helpers used by the map overlay and the georeference parsers.
 * No React-Native or platform dependencies — fully unit-testable.
 */

/** Mean earth radius in metres (IUGG), the value GPX/GIS tooling expects. */
const EARTH_RADIUS_M = 6371008.8;
const DEG2RAD = Math.PI / 180;

/** Great-circle distance between two coordinates, in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const lat1 = a.latitude * DEG2RAD;
  const lat2 = b.latitude * DEG2RAD;
  const dLat = (b.latitude - a.latitude) * DEG2RAD;
  const dLng = (b.longitude - a.longitude) * DEG2RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial great-circle bearing from `a` to `b`, in degrees clockwise from true
 * north (`[0, 360)`).
 *
 * "Initial" because a great circle's bearing changes along the way: over a few
 * kilometres of trail the difference is negligible, but this is the number a
 * compass user should walk on RIGHT NOW, which is exactly what the destination
 * readout needs. Returns 0 for coincident points (no direction exists).
 */
export function initialBearingDeg(a: LatLng, b: LatLng): number {
  const lat1 = a.latitude * DEG2RAD;
  const lat2 = b.latitude * DEG2RAD;
  const dLng = (b.longitude - a.longitude) * DEG2RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  if (y === 0 && x === 0) return 0;
  return (Math.atan2(y, x) / DEG2RAD + 360) % 360;
}

/** A 2D affine transform mapping (x, y) -> (a*x + b*y + c, d*x + e*y + f). */
export interface Affine2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const applyAffine = (t: Affine2D, x: number, y: number): [number, number] => [
  t.a * x + t.b * y + t.c,
  t.d * x + t.e * y + t.f,
];

/**
 * Least-squares fit of a 2D affine transform from >= 3 (src -> dst)
 * correspondences. Solves the normal equations for each output axis
 * independently (they share the same 3x3 design matrix). Throws if the source
 * points are collinear/degenerate.
 */
export function fitAffine(
  src: readonly (readonly [number, number])[],
  dst: readonly (readonly [number, number])[],
): Affine2D {
  if (src.length !== dst.length || src.length < 3) {
    throw new Error('fitAffine needs at least 3 matched point pairs');
  }

  // Build the symmetric 3x3 matrix M = sum [x y 1]^T [x y 1] and the
  // right-hand sides for the X and Y outputs.
  let sxx = 0;
  let sxy = 0;
  let sx = 0;
  let syy = 0;
  let sy = 0;
  let s1 = 0;
  let bX0 = 0;
  let bX1 = 0;
  let bX2 = 0;
  let bY0 = 0;
  let bY1 = 0;
  let bY2 = 0;

  for (let i = 0; i < src.length; i++) {
    const x = src[i]![0];
    const y = src[i]![1];
    const u = dst[i]![0];
    const v = dst[i]![1];
    sxx += x * x;
    sxy += x * y;
    sx += x;
    syy += y * y;
    sy += y;
    s1 += 1;
    bX0 += x * u;
    bX1 += y * u;
    bX2 += u;
    bY0 += x * v;
    bY1 += y * v;
    bY2 += v;
  }

  const m: number[][] = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, s1],
  ];

  const [a, b, c] = solve3x3(m, [bX0, bX1, bX2]);
  const [d, e, f] = solve3x3(m, [bY0, bY1, bY2]);
  return { a, b, c, d, e, f };
}

/** Solve a 3x3 linear system by Cramer's rule. Throws on singular matrices. */
function solve3x3(m: number[][], rhs: number[]): [number, number, number] {
  const det = det3(m);
  if (Math.abs(det) < 1e-12) {
    throw new Error('Degenerate control points: cannot fit affine transform');
  }
  const mx = [
    [rhs[0]!, m[0]![1]!, m[0]![2]!],
    [rhs[1]!, m[1]![1]!, m[1]![2]!],
    [rhs[2]!, m[2]![1]!, m[2]![2]!],
  ];
  const my = [
    [m[0]![0]!, rhs[0]!, m[0]![2]!],
    [m[1]![0]!, rhs[1]!, m[1]![2]!],
    [m[2]![0]!, rhs[2]!, m[2]![2]!],
  ];
  const mz = [
    [m[0]![0]!, m[0]![1]!, rhs[0]!],
    [m[1]![0]!, m[1]![1]!, rhs[1]!],
    [m[2]![0]!, m[2]![1]!, rhs[2]!],
  ];
  return [det3(mx) / det, det3(my) / det, det3(mz) / det];
}

function det3(m: number[][]): number {
  return (
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)
  );
}

/**
 * Given the geographic corners of a viewport rectangle (a sub-region of a PDF
 * page) and that rectangle in PDF points, extrapolate the geographic corners of
 * a different (usually full-page) rectangle, assuming the page->geo mapping is
 * affine. This lets us overlay a full-page raster render even when only the map
 * frame is georeferenced.
 *
 * PDF point space has its origin at the bottom-left; the returned corners use
 * MapLibre's visual-top-first ordering.
 */
export function extrapolatePageCorners(
  viewportRect: PointRect,
  viewportCorners: CornerCoordinates,
  targetRect: PointRect,
): CornerCoordinates {
  // Viewport page-space corners, matched to their geographic corners. Visual
  // top corresponds to the larger Y in PDF point space.
  const src: [number, number][] = [
    [viewportRect.x0, viewportRect.y1], // top-left
    [viewportRect.x1, viewportRect.y1], // top-right
    [viewportRect.x1, viewportRect.y0], // bottom-right
    [viewportRect.x0, viewportRect.y0], // bottom-left
  ];
  const dst: [number, number][] = [
    viewportCorners.topLeft,
    viewportCorners.topRight,
    viewportCorners.bottomRight,
    viewportCorners.bottomLeft,
  ];
  const t = fitAffine(src, dst);
  const at = (x: number, y: number): LngLat => applyAffine(t, x, y) as LngLat;
  return {
    topLeft: at(targetRect.x0, targetRect.y1),
    topRight: at(targetRect.x1, targetRect.y1),
    bottomRight: at(targetRect.x1, targetRect.y0),
    bottomLeft: at(targetRect.x0, targetRect.y0),
  };
}

/**
 * True if a coordinate is finite and within valid geographic range. MapLibre's
 * native ImageSource crashes the whole app (not a catchable JS error) when given
 * NaN/Infinity or wildly out-of-range corners — which can happen when a
 * georeference viewport is extrapolated to a full page. Overlays MUST validate
 * their corners with this before handing them to the native layer.
 */
export function isValidLngLat(p: LngLat): boolean {
  const [lng, lat] = p;
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/** True if all four corners are finite and in-range (safe to render natively). */
export const cornersAreValid = (c: CornerCoordinates): boolean =>
  isValidLngLat(c.topLeft) &&
  isValidLngLat(c.topRight) &&
  isValidLngLat(c.bottomRight) &&
  isValidLngLat(c.bottomLeft);

/**
 * True if a bbox is effectively a point or a line (near-zero area). A degenerate
 * image quad can crash MapLibre's projection, and is never a real map sheet — so
 * overlays skip these. The default ~1e-6° threshold is ~0.1 m, far below any real
 * page extent but well above the sub-arcsecond collapse a bad georeference makes.
 */
export function isDegenerateBBox(b: BoundingBox, minSpanDeg = 1e-6): boolean {
  return b.maxLat - b.minLat < minSpanDeg || b.maxLng - b.minLng < minSpanDeg;
}

export function bboxFromLngLats(points: readonly LngLat[]): BoundingBox {
  if (points.length === 0) {
    throw new Error('bboxFromLngLats requires at least one point');
  }
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const [lng, lat] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, minLng, maxLat, maxLng };
}

export const bboxFromCorners = (c: CornerCoordinates): BoundingBox =>
  bboxFromLngLats([c.topLeft, c.topRight, c.bottomRight, c.bottomLeft]);

export function isInsideBBox(p: LatLng, b: BoundingBox): boolean {
  return (
    p.latitude >= b.minLat &&
    p.latitude <= b.maxLat &&
    p.longitude >= b.minLng &&
    p.longitude <= b.maxLng
  );
}

/** Expand a bbox by a fractional margin on each side (0.1 = +10%). */
export function padBBox(b: BoundingBox, fraction: number): BoundingBox {
  const dLat = (b.maxLat - b.minLat) * fraction;
  const dLng = (b.maxLng - b.minLng) * fraction;
  return {
    minLat: b.minLat - dLat,
    minLng: b.minLng - dLng,
    maxLat: b.maxLat + dLat,
    maxLng: b.maxLng + dLng,
  };
}

/**
 * The smallest bbox containing every input bbox — e.g. "fit the camera to
 * every trail in the open carousel" needs one bounds spanning all of them,
 * not just the focused one.
 */
export function unionBoundingBoxes(boxes: readonly BoundingBox[]): BoundingBox | undefined {
  if (boxes.length === 0) return undefined;
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const b of boxes) {
    if (b.minLat < minLat) minLat = b.minLat;
    if (b.minLng < minLng) minLng = b.minLng;
    if (b.maxLat > maxLat) maxLat = b.maxLat;
    if (b.maxLng > maxLng) maxLng = b.maxLng;
  }
  return { minLat, minLng, maxLat, maxLng };
}
