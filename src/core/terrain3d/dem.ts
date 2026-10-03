/**
 * Terrarium DEM decoding and sampling for the native 3D terrain. The native
 * engines decode the PNGs themselves (C++ twin); these are the rules they
 * must follow, tested here.
 *
 * Rules:
 * - `h = R·256 + G + B/256 − 32768` metres.
 * - Outside [−12 000, 9 000] m (or not finite) is no-data → 0 (sea level).
 * - Bathymetry is clamped to sea level by default: the map draws water at
 *   its surface, so a draped sea floor would sink the coast into a trench.
 * - Samples sit at pixel centres: pixel i covers [i, i+1)/size and its value
 *   is at (i + ½)/size. Bilinear in between, with the neighbouring tiles'
 *   pixels across an edge when they are loaded, so adjacent terrain tiles
 *   agree exactly on their shared edge.
 */

export const TERRARIUM_OFFSET = 32768;
export const MIN_VALID_ELEVATION = -12000;
export const MAX_VALID_ELEVATION = 9000;
/** Terrarium tiles are 256 × 256. */
export const DEM_SIZE = 256;

export interface DecodeOptions {
  /** Clamp negative heights (bathymetry) to 0. Default true. */
  clampSeaLevel?: boolean;
}

/** One Terrarium pixel → metres, before sanitising. */
export function terrariumRaw(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - TERRARIUM_OFFSET;
}

/** One Terrarium pixel → metres, sanitised per the rules above. */
export function terrariumHeight(r: number, g: number, b: number, opts: DecodeOptions = {}): number {
  const h = terrariumRaw(r, g, b);
  if (!Number.isFinite(h) || h < MIN_VALID_ELEVATION || h > MAX_VALID_ELEVATION) return 0;
  if ((opts.clampSeaLevel ?? true) && h < 0) return 0;
  return h;
}

/** The inverse encoding (tests and fixtures): metres → [r, g, b]. */
export function encodeTerrarium(h: number): [number, number, number] {
  const v = h + TERRARIUM_OFFSET;
  const r = Math.floor(v / 256);
  const g = Math.floor(v - r * 256);
  const b = Math.round((v - r * 256 - g) * 256);
  // b may round up to 256 — carry it.
  if (b === 256) return g === 255 ? [r + 1, 0, 0] : [r, g + 1, 0];
  return [r, g, b];
}

/**
 * Decode interleaved pixels (`channels` = 3 for RGB, 4 for RGBA) into a
 * row-major height array. Alpha is ignored (Terrarium tiles are opaque).
 */
export function decodeTerrarium(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4 = 4,
  opts: DecodeOptions = {},
): Float32Array {
  const n = width * height;
  if (pixels.length < n * channels) {
    throw new Error(`decodeTerrarium: ${pixels.length} bytes for ${width}x${height}x${channels}`);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    out[i] = terrariumHeight(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!, opts);
  }
  return out;
}

export interface DemStats {
  min: number;
  max: number;
}

export function demStats(h: Float32Array): DemStats {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < h.length; i++) {
    const v = h[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { min: 0, max: 0 };
  return { min, max };
}

/** A DEM tile's own pixel, clamped into range. */
function px(h: Float32Array, size: number, ix: number, iy: number): number {
  const x = ix < 0 ? 0 : ix >= size ? size - 1 : ix;
  const y = iy < 0 ? 0 : iy >= size ? size - 1 : iy;
  return h[y * size + x]!;
}

/** Bilinear height at (u, v) ∈ [0, 1]² of one DEM tile, edges clamped. */
export function sampleDem(h: Float32Array, size: number, u: number, v: number): number {
  const fx = u * size - 0.5;
  const fy = v * size - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = px(h, size, x0, y0);
  const b = px(h, size, x0 + 1, y0);
  const c = px(h, size, x0, y0 + 1);
  const d = px(h, size, x0 + 1, y0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * A DEM tile and whichever of its 8 neighbours are loaded. `neighbor(dx, dy)`
 * returns the neighbour's heights or null.
 */
export interface DemNeighborhood {
  size: number;
  center: Float32Array;
  neighbor: (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => Float32Array | null;
}

/** A pixel of the 3×3 mosaic around the centre tile; missing neighbours clamp to the centre. */
export function mosaicPixel(n: DemNeighborhood, ix: number, iy: number): number {
  const s = n.size;
  const dx = ix < 0 ? -1 : ix >= s ? 1 : 0;
  const dy = iy < 0 ? -1 : iy >= s ? 1 : 0;
  if (dx === 0 && dy === 0) return n.center[iy * s + ix]!;
  const nb = n.neighbor(dx, dy);
  if (!nb) return px(n.center, s, ix, iy);
  const lx = ix - dx * s;
  const ly = iy - dy * s;
  return px(nb, s, lx, ly);
}

/**
 * Bilinear height at (u, v) of the centre tile, where u/v may step a little
 * outside [0, 1] into the neighbours (edge and slope samples).
 */
export function sampleMosaic(n: DemNeighborhood, u: number, v: number): number {
  const fx = u * n.size - 0.5;
  const fy = v * n.size - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = mosaicPixel(n, x0, y0);
  const b = mosaicPixel(n, x0 + 1, y0);
  const c = mosaicPixel(n, x0, y0 + 1);
  const d = mosaicPixel(n, x0 + 1, y0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Bytes a decoded DEM tile holds in the CPU cache. */
export function demBytes(size = DEM_SIZE): number {
  return size * size * 4;
}
