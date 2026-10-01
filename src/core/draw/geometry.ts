import type { BoundingBox, LngLat } from '@core/models';
import { haversineM } from '@core/trails/geometry';

/**
 * Geometry for the drawing tools (#502 routes, #503 areas): line length,
 * polygon area and perimeter on the sphere, the midpoint "insert" handles,
 * densification for the saved line, and the self-intersection check that
 * warns about a bow-tie polygon.
 *
 * Pure; coordinates are `[lng, lat]` (GeoJSON order). Rings are passed OPEN
 * (first vertex not repeated) — every function here closes them itself.
 */

/** Mean Earth radius (m), the same one `haversineM` measures with. */
const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;

/** Total length of a polyline, metres. */
export function polylineLengthM(vertices: readonly LngLat[]): number {
  let total = 0;
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1];
    const b = vertices[i];
    if (a !== undefined && b !== undefined) total += haversineM(a, b);
  }
  return total;
}

/** Perimeter of a polygon (closing edge included), metres; 0 under 3 vertices. */
export function polygonPerimeterM(ring: readonly LngLat[]): number {
  if (ring.length < 3) return 0;
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closing = first !== undefined && last !== undefined ? haversineM(last, first) : 0;
  return polylineLengthM(ring) + closing;
}

/**
 * Area of a polygon on the sphere, square metres (always positive; 0 under 3
 * vertices). Chamberlain & Duquette's ring formula ("Some Algorithms for
 * Polygons on a Sphere", JPL 2007) — the one turf.js uses: exact for edges
 * along parallels and well under 0.1 % off for the hectare-to-km² polygons
 * a hiker draws.
 */
export function polygonAreaM2(ring: readonly LngLat[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    sum += (b[0] - a[0]) * DEG * (2 + Math.sin(a[1] * DEG) + Math.sin(b[1] * DEG));
  }
  return Math.abs((sum * EARTH_R * EARTH_R) / 2);
}

/** Great-circle-free midpoint: fine at the scale of one drawn segment. */
export function midpointOf(a: LngLat, b: LngLat): LngLat {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** A handle on a segment's middle; dragging it inserts a vertex at `insertAt`. */
export interface MidpointHandle {
  /** Index the new vertex takes in the vertex list. */
  insertAt: number;
  at: LngLat;
}

/**
 * One handle per segment: between consecutive vertices, plus the closing
 * segment of a polygon (`closed`, ≥ 3 vertices) — whose new vertex goes at
 * the END of the list, between the last vertex and the first.
 */
export function midpointHandles(vertices: readonly LngLat[], closed: boolean): MidpointHandle[] {
  const out: MidpointHandle[] = [];
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1];
    const b = vertices[i];
    if (a !== undefined && b !== undefined) out.push({ insertAt: i, at: midpointOf(a, b) });
  }
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  if (closed && vertices.length >= 3 && first !== undefined && last !== undefined) {
    out.push({ insertAt: vertices.length, at: midpointOf(last, first) });
  }
  return out;
}

/** Bounding box of a set of vertices, or null for none. */
export function boundsOfVertices(vertices: readonly LngLat[]): BoundingBox | null {
  if (vertices.length === 0) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of vertices) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/**
 * The line through `vertices` with extra points every `stepM` metres along
 * each segment. Every vertex is KEPT (unlike `resampleLine`), so the saved
 * line has exactly the corners the user placed — the extra points only exist
 * to carry elevation between them.
 */
export function densifyLine(vertices: readonly LngLat[], stepM: number): LngLat[] {
  const first = vertices[0];
  if (first === undefined) return [];
  const out: LngLat[] = [first];
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1];
    const b = vertices[i];
    if (a === undefined || b === undefined) continue;
    const len = haversineM(a, b);
    const steps = stepM > 0 ? Math.floor(len / stepM) : 0;
    for (let s = 1; s <= steps; s++) {
      const t = (s * stepM) / len;
      // Skip a sample that would land on (or within a metre of) the vertex.
      if (len - s * stepM < 1) break;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(b);
  }
  return out;
}

/** Local planar metres around a reference latitude (a drawn polygon is small). */
function toPlane(p: LngLat, refLat: number): [number, number] {
  return [p[0] * DEG * EARTH_R * Math.cos(refLat * DEG), p[1] * DEG * EARTH_R];
}

function orient(a: [number, number], b: [number, number], c: [number, number]): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
}

function onSegment(a: [number, number], b: [number, number], p: [number, number]): boolean {
  return (
    Math.min(a[0], b[0]) - 1e-9 <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    Math.min(a[1], b[1]) - 1e-9 <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9
  );
}

/** Whether segments ab and cd touch or cross (collinear overlap included). */
export function segmentsIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/**
 * Whether a polygon's edges cross each other (a "bow tie"): its area would be
 * meaningless and many GIS tools reject it, so the editor warns. Adjacent
 * edges share a vertex and are not compared. O(n²) — a hand-drawn polygon
 * has tens of vertices.
 */
export function isSelfIntersecting(ring: readonly LngLat[]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  const refLat = ring[0]?.[1] ?? 0;
  const pts = ring.map((p) => toPlane(p, refLat));
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    for (let j = i + 1; j < n; j++) {
      // Edges i and j are adjacent when they share a vertex.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (c === undefined || d === undefined) continue;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Ray-casting point-in-polygon on lng/lat (the tap test for a drawn area). */
export function pointInRing(point: LngLat, ring: readonly LngLat[]): boolean {
  if (ring.length < 3) return false;
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    const crosses = a[1] > y !== b[1] > y;
    if (crosses && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
