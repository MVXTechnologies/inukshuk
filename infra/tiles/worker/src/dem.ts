/**
 * Elevation tiles (#725): `GET /dem/{z}/{x}/{y}.png`, 256-px Terrarium PNG, z0–16.
 *
 * - Inside LiDAR coverage: the tile from our own archives (`dem-*.pmtiles`,
 *   listed in `dem.index.json`, built by ../../nas/dem.sh from Mapterhorn:
 *   NRCan HRDEM in Québec, swissALTI3D / BEV / IGN … in the Alps). Which tiles
 *   are in them is decided on the NAS (the LiDAR mask); here a tile is simply
 *   in an archive or not.
 * - Everywhere else: AWS Terrarium (the app's former source), passed through
 *   byte for byte, so one URL serves the whole world and coverage can grow
 *   without an app release.
 * - z16 outside coverage (AWS stops at z15): the z15 parent's quadrant,
 *   bilinearly upsampled and re-encoded, so MapLibre never meets a hole.
 *
 * PNG is already deflated: responses carry no Content-Encoding, and the cache
 * HIT path in index.ts re-sends exactly the stored bytes.
 *
 * Everything here is pure (deps injected), so the app's Jest runs it.
 */
import { decodeTerrariumPng } from './contourMath';

export const DEM_PATH = /^\/dem\/(\d{1,2})\/(\d+)\/(\d+)\.png$/;
export const DEM_MAX_ZOOM = 16;
export const AWS_TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/** AWS Terrarium's deepest zoom. */
export const AWS_MAX_ZOOM = 15;
export const DEM_TILE_SIZE = 256;

export interface DemPiece {
  name: string;
  /** [west, south, east, north], degrees. */
  bbox: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
}

export interface DemIndex {
  pieces: DemPiece[];
  /** Mapterhorn release the pieces were built from. */
  mapterhorn?: string;
  built?: string;
}

export type DemSource = 'lidar' | 'aws' | 'aws-upsampled';

export interface DemTile {
  png: Uint8Array;
  source: DemSource;
  /** The archive a `lidar` tile came from. */
  piece?: string;
}

export interface DemDeps {
  /** `dem.index.json`, or null before the first one is published. */
  index(): Promise<DemIndex | null>;
  /** A tile from `{piece}.pmtiles`, or undefined when the archive lacks it. */
  readTile(piece: string, z: number, x: number, y: number): Promise<Uint8Array | undefined>;
  /** An AWS Terrarium tile, or null on 404. Throws on any other failure. */
  fetchAws(z: number, x: number, y: number): Promise<Uint8Array | null>;
  /** zlib inflate / deflate (DecompressionStream / CompressionStream 'deflate'). */
  inflate(data: Uint8Array): Promise<Uint8Array>;
  deflate(data: Uint8Array): Promise<Uint8Array>;
}

export function parseDemPath(pathname: string): [number, number, number] | 'bad' | null {
  const m = DEM_PATH.exec(pathname);
  if (m === null) return null;
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (z > DEM_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return 'bad';
  return [z, x, y];
}

/** Tile bounds in degrees: [west, south, east, north]. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** The pieces that may hold z/x/y: zoom in range and bbox overlapping the tile. */
export function candidatePieces(
  index: DemIndex | null,
  z: number,
  x: number,
  y: number,
): DemPiece[] {
  if (index === null) return [];
  const [w, s, e, n] = tileBounds(z, x, y);
  return index.pieces.filter(
    ({ bbox: [pw, ps, pe, pn], minzoom, maxzoom }) =>
      z >= minzoom && z <= maxzoom && w < pe && e > pw && s < pn && n > ps,
  );
}

/** The tile for z/x/y, or null where nobody has one. */
export async function demTile(
  z: number,
  x: number,
  y: number,
  deps: DemDeps,
): Promise<DemTile | null> {
  for (const piece of candidatePieces(await deps.index(), z, x, y)) {
    const png = await deps.readTile(piece.name, z, x, y);
    if (png !== undefined) return { png, source: 'lidar', piece: piece.name };
  }
  if (z <= AWS_MAX_ZOOM) {
    const png = await deps.fetchAws(z, x, y);
    return png === null ? null : { png, source: 'aws' };
  }
  const shift = z - AWS_MAX_ZOOM;
  const parent = await deps.fetchAws(AWS_MAX_ZOOM, x >> shift, y >> shift);
  if (parent === null) return null;
  const dem = await decodeTerrariumPng(parent, deps.inflate);
  if (dem.width !== DEM_TILE_SIZE || dem.height !== DEM_TILE_SIZE) {
    throw new Error(`AWS tile ${dem.width}x${dem.height}`);
  }
  const span = DEM_TILE_SIZE >> shift;
  const heights = upsample(
    dem.data,
    DEM_TILE_SIZE,
    (x & ((1 << shift) - 1)) * span,
    (y & ((1 << shift) - 1)) * span,
    span,
    DEM_TILE_SIZE,
  );
  return {
    png: await encodeTerrariumPng(heights, DEM_TILE_SIZE, deps.deflate),
    source: 'aws-upsampled',
  };
}

/**
 * Bilinear resample of the `span`-pixel square at (x0, y0) of a `size`-wide
 * grid onto `out` × `out` pixels, pixel centres aligned (edges clamped).
 */
export function upsample(
  src: Float32Array,
  size: number,
  x0: number,
  y0: number,
  span: number,
  out: number,
): Float32Array {
  const dst = new Float32Array(out * out);
  const scale = span / out;
  const at = (i: number, j: number) => src[j * size + i]!;
  for (let j = 0; j < out; j++) {
    const sy = Math.min(Math.max(y0 + (j + 0.5) * scale - 0.5, 0), size - 1);
    const j0 = Math.floor(sy);
    const j1 = Math.min(j0 + 1, size - 1);
    const fy = sy - j0;
    for (let i = 0; i < out; i++) {
      const sx = Math.min(Math.max(x0 + (i + 0.5) * scale - 0.5, 0), size - 1);
      const i0 = Math.floor(sx);
      const i1 = Math.min(i0 + 1, size - 1);
      const fx = sx - i0;
      const top = at(i0, j0) * (1 - fx) + at(i1, j0) * fx;
      const bottom = at(i0, j1) * (1 - fx) + at(i1, j1) * fx;
      dst[j * out + i] = top * (1 - fy) + bottom * fy;
    }
  }
  return dst;
}

/** Terrarium RGB of a height: v = round((h + 32768) · 256), R G B = its three bytes. */
export function terrariumRgb(h: number): [number, number, number] {
  const v = Math.min(Math.max(Math.round((h + 32768) * 256), 0), 0xffffff);
  return [v >> 16, (v >> 8) & 255, v & 255];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The PNG / zlib CRC-32 of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGB Terrarium PNG of `heights` (size × size), "Sub"-filtered rows. */
export async function encodeTerrariumPng(
  heights: Float32Array,
  size: number,
  deflate: (raw: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const stride = size * 3;
  const raw = new Uint8Array(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1);
    raw[row] = 1; // Sub
    let pr = 0;
    let pg = 0;
    let pb = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = terrariumRgb(heights[y * size + x]!);
      const o = row + 1 + x * 3;
      raw[o] = (r - pr) & 255;
      raw[o + 1] = (g - pg) & 255;
      raw[o + 2] = (b - pb) & 255;
      pr = r;
      pg = g;
      pb = b;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Response headers for a DEM tile (no Content-Encoding: PNG is already deflated). */
export function demHeaders(
  tile: DemTile,
  cacheControl: string,
  cors: Record<string, string>,
  version?: string,
): Record<string, string> {
  return {
    ...cors,
    'Content-Type': 'image/png',
    'Cache-Control': cacheControl,
    'X-Dem-Source': tile.piece !== undefined ? `${tile.source}:${tile.piece}` : tile.source,
    ...(version !== undefined && tile.source === 'lidar' ? { 'X-Dem-Version': version } : {}),
  };
}

/** Parse `dem.index.json`; anything malformed counts as no index (AWS everywhere). */
export function parseDemIndex(json: unknown): DemIndex | null {
  if (json === null || typeof json !== 'object') return null;
  const pieces = (json as { pieces?: unknown }).pieces;
  if (!Array.isArray(pieces)) return null;
  const ok: DemPiece[] = [];
  for (const p of pieces as unknown[]) {
    if (p === null || typeof p !== 'object') return null;
    const { name, bbox, minzoom, maxzoom } = p as Record<string, unknown>;
    if (
      typeof name !== 'string' ||
      !/^dem-[a-z0-9_-]{1,40}$/.test(name) ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
      typeof minzoom !== 'number' ||
      typeof maxzoom !== 'number'
    ) {
      return null;
    }
    ok.push({ name, bbox: bbox as DemPiece['bbox'], minzoom, maxzoom });
  }
  const { mapterhorn, built } = json as { mapterhorn?: unknown; built?: unknown };
  return {
    pieces: ok,
    ...(typeof mapterhorn === 'string' ? { mapterhorn } : {}),
    ...(typeof built === 'string' ? { built } : {}),
  };
}
