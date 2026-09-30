import type { BoundingBox, LngLat } from '@core/models';

import type { TrailBbox } from './schema';

/**
 * Line geometry for the long-distance trails (#467): lengths, the distance
 * from a point to a trail, resampling, bbox conversions and the thumbnail
 * path. Distances use a local equirectangular projection around the query
 * point — metres-accurate at trail scale and far cheaper than haversine per
 * segment, which matters when ranking thousands of index rows.
 */

const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;

export function haversineM(a: LngLat, b: LngLat): number {
  const p1 = a[1] * DEG;
  const p2 = b[1] * DEG;
  const dp = p2 - p1;
  const dl = (b[0] - a[0]) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLengthM(parts: readonly (readonly LngLat[])[]): number {
  let total = 0;
  for (const part of parts) {
    for (let i = 1; i < part.length; i++) {
      const a = part[i - 1];
      const b = part[i];
      if (a !== undefined && b !== undefined) total += haversineM(a, b);
    }
  }
  return total;
}

export interface NearestOnLine {
  distanceM: number;
  point: LngLat;
  /** Index of the part and of the segment's first vertex. */
  part: number;
  segment: number;
}

/** The point of `parts` nearest to `p`, or null for an empty line. */
export function nearestOnLine(
  p: LngLat,
  parts: readonly (readonly LngLat[])[],
): NearestOnLine | null {
  const kx = Math.cos(p[1] * DEG) * EARTH_R * DEG;
  const ky = EARTH_R * DEG;
  let best: NearestOnLine | null = null;
  let bestD2 = Infinity;
  parts.forEach((part, pi) => {
    if (part.length === 1) {
      const only = part[0];
      if (only === undefined) return;
      const dx = (only[0] - p[0]) * kx;
      const dy = (only[1] - p[1]) * ky;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { distanceM: 0, point: only, part: pi, segment: 0 };
      }
      return;
    }
    for (let i = 1; i < part.length; i++) {
      const a = part[i - 1];
      const b = part[i];
      if (a === undefined || b === undefined) continue;
      const ax = (a[0] - p[0]) * kx;
      const ay = (a[1] - p[1]) * ky;
      const bx = (b[0] - p[0]) * kx;
      const by = (b[1] - p[1]) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const d2 = cx * cx + cy * cy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = {
          distanceM: 0,
          point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
          part: pi,
          segment: i - 1,
        };
      }
    }
  });
  if (best === null) return null;
  return { ...(best as NearestOnLine), distanceM: Math.sqrt(bestD2) };
}

/** Distance from `p` to the line, metres (Infinity for an empty line). */
export function distanceToLineM(p: LngLat, parts: readonly (readonly LngLat[])[]): number {
  return nearestOnLine(p, parts)?.distanceM ?? Infinity;
}

/** Distance from `p` to a bbox (0 inside), metres — a lower bound for the trail inside it. */
export function distanceToBboxM(p: LngLat, bbox: TrailBbox): number {
  const [w, s, e, n] = bbox;
  const lon = Math.max(w, Math.min(e, p[0]));
  const lat = Math.max(s, Math.min(n, p[1]));
  if (lon === p[0] && lat === p[1]) return 0;
  return haversineM(p, [lon, lat]);
}

export const toBoundingBox = (b: TrailBbox): BoundingBox => ({
  minLng: b[0],
  minLat: b[1],
  maxLng: b[2],
  maxLat: b[3],
});

export function bboxOfLine(parts: readonly (readonly LngLat[])[]): TrailBbox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const part of parts) {
    for (const [lon, lat] of part) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/**
 * Points every `stepM` metres along each part (the vertices' own positions
 * are not kept — the samples are evenly spaced), each part's last vertex
 * always included. The climb computation samples the DEM at these.
 */
export function resampleLine(parts: readonly (readonly LngLat[])[], stepM: number): LngLat[][] {
  const out: LngLat[][] = [];
  const step = Math.max(1, stepM);
  for (const part of parts) {
    const first = part[0];
    if (first === undefined) continue;
    const samples: LngLat[] = [first];
    let carry = 0;
    for (let i = 1; i < part.length; i++) {
      const a = part[i - 1];
      const b = part[i];
      if (a === undefined || b === undefined) continue;
      const d = haversineM(a, b);
      let at = step - carry;
      while (at <= d) {
        const t = at / d;
        samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        at += step;
      }
      carry = d - (at - step);
    }
    const last = part[part.length - 1];
    const tail = samples[samples.length - 1];
    if (last !== undefined && tail !== undefined && (tail[0] !== last[0] || tail[1] !== last[1])) {
      samples.push(last);
    }
    out.push(samples);
  }
  return out;
}

/**
 * SVG path data for a thumbnail of `parts` fitted into `width × height` px
 * (minus `padding`), aspect-correct (x scaled by cos φ), centred. Empty
 * string for an empty line.
 */
export function thumbnailPath(
  parts: readonly (readonly LngLat[])[],
  width: number,
  height: number,
  padding: number,
): { d: string; start: [number, number] | null; end: [number, number] | null } {
  const bbox = bboxOfLine(parts);
  if (bbox === null) return { d: '', start: null, end: null };
  const [w, s, e, n] = bbox;
  const k = Math.cos(((s + n) / 2) * DEG);
  const spanX = Math.max((e - w) * k, 1e-9);
  const spanY = Math.max(n - s, 1e-9);
  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const ox = padding + (innerW - spanX * scale) / 2;
  const oy = padding + (innerH - spanY * scale) / 2;
  const project = ([lon, lat]: LngLat): [number, number] => [
    ox + (lon - w) * k * scale,
    oy + (n - lat) * scale,
  ];
  const r = (v: number) => Math.round(v * 10) / 10;
  let d = '';
  let start: [number, number] | null = null;
  let end: [number, number] | null = null;
  for (const part of parts) {
    part.forEach((pt, i) => {
      const [x, y] = project(pt);
      d += `${i === 0 ? 'M' : 'L'}${r(x)} ${r(y)} `;
      if (start === null) start = [r(x), r(y)];
      end = [r(x), r(y)];
    });
  }
  return { d: d.trim(), start, end };
}
