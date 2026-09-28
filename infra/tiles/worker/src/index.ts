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
}

const TILE_PATH = /^\/([a-z0-9_-]+)\/(\d{1,2})\/(\d+)\/(\d+)\.mvt$/;
const TILEJSON_PATH = /^\/([a-z0-9_-]+)\.json$/;
const GLYPH_PATH = /^\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/;

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
    if (object === null) return new Response('no such glyphs', { status: 404, headers: cors });
    return new Response(object.body, {
      headers: { ...cors, 'Content-Type': 'application/x-protobuf', 'Cache-Control': cacheControl },
    });
  }

  return new Response('not found', { status: 404, headers: cors });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { ...corsHeaders(request, env), 'Access-Control-Allow-Methods': 'GET' },
      });
    }
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

    const url = new URL(request.url);
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
