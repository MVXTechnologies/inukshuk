import { pointInRing, polygonAreaM2 } from '@core/draw/geometry';
import type { Units } from '@core/format';
import { formatAreaSize } from '@core/library/areas';
import { compactDistance, shortDate } from '@core/library/libraryRows';
import type { LngLat } from '@core/models';

/**
 * What a map tap means when trails and drawn areas overlap under the finger
 * (#745). Pure: MapScreen hands it the tap, the finger's width in metres at
 * the current zoom, the candidate trails (from the heat grid's coarse
 * lookup, with their geometry when it is loaded) and the shown areas.
 *
 * - A trail competes only when its line passes within the finger's width
 *   (zoom-aware: a few metres at street zoom, kilometres over a region),
 *   never the grid's fixed ±50 m window: a tap in the open part of a large
 *   area, away from any line, is the area.
 * - An area competes when the tap is inside it, or on its outline.
 * - One candidate selects it; two or more open the chooser, so a larger
 *   area behind a smaller one, or one of two crossing trails, is reachable.
 */

export interface TrailCandidate {
  id: string;
  /**
   * The trail's line parts, or null when its geometry is not loaded (a heat
   * line whose trace is hidden): the coarse lookup's word is kept then.
   */
  parts: readonly (readonly LngLat[])[] | null;
}

export interface AreaCandidate {
  id: string;
  ring: readonly LngLat[];
}

export type OverlapHit =
  { kind: 'trail'; id: string; distanceM: number } | { kind: 'area'; id: string; sizeM2: number };

export type OverlapPick =
  { kind: 'none' } | { kind: 'one'; hit: OverlapHit } | { kind: 'choose'; hits: OverlapHit[] };

const M_PER_DEG_LAT = 111_320;

/** Metres from `p` to the segment a–b (equirectangular around `p`: exact enough at finger scale). */
function segmentDistanceM(p: LngLat, a: LngLat, b: LngLat, mPerDegLng: number): number {
  const ax = (a[0] - p[0]) * mPerDegLng;
  const ay = (a[1] - p[1]) * M_PER_DEG_LAT;
  const bx = (b[0] - p[0]) * mPerDegLng;
  const by = (b[1] - p[1]) * M_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Metres from `p` to the nearest point of a polyline (Infinity for an empty one). */
export function distanceToLineM(p: LngLat, line: readonly LngLat[], closed = false): number {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((p[1] * Math.PI) / 180);
  let best = Infinity;
  const n = line.length;
  if (n === 1) {
    const only = line[0]!;
    return segmentDistanceM(p, only, only, mPerDegLng);
  }
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = line[i];
    const b = line[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    const d = segmentDistanceM(p, a, b, mPerDegLng);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Everything under the finger: trails within `toleranceM` (nearest first),
 * then areas holding the tap or with their outline within reach (smallest
 * first: the one drawn on top reads first).
 */
export function overlapHits(
  at: LngLat,
  toleranceM: number,
  trails: readonly TrailCandidate[],
  areas: readonly AreaCandidate[],
): OverlapHit[] {
  const reach = Number.isFinite(toleranceM) && toleranceM > 0 ? toleranceM : 0;
  const trailHits: Extract<OverlapHit, { kind: 'trail' }>[] = [];
  const seen = new Set<string>();
  for (const t of trails) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (t.parts === null) {
      trailHits.push({ kind: 'trail', id: t.id, distanceM: reach });
      continue;
    }
    let d = Infinity;
    for (const part of t.parts) d = Math.min(d, distanceToLineM(at, part));
    if (d <= reach) trailHits.push({ kind: 'trail', id: t.id, distanceM: d });
  }
  trailHits.sort((a, b) => a.distanceM - b.distanceM);

  const areaHits: Extract<OverlapHit, { kind: 'area' }>[] = [];
  for (const a of areas) {
    if (a.ring.length < 3) continue;
    const inside = pointInRing(at, a.ring);
    if (!inside && distanceToLineM(at, a.ring, true) > reach) continue;
    areaHits.push({ kind: 'area', id: a.id, sizeM2: polygonAreaM2(a.ring) });
  }
  areaHits.sort((a, b) => a.sizeM2 - b.sizeM2);
  return [...trailHits, ...areaHits];
}

/** None, the one thing under the finger, or a choice between several. */
export function pickOverlap(hits: readonly OverlapHit[]): OverlapPick {
  const first = hits[0];
  if (first === undefined) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'one', hit: first };
  return { kind: 'choose', hits: [...hits] };
}

/** A hit's stable key (chooser rows, tests). */
export function overlapKey(hit: Pick<OverlapHit, 'kind' | 'id'>): string {
  return `${hit.kind}:${hit.id}`;
}

/** What a chooser row says under its name. */
export type OverlapRowInput =
  | {
      kind: 'trail';
      /** The activity's name ("Hike"), or null when uncategorized. */
      typeName: string | null;
      /** A drawn route (#502) rather than a recording. */
      planned: boolean;
      distanceM: number;
      /** 0 = untimed (no date shown). */
      startedAt: number;
    }
  | { kind: 'area'; sizeM2: number };

/** "Hike · 12.4 km · Oct 12" / "Route · 8.2 km" / "Area · 2.4 km²". */
export function overlapRowSubtitle(row: OverlapRowInput, units: Units, nowMs: number): string {
  if (row.kind === 'area') return `Area · ${formatAreaSize(row.sizeM2, units)}`;
  const kind = row.typeName ?? (row.planned ? 'Route' : 'Trail');
  return [
    kind,
    compactDistance(row.distanceM, units),
    row.startedAt > 0 ? shortDate(row.startedAt, nowMs) : null,
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
}
