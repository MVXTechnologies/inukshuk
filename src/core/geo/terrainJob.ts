import { decodePngPixels, encodeIndexedPng, pngPixelsToRgba } from '../encoding/pngCodec';
import { sampleGridBilinear } from './terrain';
import { slopeOverlayIndexed, type SlopeFilter } from './terrainAnalysis';

/**
 * The 2D map's whole terrain-overlay compute as ONE worklet (#722): Terrarium
 * PNG tiles in, slope-overlay PNG (and the contour heightmap) out. It runs on
 * a background worklet runtime, so the JS thread only reads tile files and
 * writes the result — touches, pans and long-presses stay responsive while
 * the slope computes. Pure: under Node/Jest it is a plain function, and it is
 * the inline fallback when no worklet runtime is available.
 */

export interface TerrainJobInput {
  /** Terrarium PNG bytes, row-major over `cols` × `rows` 256-px tiles. */
  tiles: Uint8Array[];
  /** Stable ids of `tiles` (e.g. `z/x/y`): enables the decoded-tile cache. */
  tileKeys?: string[];
  cols: number;
  rows: number;
  /** DEM zoom; the mosaic's row 0 is global pixel row `topRow` (256-px tiles). */
  z: number;
  topRow: number;
  /** Slope overlay window and downsample step, or null for no slope. */
  slope: { minDeg: number; maxDeg: number; step: number; filter?: SlopeFilter } | null;
  /** Side of the bilinear heightmap for contours; 0 = none. */
  heightmapGrid: number;
}

export interface TerrainJobOutput {
  /** Indexed slope-overlay PNG covering the whole mosaic, or null. */
  slopePng: Uint8Array | null;
  slopeWidth: number;
  slopeHeight: number;
  heightmap: { data: Float32Array; grid: number; minH: number; maxH: number } | null;
  /** Wall-clock ms per stage (measurement, #722). */
  timings: { decode: number; slope: number; encode: number; heightmap: number };
}

const TILE = 256;

/**
 * Smallest power-of-two step that brings the longer side to ≤ `maxPx`. A
 * power of two always divides the 256-px tile multiples of a mosaic, so the
 * image stays registered on the mosaic's corners.
 */
export function slopeStepFor(width: number, height: number, maxPx: number): number {
  'worklet';
  let s = 1;
  while (Math.max(width, height) / s > maxPx) s *= 2;
  return s;
}

/** Decoded tiles kept per runtime: a pan re-uses most of the last mosaic's tiles. */
export const DEM_TILE_CACHE_SIZE = 96; // × 256 KB

type TileCache = Map<string, Float32Array>;

/** The calling runtime's decoded-tile LRU (one per worklet runtime / JS realm). */
function tileCache(): TileCache {
  'worklet';
  const g = globalThis as unknown as { __inukshukDemTiles?: TileCache };
  if (g.__inukshukDemTiles === undefined) g.__inukshukDemTiles = new Map();
  return g.__inukshukDemTiles;
}

/** Drop the calling runtime's decoded tiles (tests; memory pressure). */
export function clearDemTileCache(): void {
  'worklet';
  tileCache().clear();
}

/** One Terrarium PNG tile → metres (256², row 0 = north). */
function decodeTerrariumTile(bytes: Uint8Array): Float32Array {
  'worklet';
  const img = decodePngPixels(bytes);
  if (img.width !== TILE || img.height !== TILE) throw new Error('terrain: tile is not 256 px');
  // RGB / RGBA samples are read in place; anything else goes through RGBA.
  const direct = img.colorType === 2 || img.colorType === 6;
  const px = direct ? img.px : pngPixelsToRgba(img);
  const ch = direct ? img.channels : 4;
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, j = 0; i < out.length; i++, j += ch) {
    // terrariumToMeters, inlined (4M calls per mosaic).
    out[i] = px[j]! * 256 + px[j + 1]! + px[j + 2]! / 256 - 32768;
  }
  return out;
}

/**
 * Decode Terrarium tiles into one elevation mosaic (metres, row 0 = north).
 * With `keys` (one stable id per tile, e.g. `z/x/y`), decoded tiles are kept
 * in a {@link DEM_TILE_CACHE_SIZE}-tile LRU and re-used by later mosaics.
 */
export function terrariumMosaic(
  tiles: Uint8Array[],
  cols: number,
  rows: number,
  keys?: string[],
): Float32Array {
  'worklet';
  const w = cols * TILE;
  const out = new Float32Array(w * rows * TILE);
  const cache = keys !== undefined ? tileCache() : null;
  for (let t = 0; t < tiles.length; t++) {
    const key = keys?.[t];
    let dem = cache !== null && key !== undefined ? cache.get(key) : undefined;
    if (dem === undefined) {
      dem = decodeTerrariumTile(tiles[t]!);
    } else {
      cache!.delete(key!); // refresh its LRU position
    }
    if (cache !== null && key !== undefined) {
      cache.set(key, dem);
      while (cache.size > DEM_TILE_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    }
    const ox = (t % cols) * TILE;
    const oy = Math.floor(t / cols) * TILE;
    for (let y = 0; y < TILE; y++)
      out.set(dem.subarray(y * TILE, (y + 1) * TILE), (oy + y) * w + ox);
  }
  return out;
}

export function runTerrainJob(input: TerrainJobInput): TerrainJobOutput {
  'worklet';
  const { cols, rows } = input;
  if (input.tiles.length !== cols * rows) throw new Error('terrain: tile count mismatch');
  const width = cols * TILE;
  const height = rows * TILE;
  let t0 = Date.now();
  const dem = terrariumMosaic(input.tiles, cols, rows, input.tileKeys);
  const timings = { decode: Date.now() - t0, slope: 0, encode: 0, heightmap: 0 };

  let slopePng: Uint8Array | null = null;
  let slopeWidth = 0;
  let slopeHeight = 0;
  if (input.slope !== null) {
    t0 = Date.now();
    const s = input.slope;
    const ix = slopeOverlayIndexed(
      dem,
      width,
      height,
      input.z,
      input.topRow,
      s.minDeg,
      s.maxDeg,
      s.step,
      s.filter,
    );
    timings.slope = Date.now() - t0;
    t0 = Date.now();
    slopePng = encodeIndexedPng(ix.width, ix.height, ix.indices, ix.palette.rgb, ix.palette.alpha);
    timings.encode = Date.now() - t0;
    slopeWidth = ix.width;
    slopeHeight = ix.height;
  }

  let heightmap: TerrainJobOutput['heightmap'] = null;
  const g = input.heightmapGrid;
  if (g > 1) {
    t0 = Date.now();
    const data = new Float32Array(g * g);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++) {
        const h = sampleGridBilinear(dem, width, height, gx / (g - 1), gy / (g - 1));
        data[gy * g + gx] = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    heightmap = { data, grid: g, minH, maxH };
    timings.heightmap = Date.now() - t0;
  }
  return { slopePng, slopeWidth, slopeHeight, heightmap, timings };
}
