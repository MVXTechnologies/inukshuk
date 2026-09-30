import type { BoundingBox } from '@core/models';

/**
 * Which raster tiles a printed sheet needs, and what to do when some of them
 * don't arrive (#460). Pure: no fetching here — `features/map/dem` downloads
 * what {@link planTiles} lists, through {@link fetchAllTiles}.
 *
 * Before #460 the composer planned its basemap with the 3D drape's
 * `clampTileRange(range, 4096 / 256)` and fetched every tile with one
 * `Promise.all`. Two things were wrong with that:
 *
 * - A 4096-px-wide raster can straddle SEVENTEEN tiles, not sixteen, so the
 *   16-tile crop dropped a row or column at common scales (A4 1:25 000 over
 *   Mont-Sainte-Anne lost 61 px off the top) and the cropped image was then
 *   stretched over the whole frame — misregistered against the georeference.
 * - The sheet is up to ~290 downloads, and ONE of them failing (a phone
 *   timeout, a 5xx, a cache miss in offline-only mode) rejected the lot, so
 *   the make died with "Unable to download a file" and nothing to show for it.
 *   There was no retry and no concurrency limit.
 */

/** WebMercator's latitude limit; tiles do not exist past it. */
export const MERCATOR_MAX_LAT = 85.0511287798066;

/** Pixel edge of every raster tile the composer stitches. */
export const TILE_PX = 256;

/**
 * Tiles per side the print raster may span: a window of `longEdgePx` pixels
 * placed anywhere on the tile grid touches at most `ceil(longEdgePx/256) + 1`
 * tiles. One fewer and the edge row/column is cropped away.
 */
export function maxTilesPerSideFor(longEdgePx: number): number {
  return Math.ceil(longEdgePx / TILE_PX) + 1;
}

/** A tile service the composer can stitch. */
export interface TileSourceSpec {
  /** `{z}`, `{x}` and `{y}` placeholders, in whatever order the service wants. */
  template: string;
  minZoom: number;
  /** Deepest zoom with real tiles; deeper requests are clamped to it. */
  maxZoom: number;
}

/** Tile range in UNWRAPPED x (may run past the antimeridian) and clamped y. */
export interface PlannedRange {
  z: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface PlannedTile {
  z: number;
  /** Column to REQUEST, wrapped into [0, 2^z). */
  x: number;
  y: number;
  /** Position in the stitched raster, in tiles from the range's top-left. */
  col: number;
  row: number;
}

export interface TilePlan {
  range: PlannedRange;
  tiles: PlannedTile[];
}

/** Integer zoom inside the source's range; a non-finite zoom falls to its minimum. */
export function clampZoomToSource(
  zoom: number,
  source: Pick<TileSourceSpec, 'minZoom' | 'maxZoom'>,
) {
  if (!Number.isFinite(zoom)) return source.minZoom;
  return Math.max(source.minZoom, Math.min(source.maxZoom, Math.floor(zoom)));
}

/** Wrap a tile column into the world at zoom `z`. */
export function wrapTileX(x: number, z: number): number {
  const n = 2 ** z;
  return ((x % n) + n) % n;
}

const clampLat = (lat: number) => Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));

/** Fractional world tile coordinates, latitude clamped to the Mercator limit. */
function worldTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

/**
 * Whether a sheet's frame can be printed from Mercator tiles at all: finite,
 * non-empty, and inside the ±85.05° band. A frame zoomed out past the world
 * (the camera has gone to min zoom 0 since #442) is not.
 */
export function frameIsPrintable(bbox: BoundingBox): boolean {
  const vals = [bbox.minLng, bbox.maxLng, bbox.minLat, bbox.maxLat];
  if (!vals.every(Number.isFinite)) return false;
  if (bbox.maxLng <= bbox.minLng || bbox.maxLat <= bbox.minLat) return false;
  if (bbox.maxLng - bbox.minLng > 360) return false;
  return bbox.minLat >= -MERCATOR_MAX_LAT && bbox.maxLat <= MERCATOR_MAX_LAT;
}

/**
 * Every tile covering `bbox` at `zoom` (clamped to the source), capped at
 * `maxTilesPerSide` around the centre. Columns past the antimeridian are kept
 * UNWRAPPED in `range` — so pixel math relative to `range.minX` stays
 * continuous across ±180° — and wrapped only in the tile to request; rows
 * are clamped to the world.
 */
export function planTiles(
  bbox: BoundingBox,
  zoom: number,
  source: Pick<TileSourceSpec, 'minZoom' | 'maxZoom'>,
  maxTilesPerSide: number,
): TilePlan {
  if (![bbox.minLng, bbox.maxLng, bbox.minLat, bbox.maxLat].every(Number.isFinite)) {
    throw new RangeError('planTiles: bbox is not finite');
  }
  const z = clampZoomToSource(zoom, source);
  const n = 2 ** z;
  const cap = Math.max(1, Math.floor(maxTilesPerSide));
  const nw = worldTile(bbox.minLng, bbox.maxLat, z);
  const se = worldTile(bbox.maxLng, bbox.minLat, z);

  let minX = Math.floor(nw.x);
  // A right edge landing exactly on a tile boundary does not need the next tile.
  let maxX = Math.max(minX, Math.ceil(se.x) - 1);
  // More than the whole world once over is the same columns twice.
  if (maxX - minX + 1 > n) maxX = minX + n - 1;
  let minY = Math.max(0, Math.min(n - 1, Math.floor(nw.y)));
  let maxY = Math.max(minY, Math.min(n - 1, Math.ceil(se.y) - 1));

  const crop = (lo: number, hi: number): [number, number] => {
    if (hi - lo + 1 <= cap) return [lo, hi];
    const start = Math.floor((lo + hi) / 2) - Math.floor((cap - 1) / 2);
    return [start, start + cap - 1];
  };
  [minX, maxX] = crop(minX, maxX);
  [minY, maxY] = crop(minY, maxY);

  const tiles: PlannedTile[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      tiles.push({ z, x: wrapTileX(x, z), y, col: x - minX, row: y - minY });
    }
  }
  return { range: { z, minX, maxX, minY, maxY }, tiles };
}

/** Every tile of an already-chosen range (the 3D drape and DEM paths). */
export function tilesInRange(range: PlannedRange): PlannedTile[] {
  const tiles: PlannedTile[] = [];
  for (let y = range.minY; y <= range.maxY; y++) {
    for (let x = range.minX; x <= range.maxX; x++) {
      tiles.push({
        z: range.z,
        x: wrapTileX(x, range.z),
        y,
        col: x - range.minX,
        row: y - range.minY,
      });
    }
  }
  return tiles;
}

/**
 * Fill a `{z}/{x}/{y}` template (any order — Esri is `{z}/{y}/{x}`). Throws on
 * a template missing a placeholder: it would request the same tile for every
 * cell and print one square of map, tiled.
 */
export function tileUrl(template: string, t: { z: number; x: number; y: number }): string {
  for (const key of ['{z}', '{x}', '{y}']) {
    if (!template.includes(key)) throw new Error(`tile template has no ${key}: ${template}`);
  }
  return template
    .replace(/\{z\}/g, String(t.z))
    .replace(/\{x\}/g, String(t.x))
    .replace(/\{y\}/g, String(t.y));
}

// --- fetching -------------------------------------------------------------

export interface TileFailure<T> {
  tile: T;
  error: unknown;
  attempts: number;
}

export interface FetchAllOptions {
  /** Downloads in flight at once. */
  concurrency?: number;
  /** Extra attempts after the first, for a retryable error. */
  retries?: number;
  /** Delay before retry `attempt` (1-based). */
  retryDelayMs?: (attempt: number) => number;
  /** Injected so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Stop scheduling new tiles (the caller throws its own 'aborted'). */
  isAborted?: () => boolean;
  /** Called after every tile settles, success or failure. */
  onSettled?: (done: number, total: number) => void;
}

/** An error no retry can fix: offline-only mode refusing a cache miss. */
export function isOfflineOnlyError(error: unknown): boolean {
  return error instanceof Error && error.name === 'OfflineOnlyError';
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fetchOne` over every tile with bounded concurrency and per-tile
 * retries, and report — rather than throw — the tiles that never arrived.
 * One bad tile out of two hundred must not take the other 199 down with it.
 */
export async function fetchAllTiles<T>(
  tiles: readonly T[],
  fetchOne: (tile: T) => Promise<void>,
  {
    concurrency = 6,
    retries = 2,
    retryDelayMs = (attempt) => 400 * attempt,
    sleep = defaultSleep,
    isAborted = () => false,
    onSettled,
  }: FetchAllOptions = {},
): Promise<TileFailure<T>[]> {
  const failures: TileFailure<T>[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tiles.length && !isAborted()) {
      const tile = tiles[next++];
      if (tile === undefined) break;
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          await fetchOne(tile);
          break;
        } catch (error) {
          if (attempts > retries || isOfflineOnlyError(error) || isAborted()) {
            failures.push({ tile, error, attempts });
            break;
          }
          await sleep(retryDelayMs(attempts));
        }
      }
      done++;
      onSettled?.(done, tiles.length);
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(concurrency), tiles.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return failures;
}

/** What the tiles were for, in the user's words. */
export type TileLayerLabel = 'map' | 'elevation';

/** Raised when too many of a sheet's tiles are missing to print it honestly. */
export class TileFetchError extends Error {
  constructor(
    message: string,
    readonly failed: number,
    readonly total: number,
    readonly offlineOnly: boolean,
  ) {
    super(message);
    this.name = 'TileFetchError';
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Decide whether a stitched layer with `failures` out of `total` tiles can
 * print. Up to `maxMissingFraction` of holes is tolerated (they print as
 * blank paper and the caller tells the user how many); more than that throws
 * a {@link TileFetchError} that says what went wrong in words a user can act
 * on — including the offline-only case, which is a setting, not a network
 * fault. Returns the number of missing tiles.
 */
export function assessTileFailures(
  layer: TileLayerLabel,
  total: number,
  failures: readonly TileFailure<unknown>[],
  maxMissingFraction: number,
): number {
  const failed = failures.length;
  if (failed === 0) return 0;
  if (total > 0 && failed / total <= maxMissingFraction) return failed;
  const noun = layer === 'map' ? 'map tiles' : 'elevation tiles';
  const offline = failures.some((f) => isOfflineOnlyError(f.error));
  if (offline) {
    throw new TileFetchError(
      `offline-only mode is on and ${failed} of ${total} ${noun} for this sheet aren't downloaded. ` +
        'Turn off "Locally downloaded only" in Settings to make it.',
      failed,
      total,
      true,
    );
  }
  const first = failures[0];
  throw new TileFetchError(
    `couldn't download ${failed} of ${total} ${noun}` +
      (first ? ` (${errorText(first.error)})` : '') +
      '. Check your connection and try again.',
    failed,
    total,
    false,
  );
}
