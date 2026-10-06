/**
 * Inukshuk tile server: a Cloudflare Worker in front of an R2 bucket.
 *
 *   GET /{archive}/{z}/{x}/{y}.mvt        vector tile from {archive}.pmtiles
 *                                         (/basemap/… via basemap.index.json pieces,
 *                                         /peaks/… from peaks.pmtiles — ../nas/peaks.sh,
 *                                         /parks/… from parks.pmtiles — ../nas/parks.sh)
 *   GET /{archive}.json                   TileJSON for the archive
 *   GET /contours/{z}/{x}/{y}.mvt         contour lines from DEM tiles, generated once
 *                                         and kept in R2 (./contours.ts)
 *   GET /fonts/{fontstack}/{range}.pbf    MapLibre glyphs (static objects)
 *   GET /trails/v1/index.json             long-distance trail index (trails-v1.index.json)
 *   GET /trails/v1/d/{version}/{id}.json  one trail's detail, range-read from
 *                                         trails-{version}.details.bin (../nas/trails.sh)
 *   GET /search?q=&lang=&alt=&lat=&lon=&limit=
 *                                         place search, proxied to Photon (./search.ts)
 *   POST /donors                         opt-in donor name, filed as pending in R2 (./donors.ts)
 *   POST /donor-verify/start|check      "I already donated" email code (./donorVerify.ts)
 *   POST /route {mode, profile, points}   route snapping for the drawing tool, proxied to
 *                                         BRouter (trails) / Valhalla (roads) (./route.ts)
 *
 * Each archive is ONE PMTiles file in R2 (see ../nas/). The pmtiles library
 * reads only the byte ranges a tile needs, and every response is cached at
 * Cloudflare's edge, so most requests never touch the bucket. Replacing an
 * archive in place is safe: a changed ETag invalidates the cached directory.
 */
import {
  Compression,
  EtagMismatch,
  PMTiles,
  ResolvedValueCache,
  TileType,
  type RangeResponse,
  type Source,
} from 'pmtiles';
import { decodeBudgetFrom } from './contourGrid';
import { contourR2Key } from './contourMath';
import { CONTOUR_MAX_ZOOM, contourTile } from './contours';
import { handleSearch, type SearchEnv } from './search';
import { isProjGridPath, PROJ_GRID_UPLOAD_KEY, serveProjGrids, type GridBucket } from './projGrids';
import { handleDonor, memoryLimiter } from './donors';
import {
  CODE_TTL_MS,
  codeEmail,
  handleVerify,
  PREFIX as VERIFY_PREFIX,
  randomCode,
  type PendingCode,
} from './donorVerify';

import { handleRoute, type RouteEnv } from './route';
import {
  allowRequest,
  archiveAllowlist,
  clientKey,
  glyphStack,
  isPlausibleToken,
  memoryLimiter as floorLimiter,
  positiveInt,
  readTextCapped,
  staticCacheUrl,
  tooManyRequests,
  utcDay,
  type RateLimitBinding,
} from './guards';

export interface Env extends SearchEnv, RouteEnv {
  BUCKET: R2Bucket;
  /** Comma-separated origins for CORS, or "*" (the app is native; browsers are for debugging). */
  ALLOWED_ORIGINS?: string;
  /** Edge + client cache lifetime for tiles and glyphs. */
  CACHE_CONTROL?: string;
  /**
   * Bearer token for the archive upload endpoint (`wrangler secret put
   * UPLOAD_TOKEN`). Unset = uploads disabled (404).
   */
  UPLOAD_TOKEN?: string;
  /** Strava API app id (public; `[vars]`). Unset = the token proxy answers 404. */
  STRAVA_CLIENT_ID?: string;
  /** Strava API app secret (`wrangler secret put STRAVA_CLIENT_SECRET`). */
  STRAVA_CLIENT_SECRET?: string;
  /**
   * Workers rate-limiting binding for `POST /donors` (`[[ratelimits]]` in
   * wrangler.toml). Unset = a best-effort per-isolate limit.
   */
  DONOR_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /**
   * "I already donated" (`/donor-verify/*`, ./donorVerify.ts). Both secrets
   * must be set (`wrangler secret put …`) or the routes answer 404.
   */
  DONOR_VERIFY_SALT?: string;
  RESEND_API_KEY?: string;
  /** Sender for the code email; defaults to Inukshuk <no-reply@mvxtechnologies.com>. */
  VERIFY_FROM?: string;
  /**
   * DEM tiles one contour request may decode itself (DEFAULT_DECODE_BUDGET in
   * ./contourGrid.ts). "9" on the Workers Paid plan: every tile is full on
   * its first request.
   */
  CONTOUR_DECODE_BUDGET?: string;
  /** Archives served as /{archive}/… (comma separated); default DEFAULT_ARCHIVES in ./guards.ts. */
  ARCHIVES?: string;
  /**
   * Contour tiles one client may have GENERATED per minute (an R2 miss: DEM
   * fetches, CPU, an R2 write). Stored and edge-cached tiles don't count.
   * `[[ratelimits]]` binding CONTOUR_LIMITER; CONTOUR_GEN_PER_MIN is the
   * per-isolate floor (default 300).
   */
  CONTOUR_LIMITER?: RateLimitBinding;
  CONTOUR_GEN_PER_MIN?: string;
  /** `[[ratelimits]]` binding for the Strava token proxy (per client IP). */
  STRAVA_LIMITER?: RateLimitBinding;
  /** Code emails /donor-verify/start may send per UTC day, all addresses together (default 100). */
  VERIFY_DAILY_SEND_CAP?: string;
}

const donorFallbackLimit = memoryLimiter();
/** Per-isolate hourly cap on verify requests per client, on top of the binding. */
const verifyFallbackLimit = memoryLimiter(10, 60 * 60_000);
/** Per-isolate floor for the Strava token proxy: 30 exchanges/refreshes per client per hour. */
const stravaFloor = floorLimiter(30, 60 * 60_000);
/** Largest JSON body the small POST routes accept. */
const VERIFY_MAX_BODY = 1024;
const DONOR_MAX_BODY = 4096;
const STRAVA_MAX_BODY = 1024;
const DEFAULT_VERIFY_DAILY_SEND_CAP = 100;
/** R2 counter of today's code emails (swept by the verify sweep the next day). */
const sendCounterKey = (day: string) => `${VERIFY_PREFIX}_sends-${day}.json`;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function donorVerify(
  request: Request,
  env: Env,
  route: 'start' | 'check',
): Promise<Response> {
  const salt = env.DONOR_VERIFY_SALT;
  const resendKey = env.RESEND_API_KEY;
  if (!salt || !resendKey) return new Response('not found', { status: 404 });
  const body = request.method === 'POST' ? await readTextCapped(request, VERIFY_MAX_BODY) : '';
  if (body === null) return Response.json({ ok: false, error: 'body too large' }, { status: 400 });
  const client = clientKey(request);
  const result = await handleVerify(
    { route, method: request.method, client, body },
    {
      get: async (key) => {
        const object = await env.BUCKET.get(key);
        return object === null ? null : ((await object.json()) as PendingCode);
      },
      put: async (key, value) => {
        await env.BUCKET.put(key, JSON.stringify(value), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: {
            expiresAt: String(Math.max(value.expiresAt, Date.now() + CODE_TTL_MS)),
          },
        });
      },
      delete: async (key) => {
        await env.BUCKET.delete(key);
      },
      sweep: async (now) => {
        const listed = await env.BUCKET.list({
          prefix: VERIFY_PREFIX,
          limit: 100,
          include: ['customMetadata'],
        });
        const stale = listed.objects
          .filter((o) => Number(o.customMetadata?.expiresAt ?? 0) + 60 * 60_000 < now)
          .map((o) => o.key);
        if (stale.length > 0) await env.BUCKET.delete(stale);
      },
      allow: async (key) => {
        if (!(await verifyFallbackLimit(key))) return false;
        return env.DONOR_LIMITER ? (await env.DONOR_LIMITER.limit({ key })).success : true;
      },
      hmac: (message) => hmacHex(salt, message),
      code: () => randomCode((a) => crypto.getRandomValues(a)),
      sendCode: async (email, code) => {
        const { subject, text } = codeEmail(code);
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: env.VERIFY_FROM ?? 'Inukshuk <no-reply@mvxtechnologies.com>',
            to: [email],
            subject,
            text,
          }),
        });
        return res.ok;
      },
      allowSend: async (now) => {
        // A soft cap (two concurrent starts can both read the same count),
        // which is all a quota guard needs.
        const cap = positiveInt(env.VERIFY_DAILY_SEND_CAP, DEFAULT_VERIFY_DAILY_SEND_CAP);
        const { day, endsAt } = utcDay(now);
        const key = sendCounterKey(day);
        const object = await env.BUCKET.get(key);
        const sent =
          object === null ? 0 : Number((await object.json<{ sent?: number }>()).sent ?? 0);
        if (sent >= cap) return false;
        await env.BUCKET.put(key, JSON.stringify({ sent: sent + 1 }), {
          httpMetadata: { contentType: 'application/json' },
          // The sweep deletes it an hour after the day ends.
          customMetadata: { expiresAt: String(endsAt) },
        });
        return true;
      },
      now: () => Date.now(),
    },
  );
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function donors(request: Request, env: Env): Promise<Response> {
  const client = clientKey(request);
  const body = request.method === 'POST' ? await readTextCapped(request, DONOR_MAX_BODY) : '';
  if (body === null) return Response.json({ error: 'body too large' }, { status: 413 });
  const result = await handleDonor(
    { method: request.method, client, body },
    {
      put: async (key, json) => {
        await env.BUCKET.put(key, json, { httpMetadata: { contentType: 'application/json' } });
      },
      allow: async (key) =>
        env.DONOR_LIMITER
          ? (await env.DONOR_LIMITER.limit({ key })).success
          : donorFallbackLimit(key),
      now: () => new Date(),
      random: () => crypto.randomUUID().slice(0, 8),
    },
  );
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

/**
 * Strava token proxy: `POST /strava/token {code}` and
 * `POST /strava/refresh {refresh_token}`. Strava has no PKCE, and its API
 * agreement forbids shipping the client secret in an app, so the app sends
 * only the code or refresh token and we add the id + secret here. Strava's
 * answer (status + JSON) goes back untouched; nothing is stored or cached.
 */
async function stravaToken(request: Request, env: Env, kind: string): Promise<Response> {
  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET)
    return new Response('not found', { status: 404 });
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  // The proxy spends our Strava app's standing (its client secret, its
  // athlete cap, Strava's view of its traffic): a client hammering it with
  // junk is cut off before anything reaches Strava.
  if (!(await allowRequest(env.STRAVA_LIMITER, stravaFloor, `strava:${clientKey(request)}`)))
    return tooManyRequests({}, 60, { message: 'too many requests, try again later' });
  const text = await readTextCapped(request, STRAVA_MAX_BODY);
  let body: unknown = null;
  try {
    body = text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    body = null;
  }
  const field = kind === 'token' ? 'code' : 'refresh_token';
  const value =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)[field]
      : undefined;
  if (!isPlausibleToken(value))
    return Response.json({ message: `${field} required` }, { status: 400 });

  const form = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    [field]: value,
    grant_type: kind === 'token' ? 'authorization_code' : 'refresh_token',
  });
  const upstream = await fetch(STRAVA_TOKEN_URL, { method: 'POST', body: form });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Bump when cached answers must stop being reused (e.g. a region that used to
 * answer 204 now has data): the edge cache is keyed on this, so old entries are
 * simply never read again. workers.dev has no zone to purge.
 */
const CACHE_GENERATION = '2';
/** "No data here" can change when coverage grows: don't hold it for a day. */
const EMPTY_CACHE_CONTROL = 'public, max-age=3600';

const TILE_PATH = /^\/([a-z0-9_-]+)\/(\d{1,2})\/(\d+)\/(\d+)\.mvt$/;
const TILEJSON_PATH = /^\/([a-z0-9_-]+)\.json$/;
const CONTOUR_PATH = /^\/contours\/(\d{1,2})\/(\d+)\/(\d+)\.mvt$/;
const GLYPH_PATH = /^\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/;
const UPLOAD_PATH =
  /^\/_upload\/([a-z0-9_-]+\.(?:pmtiles|index\.json|details\.bin|offsets\.json))$/;
const TRAILS_INDEX_PATH = /^\/trails\/v1\/index\.json$/;
const TRAILS_DETAIL_PATH = /^\/trails\/v1\/d\/([a-z0-9_-]{1,40})\/(r\d{1,12})\.json$/;
const STRAVA_PATH = /^\/strava\/(token|refresh)$/;

/** Directories and headers, shared across requests handled by this isolate. */
const CACHE = new ResolvedValueCache(25, undefined, decompress);

/**
 * A large base map is published as several regional archives (the NAS can't
 * extract Canada + US + Europe in one go — the directory doesn't fit in its
 * RAM), listed in `{archive}.index.json`:
 *   { "pieces": [{ "name": "basemap-na-west", "bbox": [w, s, e, n] }, …] }
 * A tile is served from the first piece whose bbox touches it. Without an
 * index, `{archive}.pmtiles` itself is served. Uploading the index LAST makes
 * a refresh switch over atomically.
 */
interface Piece {
  name: string;
  bbox: [number, number, number, number];
}
const INDEX_TTL_MS = 5 * 60_000;
const indexes = new Map<string, { at: number; pieces: Piece[] | null }>();

async function piecesOf(env: Env, archive: string): Promise<Piece[] | null> {
  const cached = indexes.get(archive);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.pieces;
  const object = await env.BUCKET.get(`${archive}.index.json`);
  const pieces = object === null ? null : ((await object.json()) as { pieces: Piece[] }).pieces;
  indexes.set(archive, { at: Date.now(), pieces });
  return pieces;
}

/** Tile bounds in degrees: [west, south, east, north]. */
function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** The archive a tile comes from: its piece, the archive itself, or null (no data). */
async function archiveFor(
  env: Env,
  archive: string,
  z: number,
  x: number,
  y: number,
): Promise<string | null> {
  const pieces = await piecesOf(env, archive);
  if (pieces === null) return archive;
  const [w, s, e, n] = tileBounds(z, x, y);
  const hit = pieces.find(({ bbox: [pw, ps, pe, pn] }) => w < pe && e > pw && s < pn && n > ps);
  return hit?.name ?? null;
}

class R2Source implements Source {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(
    offset: number,
    length: number,
    _signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    const object = await this.bucket.get(this.key, {
      range: { offset, length },
      onlyIf: etag ? { etagMatches: etag } : undefined,
    });
    if (object === null) throw new Error(`missing archive ${this.key}`);
    // A precondition failure returns metadata without a body: the archive changed.
    if (!('body' in object)) throw new EtagMismatch();
    return { data: await object.arrayBuffer(), etag: object.etag };
  }
}

async function decompress(buf: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) return buf;
  if (compression !== Compression.Gzip) throw new Error('unsupported compression');
  const stream = new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map((o) => o.trim());
  const origin = request.headers.get('Origin');
  if (allowed.includes('*')) return { 'Access-Control-Allow-Origin': '*' };
  if (origin !== null && allowed.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return {};
}

/** Terrain doesn't change: contour tiles are cached for 30 days. */
const CONTOUR_CACHE_CONTROL = 'public, max-age=2592000';
/**
 * A partial tile (the decode budget ran out, ./contours.ts) is good enough to
 * draw but must not stick: a few seconds at the edge and on the phone, so the
 * next request for it reaches the Worker again — by then the DEM tiles it
 * lacked are decoded.
 */
const CONTOUR_PARTIAL_CACHE_CONTROL = 'public, max-age=15';
const DEFAULT_CONTOUR_GEN_PER_MIN = 300;
/** Per-isolate generation floor, rebuilt only if CONTOUR_GEN_PER_MIN changes. */
let contourFloorState: { perMin: number; allow: (key: string) => boolean } | undefined;
function contourFloor(perMin: number): (key: string) => boolean {
  if (contourFloorState?.perMin !== perMin) {
    contourFloorState = { perMin, allow: floorLimiter(perMin, 60_000) };
  }
  return contourFloorState.allow;
}

/**
 * A contour tile (#509): from R2 when it was generated before, else generated
 * now and written to R2 after the response — so each tile costs its CPU once
 * ever, not once per edge location per 30 days. The edge cache in `fetch`
 * still answers most requests before we get here. `X-Contour-Source` says
 * which: `r2`, `generated`, or `partial` (never stored).
 */
async function serveContours(
  env: Env,
  ctx: ExecutionContext,
  cors: Record<string, string>,
  client: string,
  z: number,
  x: number,
  y: number,
): Promise<Response> {
  const headers = {
    ...cors,
    'Content-Type': 'application/x-protobuf',
    'Content-Encoding': 'gzip',
    'Cache-Control': CONTOUR_CACHE_CONTROL,
  };
  const key = contourR2Key(z, x, y);
  // A storage hiccup must not cost the tile: fall through to generating it.
  const stored = await env.BUCKET.get(key).catch(() => null);
  if (stored !== null) {
    return new Response(stored.body, {
      headers: { ...headers, 'X-Contour-Source': 'r2' },
      encodeBody: 'manual',
    });
  }
  // Generating is the expensive path (DEM fetches, CPU, an R2 write, once per
  // tile ever). One client may only make so many new tiles a minute; MapLibre
  // (offline packs included) honours 429 + Retry-After and comes back.
  const floor = contourFloor(positiveInt(env.CONTOUR_GEN_PER_MIN, DEFAULT_CONTOUR_GEN_PER_MIN));
  if (!(await allowRequest(env.CONTOUR_LIMITER, floor, `contours:${client}`))) {
    return tooManyRequests(cors, 30);
  }
  const { mvt, partial } = await contourTile(z, x, y, {
    decodeBudget: decodeBudgetFrom(env.CONTOUR_DECODE_BUDGET),
  });
  const gzipped = await new Response(
    new Response(mvt).body!.pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  if (partial) {
    return new Response(gzipped, {
      headers: {
        ...headers,
        'Cache-Control': CONTOUR_PARTIAL_CACHE_CONTROL,
        'X-Contour-Source': 'partial',
      },
      encodeBody: 'manual',
    });
  }
  ctx.waitUntil(
    env.BUCKET.put(key, gzipped, {
      httpMetadata: { contentType: 'application/x-protobuf', contentEncoding: 'gzip' },
    }).catch(() => undefined),
  );
  return new Response(gzipped, {
    headers: { ...headers, 'X-Contour-Source': 'generated' },
    encodeBody: 'manual',
  });
}

async function serve(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const cacheControl = env.CACHE_CONTROL ?? 'public, max-age=86400';
  const cors = corsHeaders(request, env);

  const [, cz, cx, cy] = CONTOUR_PATH.exec(url.pathname) ?? [];
  if (cz !== undefined && cx !== undefined && cy !== undefined) {
    const [z, x, y] = [Number(cz), Number(cx), Number(cy)];
    if (z > CONTOUR_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z)
      return new Response('bad tile', { status: 400, headers: cors });
    return serveContours(env, ctx, cors, clientKey(request), z, x, y);
  }

  const archives = archiveAllowlist(env.ARCHIVES);
  const tile = TILE_PATH.exec(url.pathname);
  const [, archive, zs, xs, ys] = tile ?? [];
  if (archive !== undefined) {
    if (!archives.has(archive)) return new Response('not found', { status: 404, headers: cors });
    const [z, x, y] = [Number(zs), Number(xs), Number(ys)];
    if (z > 22 || x >= 2 ** z || y >= 2 ** z)
      return new Response('bad tile', { status: 400, headers: cors });
    const source = await archiveFor(env, archive, z, x, y);
    if (source === null)
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Cache-Control': EMPTY_CACHE_CONTROL },
      });
    const pmtiles = new PMTiles(new R2Source(env.BUCKET, `${source}.pmtiles`), CACHE, decompress);
    const header = await pmtiles.getHeader();
    if (header.tileType !== TileType.Mvt)
      return new Response('not a vector archive', { status: 500 });
    const found = await pmtiles.getZxy(z, x, y);
    // An empty tile (open ocean, outside the extract) is a 204: MapLibre draws nothing.
    if (found === undefined)
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Cache-Control': EMPTY_CACHE_CONTROL },
      });
    // The library hands back the tile DEcompressed; gzip it again (vector
    // tiles shrink ~30-40 %) and say so, sending the bytes as they are.
    const gzipped = await new Response(
      new Response(found.data).body!.pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    return new Response(gzipped, {
      headers: {
        ...cors,
        'Content-Type': 'application/x-protobuf',
        'Content-Encoding': 'gzip',
        'Cache-Control': cacheControl,
      },
      encodeBody: 'manual',
    });
  }

  const [, jsonArchive] = TILEJSON_PATH.exec(url.pathname) ?? [];
  if (jsonArchive !== undefined) {
    if (!archives.has(jsonArchive)) {
      return new Response('not found', { status: 404, headers: cors });
    }
    const first = (await piecesOf(env, jsonArchive))?.[0]?.name ?? jsonArchive;
    const pmtiles = new PMTiles(new R2Source(env.BUCKET, `${first}.pmtiles`), CACHE, decompress);
    const json = await pmtiles.getTileJson(`${url.origin}/${jsonArchive}`);
    return Response.json(json, { headers: { ...cors, 'Cache-Control': cacheControl } });
  }

  const [, rawStack, range] = GLYPH_PATH.exec(url.pathname) ?? [];
  if (rawStack !== undefined && range !== undefined) {
    const stack = glyphStack(rawStack);
    if (stack === null) return new Response('bad font stack', { status: 400, headers: cors });
    // One font per stack: MapLibre asks for a comma-joined stack only when a
    // style mixes fonts, which ours never does.
    const object = await env.BUCKET.get(`fonts/${stack}/${range}.pbf`);
    // Only ranges the font covers are stored (Latin, punctuation, arrows…).
    // Any other range is answered with an EMPTY glyph message — valid
    // protobuf — so MapLibre skips those characters instead of logging a
    // failed request for every label that contains one.
    return new Response(object === null ? new Uint8Array(0) : object.body, {
      headers: { ...cors, 'Content-Type': 'application/x-protobuf', 'Cache-Control': cacheControl },
    });
  }

  if (TRAILS_INDEX_PATH.test(url.pathname) || TRAILS_DETAIL_PATH.test(url.pathname)) {
    return serveTrails(env, url, cors);
  }

  if (isProjGridPath(url.pathname)) {
    return serveProjGrids(env.BUCKET as unknown as GridBucket, request, url.pathname, cors);
  }

  return new Response('not found', { status: 404, headers: cors });
}

/**
 * Long-distance trails (#467, built monthly by ../nas/trails.sh):
 *
 * - `/trails/v1/index.json` is the object `trails-v1.index.json`, replaced in
 *   place each month (short cache: the app switches within hours);
 * - `/trails/v1/d/{version}/{id}.json` is one trail's slice of
 *   `trails-{version}.details.bin`, found through `trails-{version}.offsets.json`
 *   ({id: [offset, length]}). The version is in the URL, so a detail never
 *   changes once published and caches for a month.
 *
 * One details object instead of tens of thousands of small ones keeps the
 * monthly upload to three files (the index goes up last, so the switch-over
 * is atomic: the index never names a version whose files aren't there yet).
 */
const TRAILS_INDEX_CACHE = 'public, max-age=21600';
const TRAILS_DETAIL_CACHE = 'public, max-age=2592000, immutable';
const OFFSETS_TTL_MS = 60 * 60_000;
const trailOffsets = new Map<string, { at: number; offsets: Record<string, [number, number]> }>();

async function offsetsFor(
  env: Env,
  version: string,
): Promise<Record<string, [number, number]> | null> {
  const hit = trailOffsets.get(version);
  if (hit && Date.now() - hit.at < OFFSETS_TTL_MS) return hit.offsets;
  const object = await env.BUCKET.get(`trails-${version}.offsets.json`);
  if (object === null) return null;
  const offsets = await object.json<Record<string, [number, number]>>();
  trailOffsets.set(version, { at: Date.now(), offsets });
  return offsets;
}

async function serveTrails(env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const json = { ...cors, 'Content-Type': 'application/json; charset=utf-8' };
  if (TRAILS_INDEX_PATH.test(url.pathname)) {
    const object = await env.BUCKET.get('trails-v1.index.json');
    if (object === null) return new Response('not found', { status: 404, headers: cors });
    return new Response(object.body, {
      headers: { ...json, 'Cache-Control': TRAILS_INDEX_CACHE, ETag: object.httpEtag },
    });
  }
  const [, version, id] = TRAILS_DETAIL_PATH.exec(url.pathname) ?? [];
  if (version === undefined || id === undefined) {
    return new Response('not found', { status: 404, headers: cors });
  }
  const entry = (await offsetsFor(env, version))?.[id];
  if (entry === undefined) return new Response('not found', { status: 404, headers: cors });
  const [offset, length] = entry;
  const object = await env.BUCKET.get(`trails-${version}.details.bin`, {
    range: { offset, length },
  });
  if (object === null || !('body' in object)) {
    return new Response('not found', { status: 404, headers: cors });
  }
  return new Response(object.body, { headers: { ...json, 'Cache-Control': TRAILS_DETAIL_CACHE } });
}

/** Constant-time string comparison for the upload token. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Archive upload, so the NAS can publish a multi-GB PMTiles file through R2's
 * multipart API without S3 credentials (`../nas/upload.py`):
 *
 *   POST /_upload/{key}?action=create                    → { uploadId }
 *   PUT  /_upload/{key}?uploadId=…&part=N  (≤ 95 MB)     → { partNumber, etag }
 *   POST /_upload/{key}?action=complete&uploadId=…  { parts: [{ partNumber, etag }] }
 *   POST /_upload/{key}?action=abort&uploadId=…
 *
 * Bearer-token protected; the object replaces the old one only on `complete`.
 */
async function upload(request: Request, env: Env, url: URL, key: string): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? '';
  if (!env.UPLOAD_TOKEN) return new Response('not found', { status: 404 });
  if (!sameToken(auth, `Bearer ${env.UPLOAD_TOKEN}`))
    return new Response('forbidden', { status: 403 });

  const action = url.searchParams.get('action');
  const uploadId = url.searchParams.get('uploadId');
  if (request.method === 'POST' && action === 'create') {
    const mpu = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    return Response.json({ uploadId: mpu.uploadId });
  }
  if (uploadId === null) return new Response('uploadId required', { status: 400 });
  const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);

  if (request.method === 'PUT') {
    const part = Number(url.searchParams.get('part'));
    if (!Number.isInteger(part) || part < 1 || part > 10_000 || request.body === null) {
      return new Response('bad part', { status: 400 });
    }
    const uploaded = await mpu.uploadPart(part, request.body);
    return Response.json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
  }
  if (request.method === 'POST' && action === 'complete') {
    const { parts } = await request.json<{ parts: R2UploadedPart[] }>();
    const object = await mpu.complete(parts);
    return Response.json({ key: object.key, size: object.size, etag: object.etag });
  }
  if (request.method === 'POST' && action === 'abort') {
    await mpu.abort();
    return Response.json({ aborted: true });
  }
  return new Response('bad request', { status: 400 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const gridKey = url.pathname.startsWith('/_upload/proj-grids/')
      ? url.pathname.slice('/_upload/'.length)
      : undefined;
    const [, archiveKey] = UPLOAD_PATH.exec(url.pathname) ?? [];
    const uploadKey =
      archiveKey ??
      (gridKey !== undefined && PROJ_GRID_UPLOAD_KEY.test(gridKey) ? gridKey : undefined);
    if (uploadKey !== undefined) {
      try {
        return await upload(request, env, url, uploadKey);
      } catch (e) {
        return new Response(`upload error: ${(e as Error).message}`, { status: 500 });
      }
    }
    const [, verifyRoute] = /^\/donor-verify\/(start|check)$/.exec(url.pathname) ?? [];
    if (verifyRoute === 'start' || verifyRoute === 'check') {
      try {
        return await donorVerify(request, env, verifyRoute);
      } catch {
        return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
      }
    }
    if (url.pathname === '/donors') {
      try {
        return await donors(request, env);
      } catch {
        return Response.json({ error: 'could not save' }, { status: 500 });
      }
    }
    const [, stravaKind] = STRAVA_PATH.exec(url.pathname) ?? [];
    if (stravaKind !== undefined) {
      try {
        return await stravaToken(request, env, stravaKind);
      } catch {
        return Response.json({ message: 'Strava unreachable' }, { status: 502 });
      }
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          ...corsHeaders(request, env),
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    // Route snapping: POST, its own cache key, rate limit and error answers.
    if (url.pathname === '/route') {
      return handleRoute(
        request,
        env,
        {
          fetch: (input, init) => fetch(input, init),
          cache: caches.default,
          waitUntil: (p) => ctx.waitUntil(p),
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
        corsHeaders(request, env),
      );
    }
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

    // Place search (#496): its own cache key, rate limit and error answers.
    if (url.pathname === '/search') {
      return handleSearch(
        request,
        env,
        {
          fetch: (input, init) => fetch(input, init),
          cache: caches.default,
          waitUntil: (p) => ctx.waitUntil(p),
          now: () => Date.now(),
        },
        corsHeaders(request, env),
      );
    }

    const cache = caches.default;
    // Path + the app's ?v= only: a random query string must not buy a miss.
    const cacheKey = new Request(staticCacheUrl(url, CACHE_GENERATION), request);
    const hit = await cache.match(cacheKey);
    // Our tiles are stored ALREADY gzipped (Content-Encoding: gzip). Handing
    // the cached Response straight back lets Cloudflare gzip it a SECOND time
    // — every cache HIT reached clients double-compressed and MapLibre saw
    // garbage (first load fine, later loads blank). Re-wrap with
    // encodeBody 'manual' so the stored bytes go out as they are.
    if (hit) {
      return new Response(hit.body, {
        status: hit.status,
        headers: hit.headers,
        encodeBody: hit.headers.get('Content-Encoding') === 'gzip' ? 'manual' : 'automatic',
      });
    }

    let response: Response;
    try {
      response = await serve(request, env, ctx, url);
    } catch (e) {
      // Logged for `wrangler tail`; the client gets no internals (R2 keys, stack).
      console.error('serve failed', url.pathname, e);
      return new Response('tile error', { status: 502 });
    }
    if (response.status === 200 || response.status === 204)
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
