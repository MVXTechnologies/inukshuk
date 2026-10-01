import type { LngLat } from '@core/models';

import type { LegFailure, LegMode, LegResult } from './legs';

/**
 * The app's half of the route-snapping protocol (#515): what a leg asks our
 * Worker's `POST /route` (`infra/tiles/worker/src/route.ts`), and how its
 * answer — a GeoJSON LineString, or `{code, message}` — becomes a leg result.
 *
 * One request per leg (two points): the editor routes each leg on its own so
 * an edit re-routes only the legs it touched, and the Worker caches each leg.
 */

export type RoutingProfile = 'hike' | 'foot' | 'bike' | 'car';

/** Trails = hiking paths (BRouter's hiking profile); Roads = walkable streets (Valhalla pedestrian). */
export const PROFILE_FOR_MODE: Record<Exclude<LegMode, 'freehand'>, RoutingProfile> = {
  trails: 'hike',
  roads: 'foot',
};

export interface RouteRequestBody {
  mode: 'trail' | 'road';
  profile: RoutingProfile;
  points: [number, number][];
}

/** The body for one leg; null for a Freehand leg (never routed). */
export function routeRequestBody(mode: LegMode, from: LngLat, to: LngLat): RouteRequestBody | null {
  if (mode === 'freehand') return null;
  return {
    mode: mode === 'trails' ? 'trail' : 'road',
    profile: PROFILE_FOR_MODE[mode],
    points: [
      [from[0], from[1]],
      [to[0], to[1]],
    ],
  };
}

const FAILURE_BY_CODE: Record<string, LegFailure> = {
  no_route: 'no_route',
  too_long: 'too_long',
  rate_limited: 'busy',
  busy: 'busy',
};

/** A proxy answer (HTTP status + parsed JSON, or null when unreadable) as a leg result. */
export function legResultFromResponse(status: number, body: unknown): LegResult {
  if (status === 200) {
    const coords = (body as { geometry?: { coordinates?: unknown } } | null)?.geometry?.coordinates;
    if (Array.isArray(coords)) {
      const line: LngLat[] = [];
      for (const c of coords) {
        if (
          Array.isArray(c) &&
          typeof c[0] === 'number' &&
          typeof c[1] === 'number' &&
          Number.isFinite(c[0]) &&
          Number.isFinite(c[1])
        ) {
          line.push([c[0], c[1]]);
        }
      }
      const attribution = (body as { properties?: { attribution?: unknown } }).properties
        ?.attribution;
      if (line.length >= 2) {
        return typeof attribution === 'string'
          ? { status: 'routed', coords: line, attribution }
          : { status: 'routed', coords: line };
      }
    }
    return { status: 'failed', reason: 'error' };
  }
  const code = (body as { code?: unknown } | null)?.code;
  const reason = typeof code === 'string' ? FAILURE_BY_CODE[code] : undefined;
  if (reason !== undefined) return { status: 'failed', reason };
  if (status === 429 || status === 503) return { status: 'failed', reason: 'busy' };
  return { status: 'failed', reason: 'error' };
}

/** What the panel says about failed legs ("2 legs drawn straight — offline"). */
export function failureNotice(reasons: readonly LegFailure[]): string | null {
  const n = reasons.length;
  if (n === 0) return null;
  const legs = n === 1 ? 'One leg' : `${n} legs`;
  const why = reasons.every((r) => r === 'offline')
    ? 'no connection'
    : reasons.every((r) => r === 'no_route')
      ? 'no trail or road found'
      : reasons.every((r) => r === 'busy')
        ? 'routing is busy'
        : reasons.every((r) => r === 'too_long')
          ? 'too long to snap'
          : 'routing failed';
  return `${legs} drawn straight (${why})`;
}
