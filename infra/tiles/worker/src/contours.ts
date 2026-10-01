/**
 * Contour-line vector tiles, generated on demand from the same Terrarium DEM
 * the app already uses:
 *
 *   GET /contours/{z}/{x}/{y}.mvt   layer "contours", properties ele (m), level (0 minor, 1 major)
 *
 * Because they are ordinary vector tiles, MapLibre loads them around the
 * viewport with the base map (no computed "window" that pans into blank), and
 * offline packs store them. The isolines come from maplibre-contour; the rest
 * is ours (./contourMath.ts) to keep a tile inside the free plan's 10 ms of
 * CPU (#509 — Alpine tiles took 15–30 ms and some died with error 1102):
 *
 * - DEM PNGs are inflated by the runtime's native DecompressionStream, not
 *   fast-png's pure-JS inflate (≈ 1.9 → 1.2 ms a DEM tile measured in Node;
 *   up to 5 per contour tile);
 * - decoded DEM tiles are kept per isolate (LRU) and shared by concurrent
 *   requests, so a viewport's burst decodes each DEM tile once;
 * - steep regions get a coarser interval (adaptiveLevels) — each line then
 *   carries `k` (lines of the zoom's own interval it stands for) and `s` (a
 *   steepness class), so the style can keep steep walls dark — lines are
 *   simplified, tiny rings and below-sea-level lines dropped.
 *
 * index.ts stores every generated tile in R2, so each is computed once ever.
 */
import mlcontour from 'maplibre-contour';
import { decode } from 'fast-png';
import {
  adaptiveLevels,
  cellReliefAt,
  cleanIsolines,
  CONTOUR_EXTENT,
  contourLevels,
  decodeTerrariumPng,
  DENSITY_REGION_ZOOMS,
  encodeContourMvt,
  Lru,
  OVERZOOMED_FROM,
  simplifyTolerance,
  steepestBlockRelief,
  tinyRingSpan,
  UnsupportedPng,
  type ContourLevels,
  type DemPixels,
} from './contourMath';

export { CONTOUR_MAX_ZOOM, contourLevels } from './contourMath';

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/** Terrarium's deepest zoom. */
const DEM_MAX_ZOOM = 15;
/** A contour tile at z is cut from the DEM at z − 1 (a 128-px quadrant + 3 neighbours). */
const OVERZOOM = 1;
/** Grids narrower than this are bilinearly upsampled first (smoother lines). */
const SUBSAMPLE_BELOW = 100;
const BUFFER = 1;
/** Heights below this are clamped: no bathymetry contours (the style hides ≤ 0 m anyway). */
const SEA_FLOOR_M = -1;
/** Decoded DEM tiles kept per isolate (256 KB each). */
const DEM_CACHE_TILES = 48;
const DEM_TIMEOUT_MS = 15_000;

type HeightTile = InstanceType<typeof mlcontour.HeightTile>;
const { HeightTile, generateIsolines } = mlcontour;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** fast-png for anything the native path doesn't handle (palette, 16-bit…). */
function decodeSlow(bytes: Uint8Array): DemPixels {
  const png = decode(bytes);
  const channels = png.channels;
  const px = png.width * png.height;
  const data = new Float32Array(px);
  const src = png.data;
  for (let i = 0; i < px; i++) {
    const o = i * channels;
    const h = src[o]! * 256 + src[o + 1]! + src[o + 2]! / 256 - 32768;
    data[i] = h < SEA_FLOOR_M ? SEA_FLOOR_M : h;
  }
  return { width: png.width, height: png.height, data };
}

async function loadDem(z: number, x: number, y: number): Promise<DemPixels> {
  const url = DEM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const res = await fetch(url, {
    signal: AbortSignal.timeout(DEM_TIMEOUT_MS),
    cf: { cacheTtl: 2_592_000, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`DEM ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  try {
    return await decodeTerrariumPng(bytes, inflate, SEA_FLOOR_M);
  } catch (e) {
    if (e instanceof UnsupportedPng) return decodeSlow(bytes);
    throw e;
  }
}

/** Decoded DEM tiles, shared across this isolate's requests (in-flight ones too). */
const dems = new Lru<string, Promise<DemPixels>>(DEM_CACHE_TILES);

export function demTile(z: number, x: number, y: number): Promise<DemPixels> {
  const key = `${z}/${x}/${y}`;
  let p = dems.get(key);
  if (p === undefined) {
    p = loadDem(z, x, y);
    dems.set(key, p);
    // A failed fetch must not stick: the next request tries again.
    p.catch(() => dems.delete(key));
  }
  return p;
}

/** Steepest-tile relief per pixel of each density region's DEM tile, per isolate. */
const regions = new Lru<string, number>(256);

/** Forget this isolate's decoded DEM tiles and region reliefs (benchmarks). */
export function resetContourCaches(): void {
  dems.clear();
  regions.clear();
}

/** The interval for a tile: its zoom's, coarsened if its region is steep. */
async function levelsFor(
  z: number,
  x: number,
  y: number,
  gridZoom: number,
): Promise<ContourLevels> {
  const rz = Math.max(0, gridZoom - DENSITY_REGION_ZOOMS);
  const shift = z - rz;
  const [rx, ry] = [Math.floor(x / 2 ** shift), Math.floor(y / 2 ** shift)];
  const key = `${rz}/${rx}/${ry}`;
  let relief = regions.get(key);
  if (relief === undefined) {
    const dem = await demTile(rz, rx, ry);
    relief = steepestBlockRelief(dem.data, dem.width, dem.height, 2 ** shift);
    regions.set(key, relief);
  }
  return adaptiveLevels(z, cellReliefAt(relief, rz, gridZoom));
}

/** One neighbour's height tile: its quadrant of the DEM tile at `demZ`. */
async function heightTile(z: number, x: number, y: number, demZ: number): Promise<HeightTile> {
  const div = 2 ** (z - demZ);
  const dem = await demTile(demZ, Math.floor(x / div), Math.floor(y / div));
  return HeightTile.fromRawDem(dem).split(z - demZ, x % div, y % div);
}

export interface ContourTileResult {
  mvt: Uint8Array;
  levels: ContourLevels;
}

export async function contourTile(z: number, x: number, y: number): Promise<ContourTileResult> {
  const demZ = Math.max(0, Math.min(z - OVERZOOM, DEM_MAX_ZOOM));
  const max = 2 ** z;
  const neighbours: Promise<HeightTile | undefined>[] = [];
  for (let iy = y - 1; iy <= y + 1; iy++) {
    for (let ix = x - 1; ix <= x + 1; ix++) {
      neighbours.push(
        iy < 0 || iy >= max
          ? Promise.resolve(undefined)
          : heightTile(z, (ix + max) % max, iy, demZ),
      );
    }
  }
  const [tiles, levels] = await Promise.all([Promise.all(neighbours), levelsFor(z, x, y, demZ)]);
  let tile = HeightTile.combineNeighbors(tiles);
  if (!tile) return { mvt: encodeContourMvt([]), levels };
  // As maplibre-contour's fetchContourTile does.
  if (tile.width >= SUBSAMPLE_BELOW) {
    tile = tile.materialize(2);
  } else {
    while (tile.width < SUBSAMPLE_BELOW) tile = tile.subsamplePixelCenters(2).materialize(2);
  }
  tile = tile.averagePixelCentersToGrid().materialize(1);
  const isolines = generateIsolines(levels[0], tile, CONTOUR_EXTENT, BUFFER);
  // Height change per grid cell where a line runs, for its steepness class.
  const grid = tile;
  const cell = CONTOUR_EXTENT / (grid.width - 1);
  const last = grid.width - 2;
  const gradientAt = (x: number, y: number): number => {
    const gx = Math.min(last, Math.max(0, Math.floor(x / cell)));
    const gy = Math.min(last, Math.max(0, Math.floor(y / cell)));
    const h = grid.get(gx, gy);
    return Math.abs(grid.get(gx + 1, gy) - h) + Math.abs(grid.get(gx, gy + 1) - h);
  };
  const features = cleanIsolines(isolines, {
    levels,
    tolerance: simplifyTolerance(z, OVERZOOMED_FROM),
    tinySpan: tinyRingSpan(tile.width - 1),
    baseMinor: contourLevels(z)[0],
    gradientAt,
  });
  return { mvt: encodeContourMvt(features), levels };
}
