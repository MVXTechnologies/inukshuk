/**
 * Inukshuk tile server: a Cloudflare Worker in front of an R2 bucket.
 *
 *   GET /{archive}/{z}/{x}/{y}.mvt        vector tile from {archive}.pmtiles
 *   GET /{archive}.json                   TileJSON for the archive
 *   GET /fonts/{fontstack}/{range}.pbf    MapLibre glyphs (static objects)
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
}

const TILE_PATH = /^\/([a-z0-9_-]+)\/(\d{1,2})\/(\d+)\/(\d+)\.mvt$/;
const TILEJSON_PATH = /^\/([a-z0-9_-]+)\.json$/;
const GLYPH_PATH = /^\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/;
const UPLOAD_PATH = /^\/_upload\/([a-z0-9_-]+\.pmtiles)$/;

/** Directories and headers, shared across requests handled by this isolate. */
const CACHE = new ResolvedValueCache(25, undefined, decompress);

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

  const tile = TILE_PATH.exec(url.pathname);
  const [, archive, zs, xs, ys] = tile ?? [];
  if (archive !== undefined) {
    const [z, x, y] = [Number(zs), Number(xs), Number(ys)];
    if (z > 22 || x >= 2 ** z || y >= 2 ** z)
      return new Response('bad tile', { status: 400, headers: cors });
    const pmtiles = new PMTiles(new R2Source(env.BUCKET, `${archive}.pmtiles`), CACHE, decompress);
    const header = await pmtiles.getHeader();
    if (header.tileType !== TileType.Mvt)
      return new Response('not a vector archive', { status: 500 });
    const found = await pmtiles.getZxy(z, x, y);
    // An empty tile (open ocean, outside the extract) is a 204: MapLibre draws nothing.
    if (found === undefined)
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Cache-Control': cacheControl },
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
    const pmtiles = new PMTiles(
      new R2Source(env.BUCKET, `${jsonArchive}.pmtiles`),
      CACHE,
      decompress,
    );
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
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { ...corsHeaders(request, env), 'Access-Control-Allow-Methods': 'GET' },
      });
    }
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;

    let response: Response;
    try {
      response = await serve(request, env, url);
    } catch (e) {
      return new Response(`tile error: ${(e as Error).message}`, { status: 502 });
    }
    if (response.status === 200 || response.status === 204)
      ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};
