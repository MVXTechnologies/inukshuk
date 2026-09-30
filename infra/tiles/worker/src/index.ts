/**
 * Inukshuk tile server: a Cloudflare Worker in front of an R2 bucket.
 *
 *   GET /{archive}/{z}/{x}/{y}.mvt        vector tile from {archive}.pmtiles
 *                                         (/basemap/… via basemap.index.json pieces,
 *                                         /peaks/… from peaks.pmtiles — ../nas/peaks.sh)
 *   GET /{archive}.json                   TileJSON for the archive
 *   GET /fonts/{fontstack}/{range}.pbf    MapLibre glyphs (static objects)
 *   POST /donors                         opt-in donor name, filed as pending in R2 (./donors.ts)
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
import { CONTOUR_MAX_ZOOM, contourTile } from './contours';
import { handleDonor, memoryLimiter } from './donors';

export interface Env {
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
}

const donorFallbackLimit = memoryLimiter();

async function donors(request: Request, env: Env): Promise<Response> {
  const client = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const length = Number(request.headers.get('Content-Length') ?? '0');
  if (length > 4096) return Response.json({ error: 'body too large' }, { status: 413 });
  const result = await handleDonor(
    { method: request.method, client, body: request.method === 'POST' ? await request.text() : '' },
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
/** Longest code / refresh token we forward (Strava's are 40 hex chars). */
const STRAVA_MAX_TOKEN_LENGTH = 256;

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
  const body = await request.json<Record<string, unknown>>().catch(() => null);
  const field = kind === 'token' ? 'code' : 'refresh_token';
  const value = body?.[field];
  if (typeof value !== 'string' || value === '' || value.length > STRAVA_MAX_TOKEN_LENGTH)
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
const UPLOAD_PATH = /^\/_upload\/([a-z0-9_-]+\.(?:pmtiles|index\.json))$/;
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

async function serve(request: Request, env: Env, url: URL): Promise<Response> {
  const cacheControl = env.CACHE_CONTROL ?? 'public, max-age=86400';
  const cors = corsHeaders(request, env);

  const [, cz, cx, cy] = CONTOUR_PATH.exec(url.pathname) ?? [];
  if (cz !== undefined && cx !== undefined && cy !== undefined) {
    const [z, x, y] = [Number(cz), Number(cx), Number(cy)];
    if (z > CONTOUR_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z)
      return new Response('bad tile', { status: 400, headers: cors });
    const mvt = await contourTile(z, x, y);
    const gzipped = await new Response(
      new Response(mvt).body!.pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    return new Response(gzipped, {
      headers: {
        ...cors,
        'Content-Type': 'application/x-protobuf',
        'Content-Encoding': 'gzip',
        // Terrain doesn't change: cache contour tiles for 30 days.
        'Cache-Control': 'public, max-age=2592000',
      },
      encodeBody: 'manual',
    });
  }

  const tile = TILE_PATH.exec(url.pathname);
  const [, archive, zs, xs, ys] = tile ?? [];
  if (archive !== undefined) {
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
    const first = (await piecesOf(env, jsonArchive))?.[0]?.name ?? jsonArchive;
    const pmtiles = new PMTiles(new R2Source(env.BUCKET, `${first}.pmtiles`), CACHE, decompress);
    const json = await pmtiles.getTileJson(`${url.origin}/${jsonArchive}`);
    return Response.json(json, { headers: { ...cors, 'Cache-Control': cacheControl } });
  }

  const [, stack, range] = GLYPH_PATH.exec(url.pathname) ?? [];
  if (stack !== undefined && range !== undefined) {
    // One font per stack: MapLibre asks for a comma-joined stack only when a
    // style mixes fonts, which ours never does.
    const object = await env.BUCKET.get(`fonts/${decodeURIComponent(stack)}/${range}.pbf`);
    // Only ranges the font covers are stored (Latin, punctuation, arrows…).
    // Any other range is answered with an EMPTY glyph message — valid
    // protobuf — so MapLibre skips those characters instead of logging a
    // failed request for every label that contains one.
    return new Response(object === null ? new Uint8Array(0) : object.body, {
      headers: { ...cors, 'Content-Type': 'application/x-protobuf', 'Cache-Control': cacheControl },
    });
  }

  return new Response('not found', { status: 404, headers: cors });
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
    const [, uploadKey] = UPLOAD_PATH.exec(url.pathname) ?? [];
    if (uploadKey !== undefined) {
      try {
        return await upload(request, env, url, uploadKey);
      } catch (e) {
        return new Response(`upload error: ${(e as Error).message}`, { status: 500 });
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
        headers: { ...corsHeaders(request, env), 'Access-Control-Allow-Methods': 'GET' },
      });
    }
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

    const cache = caches.default;
    const keyUrl = new URL(url);
    keyUrl.searchParams.set('__g', CACHE_GENERATION);
    const cacheKey = new Request(keyUrl.toString(), request);
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
      response = await serve(request, env, url);
    } catch (e) {
      return new Response(`tile error: ${(e as Error).message}`, { status: 502 });
    }
    if (response.status === 200 || response.status === 204)
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
