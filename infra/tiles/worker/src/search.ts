/**
 * Place search proxy (#496): `GET /search?q=&lang=&alt=&lat=&lon=&limit=`
 * forwards to a Photon geocoder (https://github.com/komoot/photon, OSM data)
 * and hands its GeoJSON back.
 *
 * Why a proxy instead of the app calling Photon directly:
 *
 * - **Fair use.** The public instance (photon.komoot.io) asks for reasonable
 *   volumes and throttles or bans heavy users. One edge cache shared by every
 *   phone (a day per query) and a per-IP rate limit keep our footprint small,
 *   and requests carry an identifying User-Agent.
 * - **Swap without an app update.** The upstream is `PHOTON_URL`; pointing it
 *   at a Photon on the NAS is a `wrangler.toml` change.
 * - **Privacy.** Only the query, the language and a location rounded to
 *   0.01° (~1 km) go upstream; the app already rounds, we round again.
 *
 * `alt` asks for the same results' names in a second language (EN ↔ FR): one
 * extra upstream call (cached the same way), merged into the first answer as
 * `properties.alt_name` where the two names differ. `PHOTON_ALT_NAMES = "0"`
 * turns it off.
 *
 * Written against the standard fetch API (Request/Response/Cache) with its
 * platform pieces injected, so it is unit-tested in Node (`search.test.ts`).
 */

export interface SearchEnv {
  /** Photon `/api` endpoint. Default: the public komoot instance. */
  PHOTON_URL?: string;
  /** Edge + client cache lifetime of an answer. Default one day. */
  SEARCH_CACHE_CONTROL?: string;
  /** Upstream requests per minute per client IP (in-isolate limiter). Default 60. */
  SEARCH_RATE_PER_MIN?: string;
  /** "0" disables the second-language request. */
  PHOTON_ALT_NAMES?: string;
  /** Photon `osm_tag` filters, comma separated (see {@link DEFAULT_OSM_TAGS}). */
  PHOTON_OSM_TAGS?: string;
  /**
   * Optional Cloudflare rate-limiting binding (`[[ratelimits]]` in
   * wrangler.toml), global across isolates. Without it, a per-isolate counter
   * is the (best-effort) limit.
   */
  SEARCH_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export interface SearchDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  cache: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
  waitUntil: (promise: Promise<unknown>) => void;
  now: () => number;
}

export const DEFAULT_PHOTON_URL = 'https://photon.komoot.io/api/';
export const SEARCH_USER_AGENT =
  'Inukshuk-TrailApp/1.0 (place search proxy; https://github.com/MVXTechnologies/inukshuk)';
const DEFAULT_CACHE_CONTROL = 'public, max-age=86400';
const DEFAULT_RATE_PER_MIN = 60;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_QUERY_LENGTH = 200;
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 10;
/** Languages the public Photon instance indexes names in. */
const LANGS = new Set(['default', 'en', 'fr', 'de', 'it']);
/** Bump to stop reusing cached answers (the key changes, old entries go cold). */
const SEARCH_CACHE_VERSION = '1';

export interface SearchParams {
  q: string;
  lang: string;
  alt: string | null;
  limit: number;
  lat: number | null;
  lon: number | null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Validate and normalize the query string; a string is the 400 message. */
export function parseSearchParams(url: URL): SearchParams | string {
  const q = (url.searchParams.get('q') ?? '').trim().replace(/\s+/g, ' ');
  if ([...q].length < 2) return 'q must be at least 2 characters';
  if (q.length > MAX_QUERY_LENGTH) return 'q is too long';
  const langRaw = (url.searchParams.get('lang') ?? 'default').toLowerCase();
  const lang = LANGS.has(langRaw) ? langRaw : 'default';
  const altRaw = url.searchParams.get('alt')?.toLowerCase() ?? null;
  const alt = altRaw !== null && LANGS.has(altRaw) && altRaw !== lang ? altRaw : null;
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, limitRaw))
    : DEFAULT_LIMIT;
  const latRaw = Number(url.searchParams.get('lat') ?? Number.NaN);
  const lonRaw = Number(url.searchParams.get('lon') ?? Number.NaN);
  const located =
    url.searchParams.has('lat') &&
    url.searchParams.has('lon') &&
    Number.isFinite(latRaw) &&
    Number.isFinite(lonRaw) &&
    Math.abs(latRaw) <= 90 &&
    Math.abs(lonRaw) <= 180;
  return {
    q,
    lang,
    alt,
    limit,
    lat: located ? round2(latRaw) : null,
    lon: located ? round2(lonRaw) : null,
  };
}

/**
 * Photon `osm_tag` filters sent with every query (`PHOTON_OSM_TAGS`, comma
 * separated; "" sends none). By default shops, offices and workshops are left
 * out: a trail app never wants the furniture store named "Katahdin", and each
 * one takes a slot the peak needed.
 */
export const DEFAULT_OSM_TAGS = '!shop,!office,!craft';

export function osmTagFilters(env: SearchEnv): string[] {
  return (env.PHOTON_OSM_TAGS ?? DEFAULT_OSM_TAGS)
    .split(',')
    .map((t) => t.trim())
    .filter((t) => /^!?[a-z0-9_:]+$/i.test(t));
}

/** Upstream URL for one language. */
export function photonUrl(
  base: string,
  p: SearchParams,
  lang: string,
  osmTags: readonly string[] = [],
): string {
  const u = new URL(base);
  u.searchParams.set('q', p.q);
  u.searchParams.set('limit', String(p.limit));
  if (lang !== 'default') u.searchParams.set('lang', lang);
  if (p.lat !== null && p.lon !== null) {
    u.searchParams.set('lat', p.lat.toFixed(2));
    u.searchParams.set('lon', p.lon.toFixed(2));
  }
  for (const tag of osmTags) u.searchParams.append('osm_tag', tag);
  return u.toString();
}

/** Canonical cache key: case- and whitespace-folded, parameters in a fixed order. */
export function searchCacheKey(
  p: SearchParams,
  alt: string | null,
  osmTags: readonly string[] = [],
): Request {
  const u = new URL('https://search-cache.inukshuk.invalid/v' + SEARCH_CACHE_VERSION);
  // A filter change is a different answer: never serve one cached under another.
  if (osmTags.length > 0) u.searchParams.set('tags', osmTags.join(','));
  u.searchParams.set('q', p.q.toLowerCase());
  u.searchParams.set('lang', p.lang);
  if (alt !== null) u.searchParams.set('alt', alt);
  u.searchParams.set('limit', String(p.limit));
  if (p.lat !== null && p.lon !== null) {
    u.searchParams.set('lat', p.lat.toFixed(2));
    u.searchParams.set('lon', p.lon.toFixed(2));
  }
  return new Request(u.toString());
}

/** Per-isolate fixed-window counter: ip → [window start, count]. */
const windows = new Map<string, [number, number]>();
const MAX_TRACKED_IPS = 10_000;

/** Test hook: forget every counter. */
export function resetSearchRateLimit(): void {
  windows.clear();
}

async function allowed(env: SearchEnv, ip: string, now: number): Promise<boolean> {
  if (env.SEARCH_LIMITER !== undefined) {
    return (await env.SEARCH_LIMITER.limit({ key: ip })).success;
  }
  const perMin = Number(env.SEARCH_RATE_PER_MIN ?? DEFAULT_RATE_PER_MIN);
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

class UpstreamError extends Error {
  constructor(readonly status: number) {
    super(`upstream ${status}`);
  }
}

async function fetchPhoton(deps: SearchDeps, url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, {
      headers: { 'User-Agent': SEARCH_USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new UpstreamError(res.status);
    const body = (await res.json()) as unknown;
    if (
      body === null ||
      typeof body !== 'object' ||
      !Array.isArray((body as { features?: unknown }).features)
    ) {
      throw new UpstreamError(502);
    }
    return body as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

type Feature = { properties?: Record<string, unknown> | null };

const featureKey = (f: Feature) =>
  f.properties ? `${String(f.properties.osm_type)}${String(f.properties.osm_id)}` : '';

/** Copy the second language's names onto the first answer as `alt_name`. */
export function mergeAltNames(
  primary: Record<string, unknown>,
  alt: Record<string, unknown>,
): Record<string, unknown> {
  const names = new Map<string, string>();
  for (const f of alt.features as Feature[]) {
    const name = f.properties?.name;
    if (typeof name === 'string') names.set(featureKey(f), name);
  }
  const features = (primary.features as Feature[]).map((f) => {
    const other = names.get(featureKey(f));
    if (f.properties == null || other === undefined || other === f.properties.name) return f;
    return { ...f, properties: { ...f.properties, alt_name: other } };
  });
  return { ...primary, features };
}

function jsonError(
  status: number,
  message: string,
  cors: Record<string, string>,
  extra: Record<string, string> = {},
): Response {
  return Response.json(
    { message },
    { status, headers: { ...cors, 'Cache-Control': 'no-store', ...extra } },
  );
}

export async function handleSearch(
  request: Request,
  env: SearchEnv,
  deps: SearchDeps,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== 'GET') return jsonError(405, 'method not allowed', cors);
  const params = parseSearchParams(new URL(request.url));
  if (typeof params === 'string') return jsonError(400, params, cors);
  const alt = env.PHOTON_ALT_NAMES === '0' ? null : params.alt;

  const tags = osmTagFilters(env);
  const key = searchCacheKey(params, alt, tags);
  const hit = await deps.cache.match(key);
  if (hit !== undefined) {
    const headers = new Headers(hit.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set('X-Search-Cache', 'HIT');
    return new Response(hit.body, { status: hit.status, headers });
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await allowed(env, ip, deps.now()))) {
    return jsonError(429, 'too many searches, try again in a minute', cors, {
      'Retry-After': '60',
    });
  }

  const base = env.PHOTON_URL ?? DEFAULT_PHOTON_URL;
  let body: Record<string, unknown>;
  try {
    const [primary, second] = await Promise.all([
      fetchPhoton(deps, photonUrl(base, params, params.lang, tags)),
      // The second language is a nicety: its failure never fails the search.
      alt === null
        ? Promise.resolve(null)
        : fetchPhoton(deps, photonUrl(base, params, alt, tags)).catch(() => null),
    ]);
    body = second === null ? primary : mergeAltNames(primary, second);
  } catch (e) {
    if (e instanceof UpstreamError) {
      if (e.status === 429) {
        return jsonError(503, 'search is busy, try again shortly', cors, { 'Retry-After': '60' });
      }
      if (e.status === 400) return jsonError(400, 'search could not read that query', cors);
      return jsonError(502, 'search unavailable', cors);
    }
    // Network failure or our timeout.
    return jsonError(504, 'search timed out', cors);
  }

  const response = Response.json(body, {
    headers: {
      ...cors,
      'Cache-Control': env.SEARCH_CACHE_CONTROL ?? DEFAULT_CACHE_CONTROL,
      'X-Search-Cache': 'MISS',
    },
  });
  deps.waitUntil(deps.cache.put(key, response.clone()));
  return response;
}
