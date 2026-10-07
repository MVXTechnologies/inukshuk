/**
 * Route snapping proxy: `POST /route` turns the points a user tapped in the
 * app's route-drawing tool into a line that follows real trails or roads.
 *
 *   POST /route
 *   { "mode": "trail" | "road", "profile"?: "hike" | "foot" | "bike" | "car",
 *     "points": [[lon, lat], …] }                       (2–25 points)
 *
 *   200 { "type": "Feature",
 *         "geometry": { "type": "LineString", "coordinates": [[lon, lat, ele?], …] },
 *         "properties": { mode, profile, engine, distanceM, ascentM, descentM,
 *                         legs: [{ start, end, distanceM, ascentM, descentM }],
 *                         attribution } }
 *   4xx/5xx { "code": "bad_request" | "no_route" | "too_long" | "rate_limited"
 *                     | "busy" | "upstream" | "timeout", "message": "…" }
 *
 * `legs[i]` spans `coordinates[start..end]` (inclusive) between points i and
 * i+1. `ascentM`/`descentM` are null when the engine gave no elevation.
 *
 * Engines (each mode picks one by env var, so the NAS router can take over
 * without an app update):
 *
 * - **BRouter** (`TRAIL_ENGINE`, default; `BROUTER_URL`, default the public
 *   https://brouter.de/brouter). Best at footpaths; returns 3D coordinates.
 *   The public server has no written API policy — a hobby server that kills
 *   concurrent sessions — so it is used gently: cached, rate-limited, paced.
 * - **Valhalla** (`ROAD_ENGINE`, default; `VALHALLA_URL`, default the FOSSGIS
 *   https://valhalla1.openstreetmap.de). FOSSGIS's terms allow apps at low
 *   volume with an identifying User-Agent, OSM attribution, at most one
 *   request per second, and URLs not hard-coded in the app (they live here).
 *
 * Fair use: one edge cache shared by every phone (7 days per exact request),
 * a per-IP limit on cache misses, and per-isolate pacing of upstream calls
 * (one per second per engine; a caller who would wait longer gets 503).
 *
 * Written against the standard fetch API with its platform pieces injected,
 * so it is unit-tested in Node (`route.test.ts`).
 */

import { readTextCapped } from './guards';

export type RouteMode = 'trail' | 'road';
export type RouteProfile = 'hike' | 'foot' | 'bike' | 'car';
export type RouteEngine = 'brouter' | 'valhalla';

export interface RouteEnv {
  /** BRouter endpoint (the `/brouter` servlet). */
  BROUTER_URL?: string;
  /** Valhalla base URL (`/route` is appended). */
  VALHALLA_URL?: string;
  /** Engine for each mode: "brouter" or "valhalla". */
  TRAIL_ENGINE?: string;
  ROAD_ENGINE?: string;
  /** Override BRouter profile names: "hike=hiking-mountain,bike=trekking". */
  BROUTER_PROFILES?: string;
  /** Edge + client cache lifetime of a routed answer. Default 7 days. */
  ROUTE_CACHE_CONTROL?: string;
  /** Upstream requests per minute per client IP (in-isolate limiter). Default 30. */
  ROUTE_RATE_PER_MIN?: string;
  /** Minimum gap between upstream calls per engine, per isolate. Default 1000 ms. */
  ROUTE_UPSTREAM_INTERVAL_MS?: string;
  /** Optional global rate-limiting binding (`[[ratelimits]]`). */
  ROUTE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export interface RouteDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  cache: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
  waitUntil: (promise: Promise<unknown>) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_BROUTER_URL = 'https://brouter.de/brouter';
export const DEFAULT_VALHALLA_URL = 'https://valhalla1.openstreetmap.de';
export const ROUTE_USER_AGENT =
  'Inukshuk-TrailApp/1.0 (route proxy; https://github.com/MVXTechnologies/inukshuk)';
export const MAX_ROUTE_POINTS = 25;
/** Straight-line span (sum of legs) above which a request is refused: 100 km. */
export const MAX_ROUTE_SPAN_M = 100_000;
const MAX_BODY_BYTES = 8_192;
const DEFAULT_CACHE_CONTROL = 'public, max-age=604800';
const DEFAULT_RATE_PER_MIN = 30;
const DEFAULT_INTERVAL_MS = 1_000;
/** Longest a request may queue behind others for its upstream slot. */
const MAX_QUEUE_MS = 3_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
/** Bump to stop reusing cached answers. */
const ROUTE_CACHE_VERSION = '1';
/** Elevation changes smaller than this are noise, not climb. */
const CLIMB_HYSTERESIS_M = 3;

const PROFILES: readonly RouteProfile[] = ['hike', 'foot', 'bike', 'car'];
const DEFAULT_PROFILE: Record<RouteMode, RouteProfile> = { trail: 'hike', road: 'foot' };

const BROUTER_PROFILES: Record<RouteProfile, string> = {
  hike: 'hiking-mountain',
  foot: 'hiking-mountain',
  bike: 'trekking',
  car: 'car-fast',
};
const VALHALLA_COSTING: Record<RouteProfile, string> = {
  hike: 'pedestrian',
  foot: 'pedestrian',
  bike: 'bicycle',
  car: 'auto',
};

export interface RouteRequest {
  mode: RouteMode;
  profile: RouteProfile;
  /** `[lon, lat]`, rounded to 1e-5° (~1 m). */
  points: [number, number][];
}

export interface RouteLeg {
  start: number;
  end: number;
  distanceM: number;
  ascentM: number | null;
  descentM: number | null;
}

export interface RouteFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: number[][] };
  properties: {
    mode: RouteMode;
    profile: RouteProfile;
    engine: RouteEngine;
    distanceM: number;
    ascentM: number | null;
    descentM: number | null;
    legs: RouteLeg[];
    attribution: string;
  };
}

export type RouteErrorCode =
  'bad_request' | 'no_route' | 'too_long' | 'rate_limited' | 'busy' | 'upstream' | 'timeout';

export class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: RouteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Haversine metres between two `[lon, lat]`. */
export function distanceM(a: readonly number[], b: readonly number[]): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const [lon1 = 0, lat1 = 0] = a;
  const [lon2 = 0, lat2 = 0] = b;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLengthM(coords: readonly number[][], start = 0, end = coords.length - 1): number {
  let sum = 0;
  for (let i = start + 1; i <= end; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    if (a && b) sum += distanceM(a, b);
  }
  return sum;
}

/** Ascent and descent of an elevation series, ignoring wiggles under the hysteresis. */
export function climbOf(elevations: readonly number[]): { ascentM: number; descentM: number } {
  let ascentM = 0;
  let descentM = 0;
  let ref: number | undefined;
  for (const e of elevations) {
    if (!Number.isFinite(e)) continue;
    if (ref === undefined) {
      ref = e;
      continue;
    }
    const d = e - ref;
    if (d >= CLIMB_HYSTERESIS_M) {
      ascentM += d;
      ref = e;
    } else if (d <= -CLIMB_HYSTERESIS_M) {
      descentM -= d;
      ref = e;
    }
  }
  return { ascentM: Math.round(ascentM), descentM: Math.round(descentM) };
}

/** Validate a request body; throws a 400/422 RouteError. */
export function parseRouteRequest(body: unknown): RouteRequest {
  const bad = (m: string) => new RouteError(400, 'bad_request', m);
  if (typeof body !== 'object' || body === null) throw bad('body must be a JSON object');
  const { mode, profile, points } = body as Record<string, unknown>;
  if (mode !== 'trail' && mode !== 'road') throw bad('mode must be "trail" or "road"');
  if (profile !== undefined && !PROFILES.includes(profile as RouteProfile)) {
    throw bad(`profile must be one of ${PROFILES.join(', ')}`);
  }
  if (!Array.isArray(points) || points.length < 2) throw bad('points needs at least 2 [lon, lat]');
  if (points.length > MAX_ROUTE_POINTS) throw bad(`at most ${MAX_ROUTE_POINTS} points`);
  const clean = points.map((p) => {
    if (
      !Array.isArray(p) ||
      typeof p[0] !== 'number' ||
      typeof p[1] !== 'number' ||
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1]) ||
      Math.abs(p[0]) > 180 ||
      Math.abs(p[1]) > 90
    ) {
      throw bad('each point must be [lon, lat]');
    }
    return [round5(p[0]), round5(p[1])] as [number, number];
  });
  if (lineLengthM(clean) > MAX_ROUTE_SPAN_M) {
    throw new RouteError(422, 'too_long', 'route is too long to snap (100 km at most)');
  }
  return {
    mode,
    profile: (profile as RouteProfile | undefined) ?? DEFAULT_PROFILE[mode],
    points: clean,
  };
}

export function engineFor(env: RouteEnv, mode: RouteMode): RouteEngine {
  const raw = (mode === 'trail' ? env.TRAIL_ENGINE : env.ROAD_ENGINE)?.trim().toLowerCase();
  if (raw === 'brouter' || raw === 'valhalla') return raw;
  return mode === 'trail' ? 'brouter' : 'valhalla';
}

export function brouterProfile(env: RouteEnv, profile: RouteProfile): string {
  for (const pair of (env.BROUTER_PROFILES ?? '').split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (k === profile && v) return v;
  }
  return BROUTER_PROFILES[profile];
}

/** The upstream request for one engine. */
export function upstreamRequest(
  env: RouteEnv,
  engine: RouteEngine,
  req: RouteRequest,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    'User-Agent': ROUTE_USER_AGENT,
    Accept: 'application/json',
  };
  if (engine === 'brouter') {
    const u = new URL(env.BROUTER_URL ?? DEFAULT_BROUTER_URL);
    u.searchParams.set('lonlats', req.points.map(([lon, lat]) => `${lon},${lat}`).join('|'));
    u.searchParams.set('profile', brouterProfile(env, req.profile));
    u.searchParams.set('alternativeidx', '0');
    u.searchParams.set('format', 'geojson');
    return { url: u.toString(), init: { headers } };
  }
  const base = (env.VALHALLA_URL ?? DEFAULT_VALHALLA_URL).replace(/\/+$/, '');
  return {
    url: `${base}/route`,
    init: {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: req.points.map(([lon, lat]) => ({ lon, lat, type: 'break' })),
        costing: VALHALLA_COSTING[req.profile],
        directions_type: 'none',
        elevation_interval: 30,
        shape_format: 'polyline6',
      }),
    },
  };
}

/** Decode a Valhalla polyline (precision 6) into `[lon, lat]`. */
export function decodePolyline6(encoded: string): number[][] {
  const out: number[][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    out.push([round6(lon / 1e6), round6(lat / 1e6)]);
  }
  return out;
}

const attributionFor = (engine: RouteEngine) =>
  engine === 'brouter'
    ? '© OpenStreetMap contributors · routing BRouter'
    : '© OpenStreetMap contributors · routing Valhalla (FOSSGIS)';

/** Index of the coordinate closest to `p`, searching `coords[from..]`. */
function nearestIndex(coords: readonly number[][], p: readonly number[], from: number): number {
  let best = from;
  let bestD = Infinity;
  for (let i = from; i < coords.length; i++) {
    const c = coords[i];
    if (!c) continue;
    const d = distanceM(c, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function finish(
  req: RouteRequest,
  engine: RouteEngine,
  coordinates: number[][],
  legs: RouteLeg[],
  distance: number,
  climb: { ascentM: number; descentM: number } | null,
): RouteFeature {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: {
      mode: req.mode,
      profile: req.profile,
      engine,
      distanceM: Math.round(distance),
      ascentM: climb?.ascentM ?? null,
      descentM: climb?.descentM ?? null,
      legs,
      attribution: attributionFor(engine),
    },
  };
}

/** BRouter's GeoJSON (one line through every via point) → our Feature. */
export function normalizeBrouter(req: RouteRequest, body: unknown): RouteFeature {
  const feature = (body as { features?: { geometry?: { coordinates?: unknown } }[] })
    ?.features?.[0];
  const raw = feature?.geometry?.coordinates;
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new RouteError(502, 'upstream', 'routing engine answered without a line');
  }
  const coordinates = (raw as number[][]).map((c) => {
    const lon = round6(Number(c[0]));
    const lat = round6(Number(c[1]));
    return typeof c[2] === 'number' && Number.isFinite(c[2])
      ? [lon, lat, round1(c[2])]
      : [lon, lat];
  });
  const hasEle = coordinates.every((c) => c.length === 3);
  const elevationsOf = (s: number, e: number) =>
    coordinates.slice(s, e + 1).map((c) => c[2] as number);
  // Split the single line at the coordinate nearest each via point.
  const cuts = [0];
  for (let i = 1; i < req.points.length - 1; i++) {
    const p = req.points[i];
    const prev = cuts[cuts.length - 1] ?? 0;
    cuts.push(p ? nearestIndex(coordinates, p, prev) : prev);
  }
  cuts.push(coordinates.length - 1);
  const legs: RouteLeg[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i] ?? 0;
    const end = cuts[i + 1] ?? start;
    const climb = hasEle ? climbOf(elevationsOf(start, end)) : null;
    legs.push({
      start,
      end,
      distanceM: Math.round(lineLengthM(coordinates, start, end)),
      ascentM: climb?.ascentM ?? null,
      descentM: climb?.descentM ?? null,
    });
  }
  const props = (feature as { properties?: Record<string, unknown> }).properties ?? {};
  const trackLength = Number(props['track-length']);
  const distance = Number.isFinite(trackLength) ? trackLength : lineLengthM(coordinates);
  const climb = hasEle ? climbOf(coordinates.map((c) => c[2] as number)) : null;
  return finish(req, 'brouter', coordinates, legs, distance, climb);
}

interface ValhallaLeg {
  shape?: string;
  summary?: { length?: number };
  elevation?: number[];
}

/** Valhalla's trip (one encoded shape per leg, lengths in km) → our Feature. */
export function normalizeValhalla(req: RouteRequest, body: unknown): RouteFeature {
  const trip = (body as { trip?: { legs?: ValhallaLeg[]; summary?: { length?: number } } })?.trip;
  if (!trip || !Array.isArray(trip.legs) || trip.legs.length === 0) {
    throw new RouteError(502, 'upstream', 'routing engine answered without a trip');
  }
  const coordinates: number[][] = [];
  const legs: RouteLeg[] = [];
  const allElevations: number[] = [];
  let hasEle = true;
  for (const leg of trip.legs) {
    const shape = decodePolyline6(leg.shape ?? '');
    if (shape.length === 0)
      throw new RouteError(502, 'upstream', 'routing engine sent an empty leg');
    // Legs share their joint: keep it once.
    const start = coordinates.length === 0 ? 0 : coordinates.length - 1;
    coordinates.push(...(coordinates.length === 0 ? shape : shape.slice(1)));
    const elevations = Array.isArray(leg.elevation)
      ? leg.elevation.filter((e) => typeof e === 'number' && Number.isFinite(e))
      : [];
    if (elevations.length < 2) hasEle = false;
    allElevations.push(...elevations);
    const climb = elevations.length >= 2 ? climbOf(elevations) : null;
    const km = leg.summary?.length;
    legs.push({
      start,
      end: coordinates.length - 1,
      distanceM: Math.round(
        typeof km === 'number'
          ? km * 1000
          : lineLengthM(coordinates, start, coordinates.length - 1),
      ),
      ascentM: climb?.ascentM ?? null,
      descentM: climb?.descentM ?? null,
    });
  }
  const km = trip.summary?.length;
  const distance = typeof km === 'number' ? km * 1000 : lineLengthM(coordinates);
  return finish(
    req,
    'valhalla',
    coordinates,
    legs,
    distance,
    hasEle ? climbOf(allElevations) : null,
  );
}

/** An upstream failure (status + body text) → our error. */
export function upstreamError(engine: RouteEngine, status: number, text: string): RouteError {
  if (status === 429) return new RouteError(503, 'busy', 'routing is busy, try again shortly');
  if (engine === 'valhalla') {
    let code: number | undefined;
    try {
      code = (JSON.parse(text) as { error_code?: number }).error_code;
    } catch {
      code = undefined;
    }
    if (code === 154 || code === 155) {
      return new RouteError(422, 'too_long', 'route is too long for the routing engine');
    }
    if (code !== undefined && [170, 171, 442, 443].includes(code)) {
      return new RouteError(422, 'no_route', 'no trail or road connects these points');
    }
  } else if (
    status >= 400 &&
    status < 500 &&
    /not found|not mapped|no route|target island|position not/i.test(text)
  ) {
    return new RouteError(422, 'no_route', 'no trail or road connects these points');
  }
  return new RouteError(502, 'upstream', 'routing unavailable');
}

/** Canonical cache key: a hash of everything that shapes the answer. */
export async function routeCacheKey(
  env: RouteEnv,
  engine: RouteEngine,
  req: RouteRequest,
): Promise<Request> {
  const upstream =
    engine === 'brouter'
      ? `${env.BROUTER_URL ?? DEFAULT_BROUTER_URL}|${brouterProfile(env, req.profile)}`
      : `${env.VALHALLA_URL ?? DEFAULT_VALHALLA_URL}|${VALHALLA_COSTING[req.profile]}`;
  const canonical = [
    ROUTE_CACHE_VERSION,
    req.mode,
    req.profile,
    engine,
    upstream,
    req.points.map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';'),
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request(`https://route-cache.inukshuk.invalid/v${ROUTE_CACHE_VERSION}/${hex}`);
}

/** Per-isolate fixed-window counter: ip → [window start, count]. */
const windows = new Map<string, [number, number]>();
const MAX_TRACKED_IPS = 10_000;
/** Per-isolate next free upstream slot per engine (epoch ms). */
const nextSlot = new Map<RouteEngine, number>();

/** Test hook: forget every counter and slot. */
export function resetRouteLimits(): void {
  windows.clear();
  nextSlot.clear();
}

async function allowed(env: RouteEnv, ip: string, now: number): Promise<boolean> {
  if (env.ROUTE_LIMITER !== undefined) {
    return (await env.ROUTE_LIMITER.limit({ key: ip })).success;
  }
  const perMin = Number(env.ROUTE_RATE_PER_MIN ?? DEFAULT_RATE_PER_MIN);
  const max = Number.isFinite(perMin) && perMin > 0 ? perMin : DEFAULT_RATE_PER_MIN;
  const minute = Math.floor(now / 60_000);
  const w = windows.get(ip);
  if (w === undefined || w[0] !== minute) {
    if (windows.size >= MAX_TRACKED_IPS) windows.clear();
    windows.set(ip, [minute, 1]);
    return true;
  }
  if (w[1] >= max) return false;
  w[1] += 1;
  return true;
}

/** Wait for this engine's next upstream slot; false = the queue is too long. */
async function takeSlot(env: RouteEnv, deps: RouteDeps, engine: RouteEngine): Promise<boolean> {
  const raw = Number(env.ROUTE_UPSTREAM_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const interval = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTERVAL_MS;
  const now = deps.now();
  const slot = Math.max(now, nextSlot.get(engine) ?? 0);
  const wait = slot - now;
  if (wait > MAX_QUEUE_MS) return false;
  nextSlot.set(engine, slot + interval);
  if (wait > 0) await deps.sleep(wait);
  return true;
}

async function callUpstream(
  env: RouteEnv,
  deps: RouteDeps,
  engine: RouteEngine,
  req: RouteRequest,
): Promise<RouteFeature> {
  const { url, init } = upstreamRequest(env, engine, req);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await deps.fetch(url, { ...init, signal: controller.signal });
    text = await res.text();
  } catch {
    throw new RouteError(504, 'timeout', 'routing timed out');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw upstreamError(engine, res.status, text);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RouteError(502, 'upstream', 'routing engine sent unreadable data');
  }
  return engine === 'brouter' ? normalizeBrouter(req, body) : normalizeValhalla(req, body);
}

function jsonError(
  status: number,
  code: RouteErrorCode,
  message: string,
  cors: Record<string, string>,
  extra: Record<string, string> = {},
): Response {
  return Response.json(
    { code, message },
    { status, headers: { ...cors, 'Cache-Control': 'no-store', ...extra } },
  );
}

async function readBody(request: Request): Promise<unknown> {
  // Capped while reading: the check used to run after buffering the whole body.
  const text = await readTextCapped(request, MAX_BODY_BYTES);
  if (text === null) throw new RouteError(400, 'bad_request', 'body too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RouteError(400, 'bad_request', 'body must be JSON');
  }
}

export async function handleRoute(
  request: Request,
  env: RouteEnv,
  deps: RouteDeps,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonError(405, 'bad_request', 'use POST', cors, { Allow: 'POST' });
  }
  try {
    const req = parseRouteRequest(await readBody(request));
    const engine = engineFor(env, req.mode);
    const key = await routeCacheKey(env, engine, req);
    const hit = await deps.cache.match(key);
    if (hit !== undefined) {
      const headers = new Headers(hit.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      headers.set('X-Route-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers });
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!(await allowed(env, ip, deps.now()))) {
      throw new RouteError(429, 'rate_limited', 'too many routes, try again in a minute');
    }
    if (!(await takeSlot(env, deps, engine))) {
      throw new RouteError(503, 'busy', 'routing is busy, try again shortly');
    }
    const feature = await callUpstream(env, deps, engine, req);
    const response = Response.json(feature, {
      headers: {
        ...cors,
        'Cache-Control': env.ROUTE_CACHE_CONTROL ?? DEFAULT_CACHE_CONTROL,
        'X-Route-Cache': 'MISS',
      },
    });
    deps.waitUntil(deps.cache.put(key, response.clone()));
    return response;
  } catch (e) {
    if (e instanceof RouteError) {
      const retry: Record<string, string> =
        e.status === 429 ? { 'Retry-After': '60' } : e.status === 503 ? { 'Retry-After': '5' } : {};
      return jsonError(e.status, e.code, e.message, cors, retry);
    }
    return jsonError(502, 'upstream', 'routing unavailable', cors);
  }
}
