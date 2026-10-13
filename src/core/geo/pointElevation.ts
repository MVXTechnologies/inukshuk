/**
 * Ground elevation at one point (the map centre, #677) from the Terrarium DEM
 * tiles the app already uses for climb, route elevation and 3D.
 *
 * One tile per point at {@link POINT_ELEVATION_ZOOM} (z12: ~38 m pixels at
 * the equator, ~26 m at 46°N, so "a ~30 m DEM"), sampled bilinearly by
 * `@core/trails/climb`'s `elevationAt`. Decoded tiles sit in a small LRU,
 * so a pan that settles inside a tile already read costs a cache lookup and
 * a four-pixel blend: no network, no PNG decode. Concurrent reads of one
 * tile share one load, and a tile that failed (offline with nothing cached,
 * a server error) is not retried for {@link FAILURE_TTL_MS}, so an offline
 * session does not hammer the disk cache on every camera idle.
 *
 * The fetch + decode itself is injected (`features/map/dem.ts`'s
 * `fetchDemTile`, which reads the on-disk tile cache first and honours
 * "Locally downloaded only"), which keeps this module pure.
 */
import { elevationAt, tileKeyId, type DemTile, type TileKey } from '@core/trails/climb';

import { lngLatToTile } from './terrain';

/** The DEM zoom the point readout samples: the climb module's finest. */
export const POINT_ELEVATION_ZOOM = 12;
/** Decoded tiles kept (each 256 × 256 float32 = 256 KB). */
export const POINT_ELEVATION_MAX_TILES = 8;
/** How long a failed tile is left alone before it may be tried again. */
export const FAILURE_TTL_MS = 60_000;
/** Web Mercator's latitude limit: no tile exists beyond it. */
const MAX_LAT = 85.0511;

/** A small least-recently-used map: `get` refreshes, inserting past `max` drops the oldest. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get size(): number {
    return this.map.size;
  }

  /** The value, marked most recently used; undefined on a miss. */
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }
}

/** The DEM tile a point falls in, and the pixel inside it (0–255, row 0 = north). */
export function demTileForPoint(
  latitude: number,
  longitude: number,
  z: number = POINT_ELEVATION_ZOOM,
  size = 256,
): { key: TileKey; px: number; py: number } | null {
  if (!(Math.abs(latitude) <= MAX_LAT) || !Number.isFinite(longitude)) return null;
  const n = 2 ** z;
  // Wrap the longitude onto the tile grid (the camera can report -190°).
  const lon = ((((longitude + 180) % 360) + 360) % 360) - 180;
  const { x, y } = lngLatToTile(lon, latitude, z);
  const tx = Math.min(n - 1, Math.floor(x));
  const ty = Math.min(n - 1, Math.max(0, Math.floor(y)));
  return {
    key: { z, x: tx, y: ty },
    px: Math.min(size - 1, Math.floor((x - tx) * size)),
    py: Math.min(size - 1, Math.floor((y - ty) * size)),
  };
}

export interface PointElevationReader {
  /**
   * Synchronous: the elevation (m) when the point's tile is decoded in the
   * cache, `null` when it is known to be unavailable (failed recently, or
   * outside the DEM), `undefined` when it has not been read yet.
   */
  peek(latitude: number, longitude: number): number | null | undefined;
  /** Read the point's tile if needed, then the elevation; null when unavailable. */
  load(latitude: number, longitude: number): Promise<number | null>;
  /** Tile loads started (each one fetch + one decode). */
  readonly loads: number;
}

export function createPointElevationReader(
  loadTile: (key: TileKey) => Promise<DemTile>,
  options: { z?: number; maxTiles?: number; failureTtlMs?: number; now?: () => number } = {},
): PointElevationReader {
  const z = options.z ?? POINT_ELEVATION_ZOOM;
  const ttl = options.failureTtlMs ?? FAILURE_TTL_MS;
  const now = options.now ?? Date.now;
  const tiles = new LruCache<string, DemTile>(options.maxTiles ?? POINT_ELEVATION_MAX_TILES);
  const failedAt = new Map<string, number>();
  const inflight = new Map<string, Promise<DemTile | null>>();
  let loads = 0;

  const sample = (lat: number, lon: number, id: string, tile: DemTile): number | null => {
    const v = elevationAt([lon, lat], z, new Map([[id, tile]]));
    return v !== undefined && Number.isFinite(v) ? v : null;
  };

  const recentlyFailed = (id: string): boolean => {
    const at = failedAt.get(id);
    if (at === undefined) return false;
    if (now() - at < ttl) return true;
    failedAt.delete(id);
    return false;
  };

  const peek = (lat: number, lon: number): number | null | undefined => {
    const where = demTileForPoint(lat, lon, z);
    if (where === null) return null;
    const id = tileKeyId(where.key);
    const tile = tiles.get(id);
    if (tile !== undefined) return sample(lat, lon, id, tile);
    return recentlyFailed(id) ? null : undefined;
  };

  const tileFor = (key: TileKey): Promise<DemTile | null> => {
    const id = tileKeyId(key);
    const pending = inflight.get(id);
    if (pending !== undefined) return pending;
    loads += 1;
    const p = loadTile(key)
      .then((tile) => {
        tiles.set(id, tile);
        failedAt.delete(id);
        return tile;
      })
      .catch(() => {
        failedAt.set(id, now());
        return null;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  };

  return {
    peek,
    async load(lat, lon) {
      const known = peek(lat, lon);
      if (known !== undefined) return known;
      const where = demTileForPoint(lat, lon, z);
      if (where === null) return null;
      const tile = await tileFor(where.key);
      return tile === null ? null : sample(lat, lon, tileKeyId(where.key), tile);
    },
    get loads() {
      return loads;
    },
  };
}
