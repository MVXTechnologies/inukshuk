import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';
import { bboxCenter } from './nearest';
import type { CatalogBbox, CatalogCategory, CatalogItem, CatalogShardRef } from './schema';

/**
 * Catalog sharding — the pure geometry behind `/catalog/v2/`.
 *
 * A world catalog is tens of thousands of sheets; one JSON is a multi-megabyte
 * download on a trailhead's worth of signal. So the generator splits items into
 * **category × geographic cell** shards and publishes a small index listing
 * them, and the client fetches only the shards it actually needs.
 *
 * The cell grid is a quadtree over WGS84 rooted at 10° cells:
 *
 * - level 0 is a 10°×10° cell whose origin is the item's bbox-center floored to
 *   a multiple of 10 — id `n45w075` (south/west corner, hemisphere-prefixed);
 * - a cell holding more than {@link DEFAULT_MAX_SHARD_ITEMS} items subdivides
 *   into four quadrants (`0` SW, `1` SE, `2` NW, `3` NE), appended to the id
 *   after a dash: `n45w075-1`, `n45w075-13`, … Each level halves the side, so
 *   level L cells are 10 / 2^L degrees;
 * - subdivision stops at {@link DEFAULT_MIN_CELL_DEG} — a dense city harbour
 *   must not spawn a thousand shards, an over-full leaf is simply accepted;
 * - items with no bbox land in one `nogeo` shard per category (they can't be
 *   placed, so they can't be ranked by place — see `sortCatalogItems`).
 *
 * Items are assigned by their bbox **center**, so a sheet straddling a cell
 * edge lives in exactly one shard; the shard's published bbox is the *union* of
 * its items' bboxes (not the cell), so nearest-shard ranking still finds a
 * sheet whose coverage reaches into the neighbouring cell.
 *
 * Everything here is pure and shared: the generator plans and names shards with
 * it, the client ranks and picks them with it, so a rename can't desync them.
 */

/** Side of a level-0 cell, in degrees. */
export const SHARD_ROOT_CELL_DEG = 10;

/** Split a cell once it holds more items than this (if it may still split). */
export const DEFAULT_MAX_SHARD_ITEMS = 400;

/** Never subdivide below this side length; an over-full leaf is accepted. */
export const DEFAULT_MIN_CELL_DEG = 1.25;

/** Category suffix used for items that carry no bbox. */
export const NOGEO_CELL_ID = 'nogeo';

/** A quadtree cell: a level-0 origin plus the quadrant path taken from it. */
export interface ShardCell {
  /** Level-0 cell origin longitude (multiple of 10, west edge). */
  rootWest: number;
  /** Level-0 cell origin latitude (multiple of 10, south edge). */
  rootSouth: number;
  /** Quadrant digits from the root: 0 = SW, 1 = SE, 2 = NW, 3 = NE. */
  path: readonly number[];
}

/** Floor `value` to a multiple of `step` (works for negatives). */
function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

/** The level-0 cell containing a point. */
export function rootCellFor(point: LatLng): ShardCell {
  return {
    rootWest: floorTo(point.longitude, SHARD_ROOT_CELL_DEG),
    rootSouth: floorTo(point.latitude, SHARD_ROOT_CELL_DEG),
    path: [],
  };
}

/** Side length of a cell in degrees. */
export function cellSizeDeg(cell: ShardCell): number {
  return SHARD_ROOT_CELL_DEG / 2 ** cell.path.length;
}

/** WGS84 [west, south, east, north] of a cell. */
export function cellBbox(cell: ShardCell): CatalogBbox {
  let west = cell.rootWest;
  let south = cell.rootSouth;
  let size = SHARD_ROOT_CELL_DEG;
  for (const quadrant of cell.path) {
    size /= 2;
    if (quadrant === 1 || quadrant === 3) west += size;
    if (quadrant === 2 || quadrant === 3) south += size;
  }
  return [west, south, west + size, south + size];
}

/** The four child cells, in quadrant order (SW, SE, NW, NE). */
export function subdivideCell(cell: ShardCell): ShardCell[] {
  return [0, 1, 2, 3].map((quadrant) => ({
    rootWest: cell.rootWest,
    rootSouth: cell.rootSouth,
    path: [...cell.path, quadrant],
  }));
}

/** Zero-pad an absolute degree value ("5" → "005" for longitudes). */
function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, '0');
}

/**
 * Stable, filename-safe cell id: hemisphere-prefixed level-0 origin plus the
 * quadrant path — `n45w075`, `s34e018-20`. Matches the shard-id charset the
 * manifest parser enforces.
 */
export function cellId(cell: ShardCell): string {
  const ns = cell.rootSouth < 0 ? 's' : 'n';
  const ew = cell.rootWest < 0 ? 'w' : 'e';
  const root = `${ns}${pad(cell.rootSouth, 2)}${ew}${pad(cell.rootWest, 3)}`;
  return cell.path.length === 0 ? root : `${root}-${cell.path.join('')}`;
}

/** Which quadrant of `cell` a point falls in (0 SW, 1 SE, 2 NW, 3 NE). */
function quadrantFor(cell: ShardCell, point: LatLng): number {
  const [west, south, east, north] = cellBbox(cell);
  const easternHalf = point.longitude >= (west + east) / 2 ? 1 : 0;
  const northernHalf = point.latitude >= (south + north) / 2 ? 2 : 0;
  return easternHalf + northernHalf;
}

/** Union of two bboxes (null-tolerant so it folds over a list). */
function unionBbox(a: CatalogBbox | null, b: CatalogBbox): CatalogBbox {
  if (a === null) return [...b] as CatalogBbox;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** One planned shard: its identity, its published metadata, and its payload. */
export interface PlannedShard {
  /** `${category}-${cellId}`, e.g. "topo-n45w075" or "nautical-nogeo". */
  id: string;
  category: CatalogCategory;
  /** Union of the items' bboxes; absent for a `nogeo` shard. */
  bbox?: CatalogBbox;
  items: CatalogItem[];
}

export interface ShardPlanOptions {
  maxItems?: number;
  minCellDeg?: number;
}

/** Split one category's placeable items into cells, subdividing dense ones. */
function planCells(
  items: readonly CatalogItem[],
  maxItems: number,
  minCellDeg: number,
): Map<string, CatalogItem[]> {
  const byRoot = new Map<string, { cell: ShardCell; items: CatalogItem[] }>();
  for (const item of items) {
    if (item.bbox === undefined) continue;
    const cell = rootCellFor(bboxCenter(item.bbox));
    const id = cellId(cell);
    const bucket = byRoot.get(id);
    if (bucket === undefined) byRoot.set(id, { cell, items: [item] });
    else bucket.items.push(item);
  }

  const leaves = new Map<string, CatalogItem[]>();
  const queue = [...byRoot.values()];
  while (queue.length > 0) {
    const bucket = queue.pop();
    if (bucket === undefined) break;
    if (bucket.items.length <= maxItems || cellSizeDeg(bucket.cell) / 2 < minCellDeg) {
      leaves.set(cellId(bucket.cell), bucket.items);
      continue;
    }
    const children = subdivideCell(bucket.cell).map((cell) => ({
      cell,
      items: [] as CatalogItem[],
    }));
    for (const item of bucket.items) {
      if (item.bbox === undefined) continue;
      const child = children[quadrantFor(bucket.cell, bboxCenter(item.bbox))];
      // `noUncheckedIndexedAccess`: quadrantFor is 0..3 and children has 4.
      if (child !== undefined) child.items.push(item);
    }
    for (const child of children) if (child.items.length > 0) queue.push(child);
  }
  return leaves;
}

/**
 * Plan the whole catalog's shards, deterministically: same items in, same
 * shard ids and same item order out, so a regenerated catalog produces a
 * byte-identical diff when nothing upstream changed.
 */
export function planCatalogShards(
  items: readonly CatalogItem[],
  options?: ShardPlanOptions,
): PlannedShard[] {
  const maxItems = Math.max(1, options?.maxItems ?? DEFAULT_MAX_SHARD_ITEMS);
  const minCellDeg = Math.max(0.01, options?.minCellDeg ?? DEFAULT_MIN_CELL_DEG);

  const byCategory = new Map<CatalogCategory, CatalogItem[]>();
  for (const item of items) {
    const bucket = byCategory.get(item.category);
    if (bucket === undefined) byCategory.set(item.category, [item]);
    else bucket.push(item);
  }

  const shards: PlannedShard[] = [];
  for (const [category, categoryItems] of byCategory) {
    const nogeo = categoryItems.filter((item) => item.bbox === undefined);
    if (nogeo.length > 0) {
      shards.push({
        id: `${category}-${NOGEO_CELL_ID}`,
        category,
        items: [...nogeo].sort((a, b) => a.id.localeCompare(b.id)),
      });
    }
    for (const [id, cellItems] of planCells(categoryItems, maxItems, minCellDeg)) {
      let bbox: CatalogBbox | null = null;
      for (const item of cellItems) if (item.bbox !== undefined) bbox = unionBbox(bbox, item.bbox);
      shards.push({
        id: `${category}-${id}`,
        category,
        ...(bbox !== null ? { bbox } : {}),
        items: [...cellItems].sort((a, b) => a.id.localeCompare(b.id)),
      });
    }
  }
  shards.sort((a, b) => a.id.localeCompare(b.id));
  return shards;
}

/**
 * Resolve a shard's relative `path` against the index URL it came from.
 *
 * Hand-rolled rather than `new URL(path, base)` on purpose: React Native's URL
 * shim does not implement relative resolution, and this is the one place the
 * client turns manifest data into a network request — so it stays pure, tested,
 * and refuses anything that isn't a plain relative path (the parser already
 * rejects those, this is the second lock on the same door).
 */
export function resolveCatalogUrl(indexUrl: string, path: string): string | null {
  if (path === '' || path.startsWith('/') || path.includes('..')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const withoutQuery = indexUrl.split(/[?#]/)[0] ?? '';
  const lastSlash = withoutQuery.lastIndexOf('/');
  // Guard against a base with no path of its own ("https://example.test"),
  // where the last slash is still the scheme's own "//".
  if (lastSlash < 0 || lastSlash <= withoutQuery.indexOf('//') + 1) return null;
  return `${withoutQuery.slice(0, lastSlash + 1)}${path}`;
}

/** `scheme://host[:port]` of an absolute http(s) URL, lowercased; null if not one. */
function originOf(url: string): string | null {
  const match = /^(https?):\/\/([^/?#]+)/i.exec(url);
  return match === null ? null : `${match[1]?.toLowerCase()}://${match[2]?.toLowerCase()}`;
}

/**
 * Do two catalog URLs come from the same publisher?
 *
 * The on-device cache is keyed by the exact URL it was fetched from, so a build
 * pointed at a different catalog (a dev override, an e2e loopback fixture) can
 * never reuse production's copy. But moving the *path* — `/catalog/v1/manifest.json`
 * to `/catalog/v2/index.json` — is an upgrade of the same catalog, and treating
 * it as a foreign document is what turned "open the store offline right after
 * updating" into an error screen. Same origin ⇒ the stale copy is still a
 * last-resort fallback; different origin ⇒ it never is.
 */
export function sameCatalogOrigin(a: string, b: string): boolean {
  const left = originOf(a);
  const right = originOf(b);
  return left !== null && right !== null && left === right;
}

/* --------------------------------------------------- client-side ranking --- */

/**
 * Great-circle metres from `origin` to the nearest point of `bbox` — 0 when the
 * origin is inside it. Clamping longitude ignores the antimeridian, which only
 * mis-ranks shards on the ±180° seam (they still load, just later).
 */
export function distanceToBboxMeters(bbox: CatalogBbox, origin: LatLng): number {
  const [west, south, east, north] = bbox;
  const latitude = Math.min(Math.max(origin.latitude, south), north);
  const longitude = Math.min(Math.max(origin.longitude, west), east);
  return haversineMeters(origin, { latitude, longitude });
}

/**
 * Order shard refs by how near their coverage is to `origin`. Shards with no
 * bbox (`nogeo`) always sort last; with no origin, ids sort alphabetically so
 * the choice is at least stable. Never mutates the input.
 */
export function rankShardsByDistance(
  shards: readonly CatalogShardRef[],
  origin: LatLng | null,
): CatalogShardRef[] {
  const ranked = [...shards];
  if (origin === null) {
    ranked.sort((a, b) => a.id.localeCompare(b.id));
    return ranked;
  }
  const distances = new Map<string, number | null>(
    shards.map((shard) => [
      shard.id,
      shard.bbox === undefined ? null : distanceToBboxMeters(shard.bbox, origin),
    ]),
  );
  ranked.sort((a, b) => {
    const da = distances.get(a.id) ?? null;
    const db = distances.get(b.id) ?? null;
    if (da === null && db === null) return a.id.localeCompare(b.id);
    if (da === null) return 1;
    if (db === null) return -1;
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });
  return ranked;
}

export interface ShardSelection {
  /** Restrict to one category; null/undefined selects across all of them. */
  category?: CatalogCategory | null;
  /** Hard cap on how many shards to pull. */
  limit: number;
  /** Also stop once the selected shards exceed this many bytes. */
  byteBudget?: number;
}

/**
 * Pick the shards worth fetching now: nearest-first within the requested
 * category, capped by count and (optionally) by total download size, so a
 * dense area can't turn "open the Search tab" into a 5 MB fetch.
 *
 * When selecting across all categories the pick is round-robin by category
 * before distance, so one dense category (the 30 000 US topo quads) can't crowd
 * every other category out of "Around you".
 */
export function selectShards(
  shards: readonly CatalogShardRef[],
  origin: LatLng | null,
  selection: ShardSelection,
): CatalogShardRef[] {
  const scoped =
    selection.category == null
      ? shards
      : shards.filter((shard) => shard.category === selection.category);
  const ranked = rankShardsByDistance(scoped, origin);

  const ordered = selection.category == null ? interleaveByCategory(ranked) : ranked;

  const picked: CatalogShardRef[] = [];
  let bytes = 0;
  for (const shard of ordered) {
    if (picked.length >= selection.limit) break;
    const size = shard.byteSize ?? 0;
    if (
      selection.byteBudget !== undefined &&
      picked.length > 0 &&
      bytes + size > selection.byteBudget
    ) {
      break;
    }
    picked.push(shard);
    bytes += size;
  }
  return picked;
}

/** Round-robin an already-ranked list so every category gets a turn. */
function interleaveByCategory(ranked: readonly CatalogShardRef[]): CatalogShardRef[] {
  const queues = new Map<CatalogCategory, CatalogShardRef[]>();
  for (const shard of ranked) {
    const queue = queues.get(shard.category);
    if (queue === undefined) queues.set(shard.category, [shard]);
    else queue.push(shard);
  }
  const out: CatalogShardRef[] = [];
  let drained = false;
  for (let round = 0; !drained; round += 1) {
    drained = true;
    for (const queue of queues.values()) {
      const shard = queue[round];
      if (shard === undefined) continue;
      drained = false;
      out.push(shard);
    }
  }
  return out;
}
