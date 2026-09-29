/**
 * Build-time terrain pass (Node only): which of `mountains`, `glacier`,
 * `water`, `coast` each catalog item's footprint covers.
 *
 * - **Mountains** — relief from the Terrarium DEM
 *   (`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`,
 *   AWS Open Data, the same tiles the contour Worker renders). Tiles are read
 *   at zoom {@link DEM_ZOOM} and immediately reduced to 8-px block min/max
 *   summaries; **only the 4 KB summaries are cached** (never the PNGs), so a
 *   whole-catalog cache stays in the tens of MB. Thresholds live in
 *   `@core/catalog/terrain` (`MOUNTAIN_THRESHOLDS`).
 * - **Glacier / water / coast** — overlap with Natural Earth 1:10m layers
 *   (public domain), downloaded once as GeoJSON into the cache.
 * - **Forest** — not computed: there is no small, open, global forest-cover
 *   layer that answers "is this sheet forested" honestly at bbox scale.
 *
 * Cache: `scripts/catalog/.cache/` (gitignored). See docs/CATALOG.md §6.
 */
import UPNG from 'upng-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CatalogBbox, CatalogItem } from '../../src/core/catalog/schema';
import type { CatalogTerrain } from '../../src/core/catalog/taxonomy';
import {
  GeometryIndex,
  isMountainous,
  reliefStats,
  summarizeTerrariumTile,
  tilesForBbox,
  type BlockSummary,
  type IndexGeometry,
  type ReliefStats,
} from '../../src/core/catalog/terrain';
import { cachedDownload, mapPool, politeFetch } from './http';

export const DEM_ZOOM = 9;
const BLOCK_PX = 8;
const TILE_PX = 256;
const DEM_CONCURRENCY = 8;
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
/** Natural Earth 1:10m layers per terrain (plus the regional detail layers). */
const NE_LAYERS: Record<'glacier' | 'water' | 'coast', string[]> = {
  glacier: ['ne_10m_glaciated_areas'],
  water: [
    'ne_10m_lakes',
    'ne_10m_lakes_north_america',
    'ne_10m_lakes_australia',
    'ne_10m_rivers_lake_centerlines',
    'ne_10m_rivers_north_america',
    'ne_10m_rivers_australia',
  ],
  coast: ['ne_10m_coastline'],
};

interface GeoJsonFeatureCollection {
  features: { geometry: IndexGeometry | null }[];
}

async function loadLayers(
  cacheDir: string,
): Promise<Record<keyof typeof NE_LAYERS, GeometryIndex>> {
  const out = {} as Record<keyof typeof NE_LAYERS, GeometryIndex>;
  for (const [terrain, layers] of Object.entries(NE_LAYERS) as [
    keyof typeof NE_LAYERS,
    string[],
  ][]) {
    const index = new GeometryIndex();
    for (const layer of layers) {
      const path = await cachedDownload(
        `${NE_BASE}/${layer}.geojson`,
        join(cacheDir, 'naturalearth', `${layer}.geojson`),
      );
      const fc = JSON.parse(readFileSync(path, 'utf8')) as GeoJsonFeatureCollection;
      for (const feature of fc.features) if (feature.geometry) index.add(feature.geometry);
    }
    out[terrain] = index;
  }
  return out;
}

function tilePath(cacheDir: string, x: number, y: number): string {
  return join(cacheDir, 'dem', `z${DEM_ZOOM}`, String(x), `${y}.bin`);
}

/** Summary on disk: Int16 min[side²] then max[side²]; an empty file = no tile (404). */
function readSummary(path: string): BlockSummary | null | undefined {
  if (!existsSync(path)) return undefined;
  const buf = readFileSync(path);
  if (buf.length === 0) return null;
  const all = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const side = Math.round(Math.sqrt(all.length / 2));
  return { side, min: all.slice(0, side * side), max: all.slice(side * side) };
}

async function fetchSummary(cacheDir: string, x: number, y: number): Promise<BlockSummary | null> {
  const path = tilePath(cacheDir, x, y);
  const cached = readSummary(path);
  if (cached !== undefined) return cached;
  const res = await politeFetch(`${TERRARIUM}/${DEM_ZOOM}/${x}/${y}.png`);
  mkdirSync(dirname(path), { recursive: true });
  if (res === null || !res.ok) {
    if (res !== null && (res.status === 404 || res.status === 403))
      writeFileSync(path, new Uint8Array());
    return null;
  }
  const png = UPNG.decode(await res.arrayBuffer());
  const rgba = UPNG.toRGBA8(png)[0];
  if (rgba === undefined) return null;
  const summary = summarizeTerrariumTile(new Uint8Array(rgba), png.width, BLOCK_PX);
  const packed = new Int16Array(summary.min.length * 2);
  packed.set(summary.min, 0);
  packed.set(summary.max, summary.min.length);
  writeFileSync(path, new Uint8Array(packed.buffer));
  return summary;
}

export interface TerrainResult {
  terrain: Map<string, CatalogTerrain[]>;
  relief: Map<string, ReliefStats>;
}

/** Classify every item with a bbox. Items without one get no terrain. */
export async function computeTerrain(
  items: readonly CatalogItem[],
  cacheDir: string,
): Promise<TerrainResult> {
  const started = Date.now();
  const placed = items.filter(
    (i): i is CatalogItem & { bbox: CatalogBbox } => i.bbox !== undefined,
  );

  // DEM: the union of tiles every footprint touches.
  const wanted = new Map<string, { x: number; y: number }>();
  for (const item of placed) {
    for (const t of tilesForBbox(item.bbox, DEM_ZOOM)) wanted.set(`${t.x}/${t.y}`, t);
  }
  const tiles = new Map<string, BlockSummary>();
  let fetched = 0;
  await mapPool([...wanted.values()], DEM_CONCURRENCY, async ({ x, y }) => {
    const summary = await fetchSummary(cacheDir, x, y);
    if (summary !== null) tiles.set(`${x}/${y}`, summary);
    fetched += 1;
    if (fetched % 1000 === 0) console.log(`  dem: ${fetched}/${wanted.size} tiles`);
  });
  console.log(
    `dem: ${tiles.size}/${wanted.size} z${DEM_ZOOM} tiles (${((Date.now() - started) / 1000).toFixed(0)} s)`,
  );

  const layers = await loadLayers(cacheDir);
  console.log(`natural earth loaded (${((Date.now() - started) / 1000).toFixed(0)} s)`);

  const terrain = new Map<string, CatalogTerrain[]>();
  const relief = new Map<string, ReliefStats>();
  const lookup = (x: number, y: number): BlockSummary | undefined => tiles.get(`${x}/${y}`);
  for (const item of placed) {
    const found: CatalogTerrain[] = [];
    const stats = reliefStats(item.bbox, DEM_ZOOM, TILE_PX / BLOCK_PX, lookup);
    if (stats !== null) relief.set(item.id, stats);
    if (stats !== null && isMountainous(stats)) found.push('mountains');
    if (layers.water.intersects(item.bbox)) found.push('water');
    if (layers.glacier.intersects(item.bbox)) found.push('glacier');
    if (layers.coast.intersects(item.bbox)) found.push('coast');
    if (found.length > 0) terrain.set(item.id, found);
  }
  console.log(
    `terrain: ${placed.length} items classified in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  return { terrain, relief };
}
