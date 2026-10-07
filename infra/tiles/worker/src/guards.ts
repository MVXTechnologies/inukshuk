/**
 * Abuse and cost guards shared by the Worker's routes (security audit
 * 2026-10). Pure, written against the standard fetch API, so the app's Jest
 * tests them in Node (`guards.test.ts`).
 *
 * The Worker is public and unauthenticated by design (the app is its only
 * client, and a mobile app can hold no secret), so what keeps one abusive
 * client from running up R2 operations, CPU or upstream quotas is:
 *
 * - **bounded inputs**: only known archives, a short font-stack name, tokens
 *   that look like tokens, bodies read with a hard byte cap (a missing or
 *   lying Content-Length is not trusted);
 * - **one cache entry per resource**: the edge-cache key keeps the path and the
 *   app's `?v=N` version only, so random query strings can't force a miss;
 * - **rate limits on the expensive paths** (contour generation, the token
 *   proxy, code emails): the Workers rate-limiting binding when configured,
 *   else a per-isolate counter as a floor.
 */

/** A Workers rate-limiting binding (`[[ratelimits]]` in wrangler.toml). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Archives the Worker serves as `/{archive}/{z}/{x}/{y}.mvt` and
 * `/{archive}.json`. Anything else is a 404 without touching R2: an unknown
 * name used to cost an R2 read per request and an entry in the isolate's
 * index cache. `crags` is the climbing archive (#576). Override with the
 * `ARCHIVES` var (comma separated) to add one without a code change.
 */
export const DEFAULT_ARCHIVES: readonly string[] = [
  'basemap',
  'peaks',
  'parks',
  'geodetic',
  'tides',
  'crags',
];

export function archiveAllowlist(configured: string | undefined): ReadonlySet<string> {
  const names = (configured ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9_-]{1,40}$/.test(s));
  return new Set(names.length > 0 ? names : DEFAULT_ARCHIVES);
}

/** The app's cache-busting version parameter (`?v=2`); nothing else is kept. */
const VERSION_PARAM = /^\d{1,4}$/;

/**
 * Edge-cache key for a static GET (tiles, glyphs, trails, grids): the path,
 * the app's `v` version when it is a small number, and our own cache
 * generation. Every other query parameter is dropped, so `?x=<random>` lands
 * on the same entry instead of forcing an R2 read (or a contour build).
 */
export function staticCacheUrl(url: URL, generation: string): string {
  const key = new URL(url.origin + url.pathname);
  const v = url.searchParams.get('v');
  if (v !== null && VERSION_PARAM.test(v)) key.searchParams.set('v', v);
  key.searchParams.set('__g', generation);
  return key.toString();
}

/** Longest code / refresh token the Strava proxy forwards (Strava's are 40 hex chars). */
export const STRAVA_MAX_TOKEN_LENGTH = 256;

/** An OAuth code or refresh token as Strava issues them: URL-safe, bounded. */
export function isPlausibleToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= STRAVA_MAX_TOKEN_LENGTH &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}

/**
 * The font stack of a glyph request, decoded; null when it is malformed or
 * not a plain font name ("Atkinson Hyperlegible Next Regular", optionally a
 * comma-joined stack). decodeURIComponent throws on a stray `%`, which used
 * to surface as a 502.
 */
export function glyphStack(raw: string): string | null {
  let stack: string;
  try {
    stack = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9 ,_-]{1,128}$/.test(stack) ? stack : null;
}

/**
 * The request body as text, or null when it is larger than `maxBytes`.
 * Streams with a running count, so a chunked body (no Content-Length) or a
 * Content-Length that lies can't make the Worker buffer megabytes first.
 */
export async function readTextCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Per-isolate sliding-window limiter: at most `limit` calls per `windowMs`
 * per key. A floor only (each isolate counts on its own); the binding is the
 * real limit. Forgets everything past `maxKeys` tracked clients.
 */
export function memoryLimiter(limit: number, windowMs: number, maxKeys = 5000) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    if (!hits.has(key) && hits.size >= maxKeys) hits.clear();
    hits.set(key, recent);
    return true;
  };
}

/**
 * Both limits must allow: the per-isolate floor first (it costs nothing), then
 * the binding when one is configured. A binding that errors fails open — a
 * broken limiter must not take the route down with it.
 */
export async function allowRequest(
  binding: RateLimitBinding | undefined,
  floor: (key: string) => boolean,
  key: string,
): Promise<boolean> {
  if (!floor(key)) return false;
  if (binding === undefined) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true;
  }
}

/** The client's address as Cloudflare saw it (the only key we rate-limit on). */
export function clientKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** A JSON 429 that tells well-behaved clients (MapLibre included) when to retry. */
export function tooManyRequests(
  cors: Record<string, string>,
  retryAfterS: number,
  body: Record<string, unknown> = { message: 'too many requests, try again shortly' },
): Response {
  return Response.json(body, {
    status: 429,
    headers: { ...cors, 'Cache-Control': 'no-store', 'Retry-After': String(retryAfterS) },
  });
}

/** UTC calendar day (`YYYY-MM-DD`) and the epoch ms when it ends. */
export function utcDay(now: number): { day: string; endsAt: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { day: new Date(start).toISOString().slice(0, 10), endsAt: start + 86_400_000 };
}

/** A positive integer from a `[vars]` string, else the fallback. */
export function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
