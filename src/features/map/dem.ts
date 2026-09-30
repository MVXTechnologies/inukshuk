import {
  clampTileRange,
  pickTerrainZoom,
  rangeBbox,
  sampleGridBilinear,
  TERRARIUM_TILE_SOURCE,
  terrariumToMeters,
  tileRangeForBbox,
  type TileRange,
} from '@core/geo/terrain';
import type { Basemap } from '@core/geo/tiles';
import { printTileSource } from '@core/mapmaker/printSources';
import {
  assessTileFailures,
  fetchAllTiles,
  tilesInRange,
  tileUrl,
  type FetchAllOptions,
  type PlannedRange,
  type PlannedTile,
  type TileFailure,
  type TilePlan,
} from '@core/mapmaker/tilePlan';
import type { BoundingBox } from '@core/models';
import * as storage from '@data/storage';
import jpeg from 'jpeg-js';
import UPNG from 'upng-js';

const TILE = 256;
const UA = { 'User-Agent': 'Inukshuk/1.0 (offline trail navigation app)' };

const demUrl = (z: number, x: number, y: number) =>
  tileUrl(TERRARIUM_TILE_SOURCE.template, { z, x, y });

/**
 * Free, key-free basemaps drapeable on the 3D terrain — every app {@link Basemap}
 * except 'relief', which has no drape (the mesh's hypsometric tint is the relief
 * look). Both come from Esri's public ArcGIS Online tile services (note the
 * `{z}/{y}/{x}` row/col order); the templates live in `printSources`, shared
 * with the map maker's live preview.
 *
 * We deliberately do NOT use raw `tile.openstreetmap.org` here: the OSM tile
 * policy forbids app/bulk fetching and returns "Access Blocked 403" tiles when a
 * 3D drape stitches many tiles at once. Esri World Street Map is permissive and
 * matches the satellite/relief sources.
 */
export type DrapeSource = Exclude<Basemap, 'relief'>;

/** Decode a tile (PNG or JPEG, by magic bytes) to RGBA. */
function decodeTileRGBA(bytes: Uint8Array): Uint8Array {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpeg.decode(bytes, { useTArray: true }).data;
  }
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Uint8Array(UPNG.toRGBA8(UPNG.decode(buf))[0]!);
}

export interface Heightmap {
  /** Elevation in metres, row-major, `grid * grid`. Row 0 = north edge. */
  data: Float32Array;
  grid: number;
  /** Tile-aligned lng/lat bounds actually covered by the heightmap. */
  bbox: BoundingBox;
  /** Tile range covered (so a basemap drape can fetch the same tiles). */
  range: TileRange;
  minH: number;
  maxH: number;
}

/** The full-resolution Terrarium elevation mosaic of a tile range. */
export interface DemMosaic {
  /** Elevation in metres, row-major, `width * height`. Row 0 = north edge. */
  data: Float32Array;
  width: number;
  height: number;
  /** Tile range covered; `range.z` is the DEM zoom (256-px tiles). */
  range: TileRange;
  /** Tile-aligned lng/lat bounds of the mosaic. */
  bbox: BoundingBox;
}

/**
 * Fetch the free Terrarium DEM tiles covering `bounds` and decode them into
 * one full-resolution elevation mosaic. Network-bound (tiles are cached).
 */
export async function fetchDemMosaic(bounds: BoundingBox, maxTilesPerSide = 6): Promise<DemMosaic> {
  // Allow more DEM tiles per side → a higher zoom level → finer elevation detail
  // (and a sharper basemap drape, which reuses the same tile range/zoom).
  const z = pickTerrainZoom(bounds, maxTilesPerSide);
  // pickTerrainZoom bottoms out at its zMin for very large boxes (a long
  // imported tour), where the range can still span dozens of tiles per side —
  // hundreds of downloads and an OOM-sized heightmap. Enforce the same budget
  // on the range we actually fetch, cropped around the box centre.
  const range = clampTileRange(tileRangeForBbox(bounds, z), maxTilesPerSide);
  const fullW = (range.maxX - range.minX + 1) * TILE;
  const fullH = (range.maxY - range.minY + 1) * TILE;
  const full = new Float32Array(fullW * fullH);

  // Bounded, retried downloads (#460). A heightmap with a hole would draw a
  // cliff down to -32 768 m, so unlike a base raster ANY missing tile throws —
  // with a message that says so, instead of the bare download error.
  const tiles = tilesInRange(range);
  const failures = await fetchAllTiles(tiles, async (t) => {
    const rgba = decodeTileRGBA(
      await storage.downloadBytes(demUrl(t.z, t.x, t.y), `dem-${t.z}-${t.x}-${t.y}.png`),
    );
    const ox = t.col * TILE;
    const oy = t.row * TILE;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = (y * TILE + x) * 4;
        full[(oy + y) * fullW + (ox + x)] = terrariumToMeters(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
      }
    }
  });
  assessTileFailures('elevation', tiles.length, failures, 0);
  return { data: full, width: fullW, height: fullH, range, bbox: rangeBbox(range) };
}

/** Downsample a DEM mosaic to a `grid × grid` heightmap (for a mesh or contours). */
export function heightmapFromMosaic(mosaic: DemMosaic, grid: number): Heightmap {
  const { data: full, width: fullW, height: fullH } = mosaic;
  const data = new Float32Array(grid * grid);
  let minH = Infinity;
  let maxH = -Infinity;
  // Bilinearly resample the full-resolution DEM down to the mesh grid. Nearest
  // sampling here (Math.round) aliased and terraced the relief, throwing away real
  // shape the tiles carried; bilinear recovers smooth slopes for the same cost.
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const h = sampleGridBilinear(full, fullW, fullH, gx / (grid - 1), gy / (grid - 1));
      data[gy * grid + gx] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  return { data, grid, bbox: mosaic.bbox, range: mosaic.range, minH, maxH };
}

/**
 * Fetch the free Terrarium DEM tiles covering `bounds`, decode their elevation,
 * and downsample to a `grid × grid` heightmap for a 3D mesh. Network-bound.
 */
export async function fetchHeightmap(
  bounds: BoundingBox,
  grid = 256,
  maxTilesPerSide = 6,
): Promise<Heightmap> {
  return heightmapFromMosaic(await fetchDemMosaic(bounds, maxTilesPerSide), grid);
}

/**
 * One Terrarium DEM tile decoded to metres (256 × 256, row 0 = north), from
 * the same on-disk tile cache as the 3D view. The long-distance trail page
 * samples its climb from these (#467).
 */
export async function fetchDemTile(z: number, x: number, y: number): Promise<Float32Array> {
  const rgba = decodeTileRGBA(
    await storage.downloadBytes(demUrl(z, x, y), `dem-${z}-${x}-${y}.png`),
  );
  const out = new Float32Array(TILE * TILE);
  for (let i = 0; i < TILE * TILE; i++) {
    out[i] = terrariumToMeters(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
  }
  return out;
}

/**
 * Warm the DEM tile cache for `bounds` at zoom `z` (no decoding): the tiles a
 * pan is about to need are then on disk before the next compute asks for them.
 * Capped at `maxTilesPerSide` around the centre; failures are ignored (it is
 * only a head start — the real fetch retries).
 */
export async function prefetchDemTiles(
  bounds: BoundingBox,
  z: number,
  maxTilesPerSide = 12,
): Promise<void> {
  const range = clampTileRange(tileRangeForBbox(bounds, z), maxTilesPerSide);
  const jobs: Promise<unknown>[] = [];
  for (let ty = range.minY; ty <= range.maxY; ty++) {
    for (let tx = range.minX; tx <= range.maxX; tx++) {
      jobs.push(
        storage.downloadBytes(demUrl(z, tx, ty), `dem-${z}-${tx}-${ty}.png`).catch(() => undefined),
      );
    }
  }
  await Promise.all(jobs);
}

export interface BasemapTexture {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * The warm paper tone the live map paints behind its tiles; a print tile that
 * never arrived shows as this rather than as black (#460).
 */
const PAPER_RGB = [0xe6, 0xdf, 0xcf] as const;

export interface StitchOptions {
  /** Base layer: alpha forced to 255, holes painted paper. Otherwise alpha is kept. */
  opaque?: boolean;
  /** Cache file name for a tile (kept identical to older builds' names). */
  cacheName: (t: PlannedTile) => string;
  /** Concurrency, retries, progress and abort — see {@link fetchAllTiles}. */
  fetch?: FetchAllOptions;
}

export interface StitchResult {
  texture: BasemapTexture;
  /** Tiles that never arrived, after retries; their cells are holes. */
  failures: TileFailure<PlannedTile>[];
}

/**
 * Download `tiles` of `range` from `template` and stitch them into one RGBA
 * raster, row 0 = north (#460). Bounded concurrency with per-tile retries, and
 * a tile that still fails is REPORTED, not thrown: the caller decides whether a
 * raster with holes is acceptable (see `assessTileFailures`).
 */
export async function stitchTiles(
  range: PlannedRange,
  tiles: readonly PlannedTile[],
  template: string,
  { opaque = false, cacheName, fetch }: StitchOptions,
): Promise<StitchResult> {
  const fullW = (range.maxX - range.minX + 1) * TILE;
  const fullH = (range.maxY - range.minY + 1) * TILE;
  const out = new Uint8Array(fullW * fullH * 4);
  if (opaque) {
    for (let i = 0; i < out.length; i += 4) {
      out[i] = PAPER_RGB[0];
      out[i + 1] = PAPER_RGB[1];
      out[i + 2] = PAPER_RGB[2];
      out[i + 3] = 255;
    }
  }

  const failures = await fetchAllTiles(
    tiles,
    async (t) => {
      const rgba = decodeTileRGBA(
        await storage.downloadBytes(tileUrl(template, t), cacheName(t), UA),
      );
      const ox = t.col * TILE;
      const oy = t.row * TILE;
      if (opaque) {
        for (let y = 0; y < TILE; y++) {
          for (let x = 0; x < TILE; x++) {
            const si = (y * TILE + x) * 4;
            const di = ((oy + y) * fullW + (ox + x)) * 4;
            out[di] = rgba[si]!;
            out[di + 1] = rgba[si + 1]!;
            out[di + 2] = rgba[si + 2]!;
            out[di + 3] = 255;
          }
        }
      } else {
        for (let y = 0; y < TILE; y++) {
          out.set(rgba.subarray(y * TILE * 4, (y * TILE + TILE) * 4), ((oy + y) * fullW + ox) * 4);
        }
      }
    },
    fetch,
  );
  return { texture: { data: out, width: fullW, height: fullH }, failures };
}

const basemapCacheName = (source: DrapeSource) => (t: PlannedTile) =>
  `${source}-${t.z}-${t.x}-${t.y}.${source === 'satellite' ? 'jpg' : 'png'}`;

/**
 * The map maker's base raster (#460): the print source's tiles for a planned
 * sheet, holes and all — the composer judges whether they are few enough.
 */
export function fetchPrintBasemap(
  plan: TilePlan,
  source: DrapeSource,
  fetch?: FetchAllOptions,
): Promise<StitchResult> {
  return stitchTiles(plan.range, plan.tiles, printTileSource(source).template, {
    opaque: true,
    cacheName: basemapCacheName(source),
    fetch,
  });
}

/**
 * Fetch the basemap (Esri street map or satellite) tiles for the same tile
 * range as the heightmap and stitch them into one RGBA texture to drape on the
 * terrain. Row 0 = north, matching the mesh UVs. Each tile is retried; a tile
 * still missing throws, and the 3D caller falls back to its relief tint.
 */
export async function fetchBasemapTexture(
  range: TileRange,
  source: DrapeSource,
): Promise<BasemapTexture> {
  const tiles = tilesInRange(range);
  const { texture, failures } = await stitchTiles(range, tiles, printTileSource(source).template, {
    opaque: true,
    cacheName: basemapCacheName(source),
  });
  assessTileFailures('map', tiles.length, failures, 0);
  return texture;
}
