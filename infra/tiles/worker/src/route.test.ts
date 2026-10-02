/**
 * @jest-environment node
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  climbOf,
  decodePolyline6,
  DEFAULT_BROUTER_URL,
  DEFAULT_VALHALLA_URL,
  engineFor,
  handleRoute,
  normalizeBrouter,
  normalizeValhalla,
  parseRouteRequest,
  resetRouteLimits,
  ROUTE_USER_AGENT,
  routeCacheKey,
  RouteError,
  upstreamError,
  upstreamRequest,
  type RouteDeps,
  type RouteEnv,
  type RouteFeature,
  type RouteRequest,
} from './route';

/*
 * Fixtures are real answers, captured once (2026-10-01) with a handful of
 * polite requests: BRouter hiking-mountain on Mont-Sainte-Anne (base → summit)
 * and on the Panoramaweg (Kleine Scheidegg → Männlichen); Valhalla pedestrian
 * around Québec's Old Town (Château Frontenac → Porte Saint-Louis → Parliament
 * → Frontenac); and each engine's "nothing here" error (mid-Atlantic).
 * BRouter's per-point `messages`/`times` were dropped to keep them small.
 */
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const BROUTER_MSA = fixture('brouter-msa.json');
const BROUTER_SWISS = fixture('brouter-swiss.json');
const BROUTER_NOROUTE = fixture('brouter-noroute.txt');
const VALHALLA_OLDTOWN = fixture('valhalla-oldtown.json');
const VALHALLA_NOROUTE = fixture('valhalla-noroute.json');

const MSA: [number, number][] = [
  [-70.9065, 47.0753],
  [-70.9318, 47.0855],
];
const SWISS: [number, number][] = [
  [7.9614, 46.5853],
  [7.9409, 46.6133],
];
const OLD_TOWN: [number, number][] = [
  [-71.2047, 46.8119],
  [-71.2125, 46.8115],
  [-71.2141, 46.8088],
  [-71.2047, 46.8119],
];

const trail = (points: [number, number][]): RouteRequest => ({
  mode: 'trail',
  profile: 'hike',
  points,
});
const road = (points: [number, number][]): RouteRequest => ({
  mode: 'road',
  profile: 'foot',
  points,
});

/** A fake upstream + Map-backed cache; records what was fetched. */
function harness(upstream: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const store = new Map<string, Response>();
  const calls: { url: URL; init?: RequestInit }[] = [];
  const pending: Promise<unknown>[] = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  const deps: RouteDeps = {
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      return upstream(url, init);
    },
    cache: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => {
        store.set(req.url, res);
      },
    },
    waitUntil: (p) => {
      pending.push(p);
    },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return {
    deps,
    calls,
    store,
    sleeps,
    settle: () => Promise.all(pending),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const CORS = { 'Access-Control-Allow-Origin': '*' };
const ENV: RouteEnv = {};

function post(body: unknown, ip = '203.0.113.7'): Request {
  return new Request('https://tiles.example/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const fromFixture =
  (text: string, status = 200) =>
  () =>
    new Response(text, { status });

beforeEach(() => resetRouteLimits());

describe('parseRouteRequest', () => {
  it('accepts a trail request, defaulting the profile, rounding to ~1 m', () => {
    expect(
      parseRouteRequest({
        mode: 'trail',
        points: [
          [-70.906512345, 47.075298765],
          [-70.9318, 47.0855],
        ],
      }),
    ).toEqual({
      mode: 'trail',
      profile: 'hike',
      points: [
        [-70.90651, 47.0753],
        [-70.9318, 47.0855],
      ],
    });
    expect(parseRouteRequest({ mode: 'road', points: OLD_TOWN }).profile).toBe('foot');
    expect(parseRouteRequest({ mode: 'road', profile: 'bike', points: OLD_TOWN }).profile).toBe(
      'bike',
    );
  });

  it.each([
    [null, 'body must be a JSON object'],
    [{ mode: 'boat', points: MSA }, 'mode must be "trail" or "road"'],
    [{ mode: 'trail', profile: 'ski', points: MSA }, 'profile must be one of'],
    [{ mode: 'trail', points: [MSA[0]] }, 'at least 2'],
    [{ mode: 'trail', points: Array.from({ length: 26 }, () => [0, 0]) }, 'at most 25'],
    [
      {
        mode: 'trail',
        points: [
          [0, 0],
          [0, 91],
        ],
      },
      '[lon, lat]',
    ],
    [
      {
        mode: 'trail',
        points: [
          [0, 0],
          ['a', 1],
        ],
      },
      '[lon, lat]',
    ],
  ])('rejects %j', (body, message) => {
    expect(() => parseRouteRequest(body)).toThrow(message);
  });

  it('refuses a request spanning more than 100 km (422 too_long)', () => {
    try {
      parseRouteRequest({ mode: 'road', points: [MSA[0], SWISS[0]] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RouteError);
      expect((e as RouteError).status).toBe(422);
      expect((e as RouteError).code).toBe('too_long');
    }
  });
});

describe('engines and upstream requests', () => {
  it('defaults trail → BRouter, road → Valhalla; env swaps them', () => {
    expect(engineFor({}, 'trail')).toBe('brouter');
    expect(engineFor({}, 'road')).toBe('valhalla');
    expect(engineFor({ TRAIL_ENGINE: 'valhalla' }, 'trail')).toBe('valhalla');
    expect(engineFor({ ROAD_ENGINE: ' BRouter ' }, 'road')).toBe('brouter');
    expect(engineFor({ ROAD_ENGINE: 'osrm' }, 'road')).toBe('valhalla');
  });

  it('builds a BRouter GeoJSON request with the mapped profile and our User-Agent', () => {
    const { url, init } = upstreamRequest(ENV, 'brouter', trail(MSA));
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(DEFAULT_BROUTER_URL);
    expect(u.searchParams.get('lonlats')).toBe('-70.9065,47.0753|-70.9318,47.0855');
    expect(u.searchParams.get('profile')).toBe('hiking-mountain');
    expect(u.searchParams.get('format')).toBe('geojson');
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(ROUTE_USER_AGENT);
    expect(init.method).toBeUndefined();
  });

  it('honours BROUTER_URL and BROUTER_PROFILES', () => {
    const env = {
      BROUTER_URL: 'http://nas.local:17777/brouter',
      BROUTER_PROFILES: 'bike=fastbike',
    };
    const u = new URL(upstreamRequest(env, 'brouter', { ...trail(MSA), profile: 'bike' }).url);
    expect(u.host).toBe('nas.local:17777');
    expect(u.searchParams.get('profile')).toBe('fastbike');
  });

  it('builds a Valhalla POST with break locations, costing and elevation sampling', () => {
    const { url, init } = upstreamRequest({ VALHALLA_URL: 'https://v.example/' }, 'valhalla', {
      ...road(OLD_TOWN),
      profile: 'bike',
    });
    expect(url).toBe('https://v.example/route');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.costing).toBe('bicycle');
    expect(body.elevation_interval).toBe(30);
    expect(body.locations).toHaveLength(4);
    expect((body.locations as unknown[])[0]).toEqual({
      lon: -71.2047,
      lat: 46.8119,
      type: 'break',
    });
    expect(upstreamRequest(ENV, 'valhalla', road(OLD_TOWN)).url).toBe(
      `${DEFAULT_VALHALLA_URL}/route`,
    );
  });
});

describe('normalization', () => {
  it('BRouter Mont-Sainte-Anne: a 3D line from base to summit, one leg, real climb', () => {
    const f = normalizeBrouter(trail(MSA), JSON.parse(BROUTER_MSA));
    const coords = f.geometry.coordinates;
    expect(coords.length).toBe(130);
    expect(coords.every((c) => c.length === 3)).toBe(true);
    expect(f.properties.distanceM).toBe(3320); // BRouter's track-length
    expect(f.properties.engine).toBe('brouter');
    expect(f.properties.legs).toEqual([
      expect.objectContaining({ start: 0, end: 129, ascentM: expect.any(Number) }),
    ]);
    // ~178 m at the base to ~796 m at the top.
    expect(f.properties.ascentM).toBeGreaterThan(550);
    expect(f.properties.ascentM).toBeLessThan(700);
    expect(f.properties.attribution).toContain('OpenStreetMap');
  });

  it('BRouter splits a multi-point line into legs at the via points', () => {
    const body = JSON.parse(BROUTER_SWISS) as {
      features: { geometry: { coordinates: number[][] } }[];
    };
    const coords = body.features[0]!.geometry.coordinates;
    const mid = coords[200]!;
    const f = normalizeBrouter(trail([SWISS[0]!, [mid[0]!, mid[1]!], SWISS[1]!]), body);
    const [a, b] = f.properties.legs;
    expect(a).toMatchObject({ start: 0, end: 200 });
    expect(b).toMatchObject({ start: 200, end: coords.length - 1 });
    expect(a!.distanceM + b!.distanceM).toBeGreaterThan(4500);
    expect(f.properties.distanceM).toBe(4727);
  });

  it('Valhalla Old Town loop: legs joined once, km → m, climb from sampled elevation', () => {
    const f = normalizeValhalla(road(OLD_TOWN), JSON.parse(VALHALLA_OLDTOWN));
    const { legs } = f.properties;
    expect(legs).toHaveLength(3);
    expect(f.properties.distanceM).toBe(2311);
    expect(legs.map((l) => l.distanceM)).toEqual([873, 513, 924]);
    // Contiguous: each leg starts where the previous ended.
    expect(legs[1]!.start).toBe(legs[0]!.end);
    expect(legs[2]!.start).toBe(legs[1]!.end);
    expect(legs[2]!.end).toBe(f.geometry.coordinates.length - 1);
    // The loop starts and ends near the Château Frontenac.
    const first = f.geometry.coordinates[0]!;
    expect(first[0]).toBeCloseTo(-71.2047, 2);
    expect(first[1]).toBeCloseTo(46.8119, 2);
    expect(f.properties.ascentM).toEqual(expect.any(Number));
    expect(f.properties.descentM).toEqual(expect.any(Number));
  });

  it('rejects answers without a line', () => {
    expect(() => normalizeBrouter(trail(MSA), { features: [] })).toThrow('without a line');
    expect(() => normalizeValhalla(road(OLD_TOWN), { trip: { legs: [] } })).toThrow(
      'without a trip',
    );
  });

  it('decodes polyline6 and measures climb with hysteresis', () => {
    // Google's documented example at precision 5, scaled: ~[(38.5,-120.2), (40.7,-120.95)].
    expect(decodePolyline6('_izlhA~rlgdF_{geC~ywl@')).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
    ]);
    expect(climbOf([100, 101, 102, 110, 108, 109, 100])).toEqual({ ascentM: 10, descentM: 10 });
  });
});

describe('upstream errors', () => {
  it('maps "nothing routable here" to 422 no_route for both engines', () => {
    expect(upstreamError('brouter', 400, BROUTER_NOROUTE)).toMatchObject({
      status: 422,
      code: 'no_route',
    });
    expect(upstreamError('valhalla', 400, VALHALLA_NOROUTE)).toMatchObject({
      status: 422,
      code: 'no_route',
    });
  });

  it('maps upstream 429 to busy, too-long to too_long, the rest to 502', () => {
    expect(upstreamError('valhalla', 429, '')).toMatchObject({ status: 503, code: 'busy' });
    expect(upstreamError('valhalla', 400, '{"error_code":154}')).toMatchObject({
      code: 'too_long',
    });
    expect(
      upstreamError('brouter', 500, 'operation killed by thread-priority-watchdog'),
    ).toMatchObject({ status: 502, code: 'upstream' });
    expect(upstreamError('valhalla', 500, 'not json')).toMatchObject({ code: 'upstream' });
  });
});

describe('cache keys', () => {
  it('are stable for the same request and change with anything that shapes the answer', async () => {
    const a = await routeCacheKey(ENV, 'brouter', trail(MSA));
    const b = await routeCacheKey(ENV, 'brouter', trail(MSA));
    expect(a.url).toBe(b.url);
    expect(a.url).toMatch(/^https:\/\/route-cache\.inukshuk\.invalid\/v1\/[0-9a-f]{64}$/);
    const differs = [
      await routeCacheKey(ENV, 'brouter', { ...trail(MSA), profile: 'bike' }),
      await routeCacheKey(ENV, 'valhalla', trail(MSA)),
      await routeCacheKey(ENV, 'brouter', trail([MSA[1]!, MSA[0]!])),
      await routeCacheKey({ BROUTER_URL: 'http://nas/brouter' }, 'brouter', trail(MSA)),
    ];
    for (const k of differs) expect(k.url).not.toBe(a.url);
  });
});

describe('handleRoute', () => {
  it('routes a trail through BRouter, caches it, and serves the repeat from cache', async () => {
    const h = harness(fromFixture(BROUTER_MSA));
    const res = await handleRoute(post({ mode: 'trail', points: MSA }), ENV, h.deps, CORS);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Route-Cache')).toBe('MISS');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await res.json()) as RouteFeature;
    expect(body.properties.mode).toBe('trail');
    expect(body.geometry.type).toBe('LineString');
    await h.settle();

    const again = await handleRoute(post({ mode: 'trail', points: MSA }), ENV, h.deps, CORS);
    expect(again.headers.get('X-Route-Cache')).toBe('HIT');
    expect(((await again.json()) as RouteFeature).properties.distanceM).toBe(3320);
    expect(h.calls).toHaveLength(1);
  });

  it('routes a road through Valhalla', async () => {
    const h = harness(fromFixture(VALHALLA_OLDTOWN));
    const res = await handleRoute(post({ mode: 'road', points: OLD_TOWN }), ENV, h.deps, CORS);
    expect(res.status).toBe(200);
    expect(h.calls[0]!.url.host).toBe('valhalla1.openstreetmap.de');
    expect(((await res.json()) as RouteFeature).properties.legs).toHaveLength(3);
  });

  it('answers bad input with 400 and GET with 405, never calling upstream', async () => {
    const h = harness(fromFixture(BROUTER_MSA));
    const bad = await handleRoute(post('{not json'), ENV, h.deps, CORS);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ code: 'bad_request', message: 'body must be JSON' });
    const get = await handleRoute(new Request('https://tiles.example/route'), ENV, h.deps, CORS);
    expect(get.status).toBe(405);
    const huge = await handleRoute(post('x'.repeat(9000)), ENV, h.deps, CORS);
    expect(huge.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it('passes no_route through as 422 and does not cache errors', async () => {
    const h = harness(fromFixture(BROUTER_NOROUTE, 400));
    const pts = [
      [-40, 40],
      [-39.9, 40],
    ];
    const res = await handleRoute(post({ mode: 'trail', points: pts }), ENV, h.deps, CORS);
    expect(res.status).toBe(422);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(((await res.json()) as { code: string }).code).toBe('no_route');
    await h.settle();
    expect(h.store.size).toBe(0);
  });

  it('turns a network failure or timeout into a clean 504', async () => {
    const h = harness(() => {
      throw new Error('socket hang up');
    });
    const res = await handleRoute(post({ mode: 'trail', points: MSA }), ENV, h.deps, CORS);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ code: 'timeout', message: 'routing timed out' });
  });

  it('rejects unreadable upstream JSON as 502', async () => {
    const h = harness(fromFixture('<html>maintenance</html>'));
    const res = await handleRoute(post({ mode: 'road', points: OLD_TOWN }), ENV, h.deps, CORS);
    expect(res.status).toBe(502);
  });

  it('rate-limits cache misses per IP per minute (429 with Retry-After)', async () => {
    const h = harness(fromFixture(BROUTER_MSA));
    const env = { ROUTE_RATE_PER_MIN: '2', ROUTE_UPSTREAM_INTERVAL_MS: '0' };
    const req = (lon: number, ip?: string) =>
      post({ mode: 'trail', points: [[lon, 47.07], MSA[1]] }, ip);
    expect((await handleRoute(req(-70.9), env, h.deps, CORS)).status).toBe(200);
    expect((await handleRoute(req(-70.91), env, h.deps, CORS)).status).toBe(200);
    const limited = await handleRoute(req(-70.92), env, h.deps, CORS);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    // Another phone is not affected; neither is this one a minute later.
    expect((await handleRoute(req(-70.92, '198.51.100.1'), env, h.deps, CORS)).status).toBe(200);
    h.advance(60_000);
    expect((await handleRoute(req(-70.92), env, h.deps, CORS)).status).toBe(200);
  });

  it('uses a rate-limiting binding when one is configured', async () => {
    const h = harness(fromFixture(BROUTER_MSA));
    const env: RouteEnv = { ROUTE_LIMITER: { limit: async () => ({ success: false }) } };
    const res = await handleRoute(post({ mode: 'trail', points: MSA }), env, h.deps, CORS);
    expect(res.status).toBe(429);
    expect(h.calls).toHaveLength(0);
  });

  it('paces upstream calls to one per second per engine, and sheds a long queue', async () => {
    const h = harness(fromFixture(BROUTER_MSA));
    const req = (lon: number) => post({ mode: 'trail', points: [[lon, 47.07], MSA[1]] });
    // Three back-to-back calls in the same instant: the 2nd waits 1 s, the 3rd 2 s…
    await handleRoute(req(-70.9), ENV, h.deps, CORS);
    const slots: number[] = [];
    const deps = { ...h.deps, sleep: async (ms: number) => void slots.push(ms) };
    await handleRoute(req(-70.91), ENV, deps, CORS);
    await handleRoute(req(-70.92), ENV, deps, CORS);
    await handleRoute(req(-70.93), ENV, deps, CORS);
    expect(slots).toEqual([1000, 2000, 3000]);
    // …and one that would wait more than 3 s is told to come back.
    const busy = await handleRoute(req(-70.94), ENV, deps, CORS);
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as { code: string }).code).toBe('busy');
  });
});
