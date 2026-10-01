/**
 * The personal heatmap as a stored, tiled product (#500).
 *
 * The pass grid (see `heatGrid`) is cut into fixed ground tiles of
 * {@link HEAT_TILE_DEG}°. Each tile keeps, per trail ("slot"), what that trail
 * contributes inside it — the cells it visits, where in each cell it ran, and
 * the steps it took from those cells — so a trail can be added or taken out
 * by touching only its own tiles, and the result never depends on the order
 * trails came in (counts and offset sums are integers).
 *
 * From a tile's aggregate (plus a two-cell halo from its neighbours) come
 * the renderable pieces stored next to it: the street-zoom pass-count lines
 * and the low-zoom glow points. The map then reads only the tiles in view.
 *
 * Pure.
 */

import type { Feature, FeatureCollection, MultiLineString, Point } from 'geojson';

import { boxRects } from '@core/geo/bboxIndex';
import type { BoundingBox } from '@core/models';

import {
  CellGrid,
  heatGlowPoints,
  heatGridLines,
  type HeatGlowProps,
  type HeatGrid,
  type HeatLineProps,
  type TrackCellWalk,
} from './heatGrid';

/** Tile size in degrees (≈3.5 km north–south; ≈2.4 km east–west at 46° N). */
export const HEAT_TILE_DEG = 1 / 32;
const TILE_COLS = 360 * 32;
const TILE_ROWS = 180 * 32;
/** Unit of a trail's in-cell offset from the cell centre (≈1 m). */
export const OFFSET_UNIT_DEG = 1e-5;

/** `"x_y"`: column (from 180° W) and row (from 90° S) of a tile. */
export type TileKey = string;

/** The tile holding (lng, lat). */
export function tileKeyAt(lng: number, lat: number): TileKey {
  const x = Math.floor((lng + 180) / HEAT_TILE_DEG);
  const y = Math.floor((lat + 90) / HEAT_TILE_DEG);
  const col = ((x % TILE_COLS) + TILE_COLS) % TILE_COLS;
  const row = Math.max(0, Math.min(TILE_ROWS - 1, y));
  return `${col}_${row}`;
}

/** Column/row of a tile key, or null when it is not one. */
export function parseTileKey(key: string): { x: number; y: number } | null {
  const m = /^(\d+)_(\d+)$/.exec(key);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (x >= TILE_COLS || y >= TILE_ROWS) return null;
  return { x, y };
}

/** The ground a tile covers. */
export function tileBounds(key: TileKey): BoundingBox {
  const t = parseTileKey(key);
  if (!t) return { minLat: NaN, maxLat: NaN, minLng: NaN, maxLng: NaN };
  return {
    minLng: t.x * HEAT_TILE_DEG - 180,
    maxLng: (t.x + 1) * HEAT_TILE_DEG - 180,
    minLat: t.y * HEAT_TILE_DEG - 90,
    maxLat: (t.y + 1) * HEAT_TILE_DEG - 90,
  };
}

/** The 8 tiles around `key` (wrapping east–west; none past a pole). */
export function neighbourTiles(key: TileKey): TileKey[] {
  const t = parseTileKey(key);
  if (!t) return [];
  const out: TileKey[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    const y = t.y + dy;
    if (y < 0 || y >= TILE_ROWS) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      out.push(`${(t.x + dx + TILE_COLS) % TILE_COLS}_${y}`);
    }
  }
  return out;
}

/**
 * Which of `keys` meet `bounds` (`null` = everywhere), antimeridian-aware.
 * Iterates the given tiles, never the ground: a world view costs one box
 * test per stored tile.
 */
export function tilesMeeting(keys: Iterable<TileKey>, bounds: BoundingBox | null): TileKey[] {
  const out: TileKey[] = [];
  const rects = bounds ? boxRects(bounds) : null;
  for (const k of keys) {
    if (!rects) {
      out.push(k);
      continue;
    }
    const b = tileBounds(k);
    if (rects.some((r) => b.minLng <= r.e && r.w <= b.maxLng && b.minLat <= r.n && r.s <= b.maxLat))
      out.push(k);
  }
  return out;
}

/**
 * Cell → tile, by the cell's centre (so every cell has exactly one tile).
 * Memoized per instance: use one per batch of work, not forever.
 */
export class TileMapper {
  private readonly cache = new Map<number, TileKey>();
  constructor(readonly grid: CellGrid) {}
  tileOf(cell: number): TileKey {
    let t = this.cache.get(cell);
    if (t === undefined) {
      const [lng, lat] = this.grid.center(cell);
      t = tileKeyAt(lng, lat);
      this.cache.set(cell, t);
    }
    return t;
  }
}

// ---- one trail inside one tile ----------------------------------------------

/**
 * What one trail contributes to one tile. Cells are sorted ascending;
 * `dx`/`dy` are the trail's mean position in each cell, as an offset from
 * the cell centre in {@link OFFSET_UNIT_DEG}; bit `i` of `mask` is a step
 * from that cell to the `i`-th of its 8 ring neighbours (owned here because
 * this cell is the edge's lower key); `extra` holds owned steps to a cell
 * outside the ring as flat `[a, b, …]` pairs (rare: grid-projection corners).
 */
export interface TileContribution {
  cells: Float64Array;
  dx: Int32Array;
  dy: Int32Array;
  mask: Uint8Array;
  extra: Float64Array;
}

/** The ring index (0..8, 4 = the cell itself) → mask bit, and back. */
const bitOfRing = (j: number) => (j < 4 ? j : j - 1);
const ringOfBit = (b: number) => (b < 4 ? b : b + 1);

/** Split one trail's walk into per-tile contributions. */
export function trackContributions(
  walk: TrackCellWalk,
  mapper: TileMapper,
): Map<TileKey, TileContribution> {
  const grid = mapper.grid;
  const byTile = new Map<TileKey, number[]>();
  for (const c of walk.cells) {
    const t = mapper.tileOf(c);
    const list = byTile.get(t);
    if (list) list.push(c);
    else byTile.set(t, [c]);
  }
  const out = new Map<TileKey, TileContribution>();
  const where = new Map<number, { c: TileContribution; i: number; extra: number[] }>();
  const extras = new Map<TileKey, number[]>();
  for (const [tile, list] of byTile) {
    list.sort((a, b) => a - b);
    const n = list.length;
    const contribution: TileContribution = {
      cells: Float64Array.from(list),
      dx: new Int32Array(n),
      dy: new Int32Array(n),
      mask: new Uint8Array(n),
      extra: new Float64Array(0),
    };
    const extra: number[] = [];
    extras.set(tile, extra);
    for (let i = 0; i < n; i++) {
      const cell = list[i] as number;
      const [cx, cy] = grid.center(cell);
      const s = walk.sums.get(cell);
      if (s && s[2] > 0) {
        contribution.dx[i] = Math.round((s[0] / s[2] - cx) / OFFSET_UNIT_DEG);
        contribution.dy[i] = Math.round((s[1] / s[2] - cy) / OFFSET_UNIT_DEG);
      }
      where.set(cell, { c: contribution, i, extra });
    }
    out.set(tile, contribution);
  }
  for (const e of walk.edges) {
    const sep = e.indexOf(':');
    const a = Number(e.slice(0, sep));
    const b = Number(e.slice(sep + 1));
    const w = where.get(a);
    if (!w) continue;
    const j = grid.ring(a).indexOf(b);
    if (j >= 0 && j !== 4) w.c.mask[w.i] = (w.c.mask[w.i] as number) | (1 << bitOfRing(j));
    else w.extra.push(a, b);
  }
  for (const [tile, extra] of extras) {
    const c = out.get(tile);
    if (c && extra.length > 0) c.extra = Float64Array.from(extra);
  }
  return out;
}

// ---- one tile, every trail ----------------------------------------------------

/** One tile's stored grid: slot → that trail's contribution here. */
export class TileGrid {
  readonly slots = new Map<number, TileContribution>();
}

/** A tile's merged counts (integers: independent of the order trails came in). */
export interface TileAggregate {
  /** cell → distinct trails through it. */
  cellCounts: Map<number, number>;
  /** cell → summed offsets `[Σdx, Σdy]` (one mean per trail). */
  sums: Map<number, [number, number]>;
  /** owned undirected edge `"a:b"` (a < b, a in this tile) → distinct trails. */
  edgeCounts: Map<string, number>;
}

/** Merge a tile's contributions (cells and edges in ascending order). */
export function aggregateTile(tile: TileGrid, grid: CellGrid): TileAggregate {
  const counts = new Map<number, number>();
  const sums = new Map<number, [number, number]>();
  const edges = new Map<string, number>();
  const bump = (a: number, b: number) => {
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    edges.set(k, (edges.get(k) ?? 0) + 1);
  };
  for (const c of tile.slots.values()) {
    for (let i = 0; i < c.cells.length; i++) {
      const cell = c.cells[i] as number;
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
      const s = sums.get(cell);
      if (s) {
        s[0] += c.dx[i] as number;
        s[1] += c.dy[i] as number;
      } else sums.set(cell, [c.dx[i] as number, c.dy[i] as number]);
      const m = c.mask[i] as number;
      if (m !== 0) {
        const ring = grid.ring(cell);
        for (let bit = 0; bit < 8; bit++) {
          if (m & (1 << bit)) bump(cell, ring[ringOfBit(bit)] as number);
        }
      }
    }
    for (let i = 0; i + 1 < c.extra.length; i += 2)
      bump(c.extra[i] as number, c.extra[i + 1] as number);
  }
  // Ascending order: the derived lines never depend on which trail came first.
  const cellCounts = new Map([...counts].sort((x, y) => x[0] - y[0]));
  const edgeCounts = new Map(
    [...edges]
      .map(([k, n]) => {
        const sep = k.indexOf(':');
        return { k, n, a: Number(k.slice(0, sep)), b: Number(k.slice(sep + 1)) };
      })
      .sort((x, y) => x.a - y.a || x.b - y.b)
      .map((e) => [e.k, e.n] as const),
  );
  return { cellCounts, sums, edgeCounts };
}

// ---- render pieces -------------------------------------------------------------

/** What the map draws for one tile. */
export interface TileRender {
  /** Street-zoom pass-count chains, one feature per pass bucket (ascending). */
  lines: FeatureCollection<MultiLineString, HeatLineProps>;
  /** Low-zoom glow: one weighted point per occupied coarse cell. */
  glow: FeatureCollection<Point, HeatGlowProps>;
}

/**
 * The render pieces of `targets`, from the aggregates of those tiles AND
 * their neighbours (a tile's lines read the counts and centroids up to two
 * cells past its edge; pass every neighbour that exists). A tile draws the
 * edges it owns, so a street crossing a tile edge is two chains meeting at
 * the shared cell centroid.
 */
export function deriveTileRenders(
  grid: CellGrid,
  aggregates: ReadonlyMap<TileKey, TileAggregate>,
  targets: Iterable<TileKey>,
): Map<TileKey, TileRender> {
  const merged = mergeAggregates(grid, aggregates.values());
  const out = new Map<TileKey, TileRender>();
  for (const key of targets) {
    const agg = aggregates.get(key);
    const render = agg ? deriveTileRender(merged, agg) : null;
    if (render) out.set(key, render);
  }
  return out;
}

/** Cell counts and centroids of several tiles, for {@link deriveTileRender}. */
export type MergedCells = Pick<HeatGrid, 'grid' | 'cellCounts' | 'centroids'>;

/** Merge tiles' cells (a target and its neighbours) into one lookup. */
export function mergeAggregates(grid: CellGrid, aggregates: Iterable<TileAggregate>): MergedCells {
  const cellCounts = new Map<number, number>();
  const centroids = new Map<number, [number, number]>();
  for (const agg of aggregates) {
    for (const [cell, n] of agg.cellCounts) {
      cellCounts.set(cell, n);
      const s = agg.sums.get(cell);
      const [cx, cy] = grid.center(cell);
      centroids.set(
        cell,
        s ? [cx + (s[0] / n) * OFFSET_UNIT_DEG, cy + (s[1] / n) * OFFSET_UNIT_DEG] : [cx, cy],
      );
    }
  }
  return { grid, cellCounts, centroids };
}

/**
 * One tile's render pieces: its owned edges as lines (read against the
 * merged neighbourhood) and its own cells as glow. Null for an empty tile.
 */
export function deriveTileRender(merged: MergedCells, agg: TileAggregate): TileRender | null {
  if (agg.cellCounts.size === 0) return null;
  return {
    lines: heatGridLines({ ...merged, edgeCounts: agg.edgeCounts }),
    glow: heatGlowPoints({
      grid: merged.grid,
      cellCounts: agg.cellCounts,
      centroids: merged.centroids,
      edgeCounts: agg.edgeCounts,
    }),
  };
}

/** How far (cells) a tile's render reads past its own cells. */
export const RENDER_REACH_CELLS = 2;

/**
 * Tiles whose render pieces change when `cells` change: a tile's lines read
 * cells up to two cells past its own (an edge's far end, and that end's ring
 * for the pass-count smoothing).
 */
export function renderDirtyTiles(cells: Iterable<number>, mapper: TileMapper): Set<TileKey> {
  const out = new Set<TileKey>();
  const grid = mapper.grid;
  for (const c of cells) {
    const own = mapper.tileOf(c);
    out.add(own);
    // Only a cell within reach of its tile's edge can matter to a neighbour.
    const [lng, lat] = grid.center(c);
    const [w, h] = grid.spanDeg(c);
    const b = tileBounds(own);
    const reachLng = w * (RENDER_REACH_CELLS + 1);
    const reachLat = h * (RENDER_REACH_CELLS + 1);
    if (
      lng - b.minLng > reachLng &&
      b.maxLng - lng > reachLng &&
      lat - b.minLat > reachLat &&
      b.maxLat - lat > reachLat
    ) {
      continue;
    }
    for (const k of grid.neighbourhood(c, RENDER_REACH_CELLS)) out.add(mapper.tileOf(k));
  }
  return out;
}

// ---- tap lookup -----------------------------------------------------------------

/** A tile's cell → slots table, compact (CSR): `slots[offsets[i]..offsets[i+1])`. */
export interface TileTap {
  cells: Float64Array;
  offsets: Uint32Array;
  slots: Uint32Array;
}

/** Index a tile's trails by cell, for taps. */
export function tileTap(tile: TileGrid): TileTap {
  const bySlot = new Map<number, number[]>();
  for (const [slot, c] of tile.slots) {
    for (const cell of c.cells) {
      const list = bySlot.get(cell);
      if (list) list.push(slot);
      else bySlot.set(cell, [slot]);
    }
  }
  const sorted = [...bySlot.keys()].sort((a, b) => a - b);
  const cells = Float64Array.from(sorted);
  const offsets = new Uint32Array(sorted.length + 1);
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    offsets[i] = total;
    total += (bySlot.get(sorted[i] as number) as number[]).length;
  }
  offsets[sorted.length] = total;
  const slots = new Uint32Array(total);
  let at = 0;
  for (const cell of sorted) {
    for (const s of (bySlot.get(cell) as number[]).sort((a, b) => a - b)) slots[at++] = s;
  }
  return { cells, offsets, slots };
}

/** The slots through `cell` in a tile's tap table (binary search; empty if none). */
export function tapSlots(tap: TileTap, cell: number): Uint32Array {
  let lo = 0;
  let hi = tap.cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = tap.cells[mid] as number;
    if (v === cell) return tap.slots.subarray(tap.offsets[mid], tap.offsets[mid + 1]);
    if (v < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return EMPTY_SLOTS;
}
const EMPTY_SLOTS = new Uint32Array(0);

/** Who a stored slot is now: its trail id and live category, or null (gone / no longer counted). */
export type SlotResolver = (slot: number) => { id: string; categoryId: string } | null;

/**
 * The stored heat's tiles as a tap index (`GridIndexLike`): cell → category →
 * trail ids, resolved at lookup time, so a re-categorized trail is grouped
 * by its new category without touching the store.
 */
export class StoredTapIndex {
  constructor(
    private readonly mapper: TileMapper,
    private readonly taps: ReadonlyMap<TileKey, TileTap>,
    private readonly resolve: SlotResolver,
  ) {}
  get(cell: number): ReadonlyMap<string, readonly string[]> | undefined {
    const tap = this.taps.get(this.mapper.tileOf(cell));
    if (!tap) return undefined;
    const slots = tapSlots(tap, cell);
    if (slots.length === 0) return undefined;
    let out: Map<string, string[]> | undefined;
    for (const s of slots) {
      const who = this.resolve(s);
      if (!who) continue;
      out ??= new Map();
      const ids = out.get(who.categoryId);
      if (ids) ids.push(who.id);
      else out.set(who.categoryId, [who.id]);
    }
    return out;
  }
}

// ---- assembling a view ------------------------------------------------------------

/** Merge tiles' line features into one feature per pass bucket (ascending). */
export function mergeLineBuckets(
  parts: readonly FeatureCollection<MultiLineString, HeatLineProps>[],
): FeatureCollection<MultiLineString, HeatLineProps> {
  const byBucket = new Map<number, number[][][]>();
  for (const fc of parts) {
    for (const f of fc.features) {
      const list = byBucket.get(f.properties.count);
      if (list) for (const l of f.geometry.coordinates) list.push(l);
      else byBucket.set(f.properties.count, [...f.geometry.coordinates]);
    }
  }
  const features: Feature<MultiLineString, HeatLineProps>[] = [...byBucket.keys()]
    .sort((a, b) => a - b)
    .map((count) => ({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: byBucket.get(count) as number[][][] },
      properties: { count },
    }));
  return { type: 'FeatureCollection', features };
}

/** Concatenate tiles' glow points. */
export function mergeGlow(
  parts: readonly FeatureCollection<Point, HeatGlowProps>[],
): FeatureCollection<Point, HeatGlowProps> {
  const features: Feature<Point, HeatGlowProps>[] = [];
  for (const fc of parts) for (const f of fc.features) features.push(f);
  return { type: 'FeatureCollection', features };
}
