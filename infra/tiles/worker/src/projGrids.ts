/**
 * Grid packs for the app's Convert tool (built by ../nas/projgrids.sh):
 *
 *   /proj-grids/index.json                → R2 `proj-grids/index.json` (packs + bboxes)
 *   /proj-grids/{pack}/manifest.json      → R2 `proj-grids/{pack}/manifest.json`
 *   /proj-grids/{pack}/{file}.tif         → R2 `proj-grids/{pack}/{file}.tif`
 *
 * Plain R2 passthroughs (the free plan's CPU is plenty). A `.tif` is
 * immutable once published (its md5/sha256 are in the manifest, and a new
 * PROJ-data version means new bytes the app re-verifies), so it is cached
 * long; the index is short-lived so a new pack appears within hours. Range
 * requests are honoured for the larger national files.
 */

export interface GridBucket {
  get(
    key: string,
    options?: { range?: { offset: number; length?: number } },
  ): Promise<{ body: ReadableStream | null; size: number; httpEtag: string } | null>;
}

const INDEX = /^\/proj-grids\/index\.json$/;
const MANIFEST = /^\/proj-grids\/([a-z0-9-]{1,40})\/manifest\.json$/;
const GRID = /^\/proj-grids\/([a-z0-9-]{1,40})\/([A-Za-z0-9_.-]{1,80}\.tif)$/;
/** Upload keys the NAS may write (see upload() in index.ts). */
export const PROJ_GRID_UPLOAD_KEY =
  /^proj-grids\/(?:index\.json|[a-z0-9-]{1,40}\/(?:manifest\.json|[A-Za-z0-9_.-]{1,80}\.tif))$/;

export const INDEX_CACHE = 'public, max-age=3600';
export const GRID_CACHE = 'public, max-age=2592000';

export function isProjGridPath(pathname: string): boolean {
  return INDEX.test(pathname) || MANIFEST.test(pathname) || GRID.test(pathname);
}

/** Parse "bytes=a-b" (a single range only). */
function parseRange(h: string | null): { offset: number; length?: number } | null {
  if (!h) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(h.trim());
  if (!m) return null;
  const offset = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  if (end !== undefined && end < offset) return null;
  return end === undefined ? { offset } : { offset, length: end - offset + 1 };
}

export async function serveProjGrids(
  bucket: GridBucket,
  request: Request,
  pathname: string,
  cors: Record<string, string>,
): Promise<Response> {
  const notFound = () => new Response('not found', { status: 404, headers: cors });
  if (pathname.includes('..')) return notFound();
  const key = pathname.slice(1);
  if (INDEX.test(pathname) || MANIFEST.test(pathname)) {
    const obj = await bucket.get(key);
    if (obj === null || obj.body === null) return notFound();
    return new Response(obj.body, {
      headers: {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': INDEX_CACHE,
        ETag: obj.httpEtag,
      },
    });
  }
  if (!GRID.test(pathname)) return notFound();
  const range = parseRange(request.headers.get('Range'));
  const obj = await bucket.get(key, range ? { range } : undefined);
  if (obj === null || obj.body === null) return notFound();
  const headers: Record<string, string> = {
    ...cors,
    'Content-Type': 'image/tiff',
    'Cache-Control': GRID_CACHE,
    'Accept-Ranges': 'bytes',
    ETag: obj.httpEtag,
  };
  if (range) {
    const end = range.length !== undefined ? range.offset + range.length - 1 : obj.size - 1;
    headers['Content-Range'] = `bytes ${range.offset}-${end}/${obj.size}`;
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}
