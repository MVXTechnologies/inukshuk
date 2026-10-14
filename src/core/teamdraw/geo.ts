import { haversineM } from '@core/trails/geometry';

/**
 * Geometry for team drawings (#683): extents, bearings, circle polygons,
 * Douglas–Peucker simplification and the screen scale at a zoom. Points are
 * `[lng, lat]`. Shapes are at most 50 km across, so a local equirectangular
 * projection around the shape is metre-accurate and cheap.
 */
export type Pt = [number, number];

export { haversineM };

const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;

/** A longitude moved by whole turns to within 180° of `ref` (antimeridian-safe). */
export function unwrapLng(lng: number, ref: number): number {
  let out = lng;
  while (out - ref > 180) out -= 360;
  while (out - ref < -180) out += 360;
  return out;
}

const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;

/** The diagonal of a set of points' bounding box, in metres (antimeridian-safe). */
export function extentM(pts: readonly Pt[]): number {
  const first = pts[0];
  if (first === undefined) return 0;
  let minLng = first[0];
  let maxLng = first[0];
  let minLat = first[1];
  let maxLat = first[1];
  for (const [lng0, lat] of pts) {
    const lng = unwrapLng(lng0, first[0]);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return haversineM([minLng, minLat], [maxLng, maxLat]);
}

/** Initial bearing from `a` to `b`, degrees clockwise from north in [0, 360). */
export function bearingDeg(a: Pt, b: Pt): number {
  const p1 = a[1] * DEG;
  const p2 = b[1] * DEG;
  const dl = (b[0] - a[0]) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
}

/** The point `distM` from `p` on bearing `deg` (great circle). */
export function destination(p: Pt, deg: number, distM: number): Pt {
  const d = distM / EARTH_R;
  const t = deg * DEG;
  const p1 = p[1] * DEG;
  const l1 = p[0] * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 =
    l1 +
    Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [wrapLng(l2 / DEG), p2 / DEG];
}

/** A closed ring of `sides` vertices (first = last) approximating a circle. */
export function circleRing(centre: Pt, radiusM: number, sides = 64): Pt[] {
  const ring: Pt[] = [];
  for (let i = 0; i < sides; i++) ring.push(destination(centre, (360 * i) / sides, radiusM));
  ring.push(ring[0]!);
  return ring;
}

/** Length of a polyline in metres. */
export function lengthM(pts: readonly Pt[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += haversineM(pts[i - 1]!, pts[i]!);
  return total;
}

/**
 * Douglas–Peucker with a tolerance in metres (iterative: a 10 000-point
 * stroke never recurses). Keeps the first and last points; returns a new array.
 */
export function simplify(pts: readonly Pt[], toleranceM: number): Pt[] {
  if (pts.length <= 2 || !(toleranceM > 0)) return pts.map((p) => [p[0], p[1]]);
  const ref = pts[0]!;
  const kx = EARTH_R * DEG * Math.cos(ref[1] * DEG);
  const ky = EARTH_R * DEG;
  const xy = pts.map(([lng, lat]) => [unwrapLng(lng, ref[0]) * kx, lat * ky] as const);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tol2 = toleranceM * toleranceM;
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = xy[i]!;
    const [bx, by] = xy[j]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = xy[k]!;
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d2 = ex * ex + ey * ey;
      if (d2 > worst) {
        worst = d2;
        at = k;
      }
    }
    if (at >= 0 && worst > tol2) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k] === 1).map((p) => [p[0], p[1]]);
}

/**
 * Ground metres per screen dp at `zoom` and latitude `lat` (MapLibre: 512 dp
 * tiles, Web Mercator).
 */
export function metresPerDp(zoom: number, lat: number): number {
  return (78271.51696 * Math.cos(lat * DEG)) / 2 ** zoom;
}
