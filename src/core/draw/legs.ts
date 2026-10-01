import type { LngLat, RouteLegMode } from '@core/models';
import { haversineM } from '@core/trails/geometry';

import { polylineLengthM, type MidpointHandle } from './geometry';

/**
 * The legs of a drawn route (#515): the line between two consecutive control
 * points, each made its own way — straight (Freehand) or snapped to the
 * network by the routing proxy (Trails, Roads).
 *
 * A routed leg's geometry is a pure function of (mode, from, to), so results
 * live in a map keyed by exactly that ({@link legKey}). That one choice gives
 * the editor its behaviour for free:
 *
 * - dragging or inserting a point changes only the keys of the legs touching
 *   it, so only those are routed again;
 * - Undo brings back vertex lists whose keys are still in the map, so the
 *   earlier legs reappear at once, without a request;
 * - a failure is a result too (`failed`): the leg falls back to a straight
 *   line with a warning until the user retries ({@link withoutFailures}).
 *
 * Pure; coordinates are `[lng, lat]`.
 */

export type LegMode = RouteLegMode;

export const LEG_MODES: readonly LegMode[] = ['trails', 'roads', 'freehand'];

export const isLegMode = (v: unknown): v is LegMode =>
  v === 'freehand' || v === 'trails' || v === 'roads';

/** Modes whose legs are routed (need the network). */
export const isRoutedMode = (mode: LegMode): boolean => mode !== 'freehand';

/** Why a routed leg fell back to a straight line. */
export type LegFailure = 'offline' | 'no_route' | 'busy' | 'too_long' | 'error';

export type LegResult =
  | {
      status: 'routed';
      coords: readonly LngLat[];
      /** The proxy's credit line for the engine that made it (absent for a seeded leg). */
      attribution?: string;
    }
  | { status: 'failed'; reason: LegFailure };

/** How a leg is shown right now. */
export type LegStatus = 'straight' | 'loading' | 'routed' | 'failed';

export interface LegView {
  index: number;
  mode: LegMode;
  from: LngLat;
  to: LngLat;
  status: LegStatus;
  /** What to draw for this leg: from `from` to `to`, inclusive. */
  coords: readonly LngLat[];
  /** Set when `status` is `failed`. */
  reason?: LegFailure;
  /** Set when `status` is `routed` and the proxy credited an engine. */
  attribution?: string;
}

/** A leg the routing proxy has to answer. */
export interface LegRequest {
  key: string;
  mode: LegMode;
  from: LngLat;
  to: LngLat;
}

const fix6 = (v: number) => v.toFixed(6);

/** The identity of a routed leg: its mode and both ends (to ~0.1 m). */
export function legKey(mode: LegMode, from: LngLat, to: LngLat): string {
  return `${mode}|${fix6(from[0])},${fix6(from[1])}|${fix6(to[0])},${fix6(to[1])}`;
}

/** A routed line's distance to its control point under which they are "the same" point. */
const JOIN_TOLERANCE_M = 1;

/**
 * The routed coordinates tied to the control points: the engine snaps the
 * ends onto the network, so a control point a few metres off a path gets a
 * short connector to it — the line always runs through every point the user
 * placed, and consecutive legs always join.
 */
export function anchorLeg(from: LngLat, routed: readonly LngLat[], to: LngLat): LngLat[] {
  const out: LngLat[] = [from];
  for (const p of routed) {
    const last = out[out.length - 1];
    if (last === undefined || haversineM(last, p) >= JOIN_TOLERANCE_M) out.push(p);
  }
  const last = out[out.length - 1];
  if (last !== undefined && out.length > 1 && haversineM(last, to) < JOIN_TOLERANCE_M) out.pop();
  out.push(to);
  return out;
}

/**
 * Every leg of `vertices` as it should be drawn: routed ones from `results`,
 * the rest straight — `loading` while an answer is awaited, `failed` when
 * it could not be had. `modes[i]` is the leg from vertex i to i+1; a missing
 * mode reads as Freehand.
 */
export function legViews(
  vertices: readonly LngLat[],
  modes: readonly LegMode[],
  results: ReadonlyMap<string, LegResult>,
): LegView[] {
  const views: LegView[] = [];
  for (let i = 0; i + 1 < vertices.length; i++) {
    const from = vertices[i];
    const to = vertices[i + 1];
    if (from === undefined || to === undefined) continue;
    const mode = modes[i] ?? 'freehand';
    const straight = [from, to];
    if (!isRoutedMode(mode)) {
      views.push({ index: i, mode, from, to, status: 'straight', coords: straight });
      continue;
    }
    const result = results.get(legKey(mode, from, to));
    if (result === undefined) {
      views.push({ index: i, mode, from, to, status: 'loading', coords: straight });
    } else if (result.status === 'failed') {
      views.push({
        index: i,
        mode,
        from,
        to,
        status: 'failed',
        coords: straight,
        reason: result.reason,
      });
    } else {
      views.push({
        index: i,
        mode,
        from,
        to,
        status: 'routed',
        coords: anchorLeg(from, result.coords, to),
        ...(result.attribution !== undefined ? { attribution: result.attribution } : {}),
      });
    }
  }
  return views;
}

/** The legs still waiting for the routing proxy, deduplicated by key. */
export function pendingLegs(views: readonly LegView[]): LegRequest[] {
  const seen = new Set<string>();
  const out: LegRequest[] = [];
  for (const v of views) {
    if (v.status !== 'loading') continue;
    const key = legKey(v.mode, v.from, v.to);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, mode: v.mode, from: v.from, to: v.to });
  }
  return out;
}

/** The whole route as one polyline: the legs end to end, each joint once. */
export function mergeLegs(views: readonly LegView[]): LngLat[] {
  const out: LngLat[] = [];
  for (const v of views) {
    v.coords.forEach((p, i) => {
      if (i === 0 && out.length > 0) return; // the previous leg's last point
      out.push(p);
    });
  }
  return out;
}

/** The route's length, metres, along what is drawn (routed or straight). */
export function routeLengthM(views: readonly LegView[]): number {
  return views.reduce((sum, v) => sum + polylineLengthM(v.coords), 0);
}

/** The point halfway along a polyline (by length). */
export function halfwayAlong(line: readonly LngLat[]): LngLat | null {
  const first = line[0];
  if (first === undefined) return null;
  const half = polylineLengthM(line) / 2;
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    if (a === undefined || b === undefined) continue;
    const d = haversineM(a, b);
    if (walked + d >= half && d > 0) {
      const t = (half - walked) / d;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    walked += d;
  }
  return first;
}

/**
 * The "insert a point" handles of a route, ON the line drawn: halfway along
 * each leg, so a routed leg's handle sits on the trail, not off in the woods
 * where the straight chord's middle would be.
 */
export function legMidpointHandles(views: readonly LegView[]): MidpointHandle[] {
  const out: MidpointHandle[] = [];
  for (const v of views) {
    const at = halfwayAlong(v.coords);
    if (at !== null) out.push({ at, insertAt: v.index + 1 });
  }
  return out;
}

/** The failed legs, for the warning icons and the "Retry" notice. */
export const failedLegs = (views: readonly LegView[]): LegView[] =>
  views.filter((v) => v.status === 'failed');

/** The results without the failures of `views` (Retry: they will be asked again). */
export function withoutFailures(
  results: ReadonlyMap<string, LegResult>,
  views: readonly LegView[],
): Map<string, LegResult> {
  const next = new Map(results);
  for (const v of failedLegs(views)) next.delete(legKey(v.mode, v.from, v.to));
  return next;
}

/** Keep the newest `max` results (Map order = insertion order): undo depth, bounded memory. */
export function capResults(
  results: ReadonlyMap<string, LegResult>,
  max: number,
): Map<string, LegResult> {
  const entries = [...results.entries()];
  return new Map(entries.length > max ? entries.slice(entries.length - max) : entries);
}

/** Index of the line coordinate closest to `p`, searching `line[from..]`. */
function nearestIndex(line: readonly LngLat[], p: LngLat, from: number): number {
  let best = from;
  let bestD = Infinity;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === undefined) continue;
    const d = haversineM(c, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Results for a saved route's routed legs, cut from its saved line ("Edit
 * route" reopens offline without straightening every leg): the line is split
 * at the coordinate nearest each control point, in order.
 */
export function seedResultsFromLine(
  line: readonly LngLat[],
  vertices: readonly LngLat[],
  modes: readonly LegMode[],
): Map<string, LegResult> {
  const results = new Map<string, LegResult>();
  if (line.length < 2 || vertices.length < 2) return results;
  const cuts: number[] = [0];
  for (let i = 1; i < vertices.length - 1; i++) {
    const v = vertices[i];
    const prev = cuts[cuts.length - 1] ?? 0;
    cuts.push(v === undefined ? prev : nearestIndex(line, v, prev));
  }
  cuts.push(line.length - 1);
  for (let i = 0; i + 1 < vertices.length; i++) {
    const mode = modes[i] ?? 'freehand';
    const from = vertices[i];
    const to = vertices[i + 1];
    const start = cuts[i];
    const end = cuts[i + 1];
    if (!isRoutedMode(mode) || from === undefined || to === undefined) continue;
    if (start === undefined || end === undefined || end <= start) continue;
    results.set(legKey(mode, from, to), {
      status: 'routed',
      coords: line.slice(start, end + 1),
    });
  }
  return results;
}

/** The per-leg modes, made the right length for `vertexCount` (missing = `fill`). */
export function fitModes(
  modes: readonly unknown[] | undefined,
  vertexCount: number,
  fill: LegMode = 'freehand',
): LegMode[] {
  const n = Math.max(0, vertexCount - 1);
  return Array.from({ length: n }, (_, i) => {
    const m = modes?.[i];
    return isLegMode(m) ? m : fill;
  });
}

/**
 * The routing engines to credit for the legs shown ("BRouter", "Valhalla
 * (FOSSGIS)"), from the proxy's attribution lines with the OSM part (shown
 * once by the caller) taken out; null when no leg is routed.
 */
export function routingEngines(views: readonly LegView[]): string[] | null {
  const routed = views.filter((v) => v.status === 'routed');
  if (routed.length === 0) return null;
  const engines = new Set<string>();
  for (const v of routed) {
    const name = v.attribution
      ?.replace(/©\s*OpenStreetMap contributors/i, '')
      .replace(/^[\s·]+|[\s·]+$/g, '')
      .replace(/^routing\s+/i, '')
      .trim();
    if (name) engines.add(name);
  }
  return [...engines];
}
