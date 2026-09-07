import type { BoundingBox } from '@core/models';

/** Web-mercator X tile index for a longitude at zoom z. */
const lngToX = (lng: number, z: number): number => Math.floor(((lng + 180) / 360) * 2 ** z);

/** Web-mercator Y tile index for a latitude at zoom z (clamped to mercator range). */
const latToY = (lat: number, z: number): number => {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
  return Math.max(0, Math.min(2 ** z - 1, y));
};

/** Tile span of a bbox per axis at a single zoom: [xCount, yCount]. */
export function tileSpanAtZoom(b: BoundingBox, z: number): [number, number] {
  const maxTile = 2 ** z - 1;
  const x0 = Math.max(0, Math.min(maxTile, lngToX(b.minLng, z)));
  const x1 = Math.max(0, Math.min(maxTile, lngToX(b.maxLng, z)));
  const y0 = latToY(b.maxLat, z); // north = smaller y
  const y1 = latToY(b.minLat, z);
  return [Math.abs(x1 - x0) + 1, Math.abs(y1 - y0) + 1];
}

/** Tiles a bbox spans at a single zoom: (xCount) * (yCount). */
function tilesAtZoom(b: BoundingBox, z: number): number {
  const [xSpan, ySpan] = tileSpanAtZoom(b, z);
  return xSpan * ySpan;
}

/** Total tiles a region covers across an inclusive zoom range. */
export function tileCountForRegion(b: BoundingBox, minZoom: number, maxZoom: number): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) total += tilesAtZoom(b, z);
  return total;
}

/** Highest zoom whose tile span fits the region within `maxTilesPerSide` per axis. */
export function overviewZoomFor(b: BoundingBox, maxTilesPerSide = 2): number {
  for (let z = 0; z <= 17; z++) {
    const [xSpan, ySpan] = tileSpanAtZoom(b, z);
    if (xSpan > maxTilesPerSide || ySpan > maxTilesPerSide) return Math.max(0, z - 1);
  }
  return 17;
}

/**
 * The center tile {x,y,z} for a region, at the highest zoom where the region
 * still fits within a single tile per side — so one tile roughly frames the box.
 * Used to fetch a lightweight preview image of the area.
 */
export function centerTileForRegion(b: BoundingBox): { x: number; y: number; z: number } {
  const z = overviewZoomFor(b, 1);
  const cLng = (b.minLng + b.maxLng) / 2;
  const cLat = (b.minLat + b.maxLat) / 2;
  return { x: lngToX(cLng, z), y: latToY(cLat, z), z };
}

/** The downloadable raster basemaps. */
export type Basemap = 'map' | 'satellite' | 'relief';

/**
 * Highest zoom at which each tile service reliably serves REAL tiles worldwide —
 * the raster SOURCE's `maxzoom` (see `mapStyle.ts`, which builds the style from
 * this) and therefore the deepest zoom an offline pack of that basemap can ever
 * store: MapLibre's offline downloader never fetches past a source's `maxzoom`.
 *
 * Requesting a pack deeper than this is not just wasted — it produces a pack
 * whose requested zoom range is partly (or, for a small box whose overview zoom
 * already exceeds the cap, entirely) outside what the source can serve, which is
 * how the relief basemap (cap z15, requested z16/z17) failed to download while
 * map (z19) and satellite (z17) succeeded. Clamp with {@link packZoomRange}.
 */
export const NATIVE_MAX_ZOOM: Record<Basemap, number> = { map: 19, satellite: 17, relief: 15 };

/**
 * The zoom range an offline pack of `basemap` should actually be created with,
 * given the requested overview (min) and quality (max) zooms:
 *
 * - the top zoom is capped at the source's native max — a pack can't hold tiles
 *   the tile service doesn't serve;
 * - the bottom zoom is then capped at the top zoom, so the range is never
 *   inverted (MapLibre rejects `maxZoom < minZoom` outright) nor empty.
 */
export function packZoomRange(
  basemap: Basemap,
  minZoom: number,
  maxZoom: number,
): { minZoom: number; maxZoom: number } {
  const top = Math.min(Math.round(maxZoom), NATIVE_MAX_ZOOM[basemap]);
  const bottom = Math.max(0, Math.min(Math.round(minZoom), top));
  return { minZoom: bottom, maxZoom: top };
}

/**
 * Assumed top stored zoom for offline packs downloaded before the max zoom was
 * recorded in pack metadata: the shallowest quality option ('standard' = z15).
 * Assuming the shallowest keeps overzoom safe — the live map overscales from a
 * zoom the pack is guaranteed to contain instead of requesting missing tiles.
 */
export const OFFLINE_PACK_FALLBACK_MAX_ZOOM = 15;

/**
 * The zoom the live map's raster source should fetch up to (and overscale
 * beyond) when only locally downloaded tiles may be served: the SHALLOWEST max
 * zoom across this basemap's downloaded packs. Using the min means a pack
 * downloaded at a lower quality never shows missing-tile blanks past its top
 * zoom — deeper packs just render slightly blurrier than they could.
 */
export function offlinePackMaxZoom(
  packs: readonly { basemap: Basemap; maxZoom?: number }[],
  basemap: Basemap,
): number {
  let min = Number.POSITIVE_INFINITY;
  for (const p of packs) {
    if (p.basemap !== basemap) continue;
    min = Math.min(min, p.maxZoom ?? OFFLINE_PACK_FALLBACK_MAX_ZOOM);
  }
  return Number.isFinite(min) ? min : OFFLINE_PACK_FALLBACK_MAX_ZOOM;
}

// Rough average compressed tile sizes: Esri satellite/relief JPEG tiles are
// heavier than OSM/street PNG tiles. Used only for a pre-download size estimate.
const AVG_BYTES: Record<Basemap, number> = { map: 18_000, satellite: 30_000, relief: 28_000 };

export function estimateBytes(tileCount: number, basemap: Basemap): number {
  return tileCount * AVG_BYTES[basemap];
}

/**
 * Total bytes to download a region for several basemaps at once: the tile
 * geometry is identical per basemap, so it's `tileCount` summed against each
 * basemap's average tile size.
 */
export function estimateBytesForBasemaps(tileCount: number, basemaps: readonly Basemap[]): number {
  return basemaps.reduce((sum, b) => sum + estimateBytes(tileCount, b), 0);
}

/**
 * Pre-download estimate for a region across several basemaps. Each basemap gets
 * its own clamped zoom range ({@link packZoomRange}), so a basemap whose source
 * tops out early (relief at z15) is estimated for the tiles it will really
 * store, not for the requested quality zoom it cannot reach.
 */
export function estimateRegionDownload(
  bounds: BoundingBox,
  minZoom: number,
  maxZoom: number,
  basemaps: readonly Basemap[],
): { tiles: number; bytes: number } {
  let tiles = 0;
  let bytes = 0;
  for (const basemap of basemaps) {
    const range = packZoomRange(basemap, minZoom, maxZoom);
    const count = tileCountForRegion(bounds, range.minZoom, range.maxZoom);
    tiles += count;
    bytes += estimateBytes(count, basemap);
  }
  return { tiles, bytes };
}

// ---------------------------------------------------------------------------
// Live-viewport tile arithmetic (#230 — why zooming out costs so much)
// ---------------------------------------------------------------------------

/**
 * MapLibre's canonical tile size in logical pixels. Zoom is defined against it:
 * at zoom `z` the world is `512 * 2^z` px wide, whatever a source declares.
 */
export const CANONICAL_TILE_PX = 512;

/** A device viewport in logical (CSS/dp) pixels. */
export interface ViewportPx {
  width: number;
  height: number;
}

/**
 * The tile zoom MapLibre asks a source for at a given CAMERA zoom.
 *
 * Because zoom is defined against {@link CANONICAL_TILE_PX}, a source that
 * declares **256-px tiles is requested one zoom level DEEPER than the camera**
 * (`z + log2(512/256)`), while a 512-px source is requested at the camera's own
 * zoom — the same view, a quarter of the tiles. Past the source's `maxzoom`
 * MapLibre stops fetching and overscales the deepest real tiles instead.
 */
export function sourceTileZoom(
  cameraZoom: number,
  tileSize: number,
  sourceMaxZoom: number,
): number {
  const ideal = Math.max(0, Math.floor(cameraZoom + Math.log2(CANONICAL_TILE_PX / tileSize)));
  return Math.min(sourceMaxZoom, ideal);
}

/**
 * How many tiles of a source a viewport needs at one camera zoom.
 *
 * NOTE — this is (deliberately) almost flat in zoom: a viewport covers the same
 * number of tiles at z8 as at z12. Zooming out does **not** put more tiles on
 * screen; what it does is cross pyramid LEVELS, and each level crossed is a
 * whole fresh set of tiles to fetch, decode and — for a `raster-dem` feeding a
 * hillshade — prepare. See {@link zoomOutTileLoad}, which is the number that
 * actually explains #230.
 *
 * Assumes integer camera zooms (tiles at their nominal screen size), which is
 * the worst case: a fractional zoom draws tiles larger, so fewer of them.
 */
export function viewportTileCount(
  cameraZoom: number,
  viewport: ViewportPx,
  tileSize: number,
  sourceMaxZoom: number,
): number {
  const ideal = Math.max(0, Math.floor(cameraZoom + Math.log2(CANONICAL_TILE_PX / tileSize)));
  const tileZ = Math.min(sourceMaxZoom, ideal);
  // Past `maxzoom` one tile is stretched over 2^(ideal - tileZ) times its width.
  const screenPx = tileSize * 2 ** (ideal - tileZ);
  const across = Math.ceil(viewport.width / screenPx) + 1;
  const down = Math.ceil(viewport.height / screenPx) + 1;
  return across * down;
}

/**
 * Tiles a source has to load over one continuous zoom-OUT from `fromZoom` to
 * `toZoom` — the cost of the gesture, not of a resting frame.
 *
 * Every integer camera zoom crossed maps to a different pyramid level, and each
 * level is a full viewport of brand-new tiles. `layerMinZoom` models a zoom-gated
 * layer: MapLibre only keeps a source loaded while some layer using it is within
 * its zoom range, so camera zooms below the gate cost nothing at all.
 */
export function zoomOutTileLoad(
  fromZoom: number,
  toZoom: number,
  viewport: ViewportPx,
  tileSize: number,
  sourceMaxZoom: number,
  layerMinZoom = 0,
): number {
  /** Worst-case tiles per pyramid level touched; the `maxzoom` clamp can map
   *  several camera zooms onto one level, and only the largest set is fetched. */
  const perLevel = new Map<number, number>();
  for (let z = Math.floor(fromZoom); z >= Math.ceil(toZoom); z--) {
    if (z < layerMinZoom) continue;
    const tileZ = sourceTileZoom(z, tileSize, sourceMaxZoom);
    const count = viewportTileCount(z, viewport, tileSize, sourceMaxZoom);
    perLevel.set(tileZ, Math.max(perLevel.get(tileZ) ?? 0, count));
  }
  let total = 0;
  for (const n of perLevel.values()) total += n;
  return total;
}
