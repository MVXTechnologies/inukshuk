/**
 * Reusing PDF detail tiles that are already rendered.
 *
 * Detail tiles live on a dyadic page grid (`planPdfDetailTiles`): a cell is
 * `divisions:x:y` and its raster has a width from a fixed ladder. Two things
 * make an already-rendered raster good enough for a cell the camera asks for:
 *
 * - **The same cell, at least as wide.** Zooming out a little asks for a
 *   narrower raster of the same cell; the wider one already on disk is sharper
 *   and is shown downsampled instead of being rendered again.
 * - **All four children, each at least half as wide.** Zooming out a whole
 *   level asks for the parent cell; its four children from the previous zoom
 *   cover it exactly, at the same or better density.
 *
 * Anything else is rendered — while the tiles already on screen stay there
 * (`detailFallback`) until the replacement lands.
 */

/** One grid cell at one raster width; the parsed form of a plan's `tileKey`. */
export interface TileCell {
  divisions: number;
  x: number;
  y: number;
  width: number;
}

/** `"divisions:x:y:width"` → its parts, or null for anything else. */
export function parseTileKey(tileKey: string | undefined): TileCell | null {
  if (tileKey === undefined) return null;
  const parts = tileKey.split(':');
  if (parts.length !== 4) return null;
  const [divisions, x, y, width] = parts.map(Number) as [number, number, number, number];
  if (![divisions, x, y, width].every((n) => Number.isInteger(n) && n >= 0)) return null;
  if (divisions < 1 || x >= divisions || y >= divisions || width < 1) return null;
  return { divisions, x, y, width };
}

/** What the cover search needs from a cached tile; the hook's `Detail` satisfies it. */
export interface CachedTile {
  /** Identity of the page and its look (file, revision, georeference, white key). */
  pageKey: string;
  /** Null for a raster that is not a grid cell; it only ever matches its own key. */
  cell: TileCell | null;
  pixels: number;
}

const sameCell = (a: TileCell, b: Omit<TileCell, 'width'>) =>
  a.divisions === b.divisions && a.x === b.x && a.y === b.y;

/**
 * Cached tiles that together show `cell` of `pageKey` at no less than its
 * requested density, or null when the cache cannot.
 *
 * Prefers one raster of the same cell (the narrowest one wide enough, the
 * least texture), then the four children of the next level down.
 */
export function coverFromCache<T extends CachedTile>(
  pageKey: string,
  cell: TileCell,
  cached: Iterable<T>,
): T[] | null {
  let exact: T | null = null;
  let exactWidth = Infinity;
  const children: (T | null)[] = [null, null, null, null];
  const childWidths = [Infinity, Infinity, Infinity, Infinity];
  const childDivisions = cell.divisions * 2;
  for (const tile of cached) {
    const c = tile.cell;
    if (tile.pageKey !== pageKey || c === null) continue;
    if (sameCell(c, cell)) {
      if (c.width >= cell.width && c.width < exactWidth) {
        exact = tile;
        exactWidth = c.width;
      }
      continue;
    }
    if (c.divisions !== childDivisions || c.width * 2 < cell.width) continue;
    const dx = c.x - cell.x * 2,
      dy = c.y - cell.y * 2;
    if (dx < 0 || dx > 1 || dy < 0 || dy > 1) continue;
    const slot = dy * 2 + dx;
    if (c.width < childWidths[slot]!) {
      children[slot] = tile;
      childWidths[slot] = c.width;
    }
  }
  if (exact) return [exact];
  if (children.every((child) => child !== null)) return children as T[];
  return null;
}

/** Memory and work limits for detail tiles. */
export interface PdfTileBudgets {
  /** Raster pixels of the tiles the camera asked for (textures on screen). */
  visiblePixels: number;
  /** Extra pixels for already-rendered tiles kept on screen during a change. */
  fallbackPixels: number;
  maxFallbackTiles: number;
  /** Neighbour ring as a fraction of the view on each side (0 = none). */
  prefetchMargin: number;
  maxPrefetchTiles: number;
  /**
   * Keep the PDF open in the renderer between the tiles of one burst. Saves
   * re-parsing the page per tile, at the cost of holding its parsed content
   * (operator list, decoded images) for a few idle seconds.
   */
  holdDocument: boolean;
  /** Rendered tiles kept on disk for reuse. */
  cacheFiles: number;
  /** Disk cache pixel cap while the camera is moving, and once settled. */
  handoffPixels: number;
  settledPixels: number;
}

const MI = 1024 * 1024;

/**
 * Limits for the device's memory state. On-screen textures (visible plus
 * fallback) cost GPU memory, so they are the same everywhere; prefetched and
 * cached tiles are files, not textures, and only cost disk and render time.
 * Once the OS has warned about memory the ring is dropped, the renderer stops
 * holding the document between tiles, the fallback shrinks and the cache holds little more than the visible set.
 */
export function pdfTileBudgets(lowMemory: boolean): PdfTileBudgets {
  if (lowMemory) {
    return {
      visiblePixels: 6 * MI,
      fallbackPixels: 2 * MI,
      maxFallbackTiles: 8,
      prefetchMargin: 0,
      maxPrefetchTiles: 0,
      holdDocument: false,
      cacheFiles: 40,
      handoffPixels: 10 * MI,
      settledPixels: 8 * MI,
    };
  }
  return {
    visiblePixels: 6 * MI,
    fallbackPixels: 6 * MI,
    maxFallbackTiles: 24,
    prefetchMargin: 1,
    maxPrefetchTiles: 24,
    holdDocument: true,
    cacheFiles: 96,
    handoffPixels: 36 * MI,
    settledPixels: 28 * MI,
  };
}
