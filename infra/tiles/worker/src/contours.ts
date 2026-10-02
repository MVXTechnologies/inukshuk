/**
 * Contour-line vector tiles, generated on demand from the same Terrarium DEM
 * the app already uses:
 *
 *   GET /contours/{z}/{x}/{y}.mvt   layer "contours", properties ele (m), level (0 minor, 1 major)
 *
 * Because they are ordinary vector tiles, MapLibre loads them around the
 * viewport with the base map (no computed "window" that pans into blank), and
 * offline packs store them. Everything but the fetch and the inflate is pure
 * (./contourMath.ts, ./contourGrid.ts) and kept inside the free plan's 10 ms
 * of CPU (#509, then the 1102s of 2026-10 in northern Québec):
 *
 * - DEM PNGs are inflated by the runtime's native DecompressionStream, not
 *   fast-png's pure-JS inflate;
 * - decoded DEM tiles are kept per isolate and shared by concurrent requests,
 *   so a viewport's burst decodes each DEM tile once;
 * - a request decodes at most `decodeBudget` DEM tiles itself (a tile needs up
 *   to five). Past that it answers a PARTIAL tile — the lines drawn without
 *   the neighbours' two-pixel border — which index.ts neither stores nor lets
 *   anyone cache for long, so a later request, finding the DEM tiles decoded,
 *   makes the full one;
 * - steep regions get a coarser interval (adaptiveLevels) — each line then
 *   carries `k` (lines of the zoom's own interval it stands for) and `s` (a
 *   steepness class), so the style can keep steep walls dark — lines are
 *   simplified, tiny rings and below-sea-level lines dropped.
 *
 * index.ts stores every full tile in R2, so each is computed once ever.
 */
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
  meanPixelRelief,
  OVERZOOMED_FROM,
  simplifyTolerance,
  steepestBlockRelief,
  tinyRingSpan,
  UnsupportedPng,
  type ContourLevels,
  type DemPixels,
} from './contourMath';
import {
  copyDemIntoWindow,
  cornerGrid,
  DEFAULT_DECODE_BUDGET,
  demPartsFor,
  gridGradient,
  LoadCache,
  newPixelWindow,
  planDemLoads,
  traceIsolines,
  WINDOW_MARGIN,
} from './contourGrid';

export { CONTOUR_MAX_ZOOM, contourLevels } from './contourMath';

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/** Terrarium's deepest zoom, and its tiles' width in pixels. */
const DEM_MAX_ZOOM = 15;
const DEM_SIZE = 256;
/** A contour tile at z is cut from the DEM at z − 1 (a 128-px quadrant + its border). */
const OVERZOOM = 1;
/** Heights below this are clamped: no bathymetry contours (the style hides ≤ 0 m anyway). */
const SEA_FLOOR_M = -1;
/** Decoded DEM tiles kept per isolate (256 KB each). */
const DEM_CACHE_TILES = 48;
const DEM_TIMEOUT_MS = 15_000;
/** A load still pending after this belongs to a dead request (see LoadCache). */
const DEM_STALE_MS = DEM_TIMEOUT_MS + 5_000;
/** How long a request waits for a DEM tile another request is decoding. */
const DEM_JOIN_MS = 4_000;

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
  let dem: DemPixels;
  try {
    dem = await decodeTerrariumPng(bytes, inflate, SEA_FLOOR_M);
  } catch (e) {
    if (!(e instanceof UnsupportedPng)) throw e;
    dem = decodeSlow(bytes);
  }
  if (dem.width !== DEM_SIZE || dem.height !== DEM_SIZE) {
    throw new Error(`DEM ${dem.width}x${dem.height}`);
  }
  return dem;
}

/** Decoded DEM tiles, shared across this isolate's requests (in-flight ones too). */
const dems = new LoadCache<DemPixels>(DEM_CACHE_TILES, DEM_STALE_MS);

/** Steepest-tile relief per pixel of each density region's DEM tile, per isolate. */
const regions = new Lru<string, number>(256);

/** Forget this isolate's decoded DEM tiles and region reliefs (benchmarks). */
export function resetContourCaches(): void {
  dems.clear();
  regions.clear();
}

/** Another request's pending load, given up on after {@link DEM_JOIN_MS}. */
function join(pending: Promise<DemPixels>): Promise<DemPixels | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), DEM_JOIN_MS);
    const settle = (dem: DemPixels | undefined) => {
      clearTimeout(timer);
      resolve(dem);
    };
    pending.then(settle, () => settle(undefined));
  });
}

export interface ContourTileOptions {
  /** DEM tiles this request may decode itself (see DEFAULT_DECODE_BUDGET). */
  decodeBudget?: number;
}

export interface ContourTileResult {
  mvt: Uint8Array;
  levels: ContourLevels;
  /**
   * Drawn without all of its DEM (the decode budget ran out, or a neighbour's
   * fetch failed): the lines can be half a DEM pixel off along the edges
   * whose neighbour is missing, and the interval is the tile's own guess when
   * the region's DEM is. Not to be stored — a later request makes the full tile.
   */
  partial: boolean;
}

export async function contourTile(
  z: number,
  x: number,
  y: number,
  { decodeBudget = DEFAULT_DECODE_BUDGET }: ContourTileOptions = {},
): Promise<ContourTileResult> {
  const demZ = Math.max(0, Math.min(z - OVERZOOM, DEM_MAX_ZOOM));
  const { size, parts } = demPartsFor(z, x, y, demZ, DEM_SIZE);
  const own = parts.find((p) => p.own);
  if (own === undefined) throw new Error('no DEM tile under the contour tile');

  // The region whose steepest tile sets the interval: one DEM tile above.
  const rz = Math.max(0, demZ - DENSITY_REGION_ZOOMS);
  const shift = z - rz;
  const region = { z: rz, x: Math.floor(x / 2 ** shift), y: Math.floor(y / 2 ** shift) };
  const regionKey = `${region.z}/${region.x}/${region.y}`;
  let relief = regions.get(regionKey);

  // What to load, in the order it matters: the tile's own DEM, the region's
  // (the right interval matters more than a border), then the neighbours.
  const needed = parts.map(({ key, z: dz, x: dx, y: dy }) => ({ key, z: dz, x: dx, y: dy }));
  if (relief === undefined && !needed.some((n) => n.key === regionKey)) {
    needed.splice(1, 0, { key: regionKey, ...region });
  }
  const starts = planDemLoads(
    needed.map((n) => dems.state(n.key)),
    decodeBudget,
  );
  const loads = needed.map((n, i): Promise<DemPixels | undefined> => {
    const ready = dems.value(n.key);
    if (ready !== undefined) return Promise.resolve(ready);
    const pending = dems.pending(n.key);
    if (pending !== undefined) return join(pending);
    if (!starts[i]) return Promise.resolve(undefined);
    return dems.start(n.key, () => loadDem(n.z, n.x, n.y)).catch(() => undefined);
  });
  const loaded = new Map<string, DemPixels | undefined>();
  (await Promise.all(loads)).forEach((dem, i) => {
    const n = needed[i];
    if (n !== undefined) loaded.set(n.key, dem);
  });

  // The tile's own DEM is the one it cannot do without: if another request's
  // load of it died, or ours failed, try once more — and fail the tile if
  // that fails too.
  if (loaded.get(own.key) === undefined) {
    loaded.set(own.key, await dems.start(own.key, () => loadDem(own.z, own.x, own.y)));
  }

  let partial = false;
  const win = newPixelWindow(size);
  for (const part of parts) {
    const dem = loaded.get(part.key);
    if (dem === undefined) {
      partial = true;
      continue;
    }
    for (const [offX, offY] of part.offsets) copyDemIntoWindow(win, dem, offX, offY);
  }

  if (relief === undefined) {
    const dem = loaded.get(regionKey);
    if (dem !== undefined) {
      relief = steepestBlockRelief(dem.data, dem.width, dem.height, 2 ** shift);
      regions.set(regionKey, relief);
    }
  }
  let levels: ContourLevels;
  if (relief !== undefined) {
    levels = adaptiveLevels(z, cellReliefAt(relief, rz, demZ));
  } else {
    // No region yet: the tile's own relief, so it is never denser than it can afford.
    partial = true;
    levels = adaptiveLevels(
      z,
      meanPixelRelief(win.data, win.stride, win.stride, WINDOW_MARGIN, WINDOW_MARGIN, size, size),
    );
  }

  const grid = cornerGrid(win);
  const isolines = traceIsolines(grid, levels[0], CONTOUR_EXTENT, 0);
  const features = cleanIsolines(isolines, {
    levels,
    tolerance: simplifyTolerance(z, OVERZOOMED_FROM),
    tinySpan: tinyRingSpan(grid.width - 1),
    baseMinor: contourLevels(z)[0],
    // Height change per grid cell where a line runs, for its steepness class.
    gradientAt: gridGradient(grid, CONTOUR_EXTENT),
  });
  return { mvt: encodeContourMvt(features), levels, partial };
}
