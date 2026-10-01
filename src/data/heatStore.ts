import {
  decodeTileGrid,
  decodeTileRender,
  emptyManifest,
  encodeTileGrid,
  encodeTileRender,
  hashText,
  parseManifest,
  serializeManifest,
  type HeatManifest,
} from '@core/heat/heatCodec';
import { CellGrid, HEAT_LINE_CELL_M, walkTrackCells } from '@core/heat/heatGrid';
import {
  DEFAULT_FLUSH_POLICY,
  diffHeat,
  flushDue,
  flushWaitMs,
  type FlushPolicy,
} from '@core/heat/heatSync';
import {
  aggregateTile,
  deriveTileRender,
  HEAT_TILE_DEG,
  mergeAggregates,
  neighbourTiles,
  renderDirtyTiles,
  TileGrid,
  TileMapper,
  tileTap,
  trackContributions,
  type TileAggregate,
  type TileKey,
  type TileRender,
  type TileTap,
} from '@core/heat/heatTiles';
import type { TrackGeometry } from '@core/geo/track/simplify';
import type { TrackSummary } from '@core/models';

import { createHeatFileIO, type HeatStoreIO } from './heatStoreFiles';
import { readTrackGeometryOnce, trackGeometryKey } from './trackGeometry';

/**
 * The stored personal heatmap (#500): computed once, in the background, and
 * kept up to date trail by trail.
 *
 * Files (see `@data/heatStoreFiles` for where):
 * - `manifest.json` — version, grid parameters, every stored trail
 *   (slot, revision hash, tiles) and every tile's revision. Written LAST in
 *   every batch, through a staged file.
 * - `g_<tile>.bin` — the tile's grid: each trail's cells/offsets/steps in it.
 * - `r_<tile>.json` — the tile's render pieces (pass-count lines + glow),
 *   stamped with the tile revision they were derived at.
 *
 * Work: {@link HeatStore.sync} takes the trails that should be in the heat;
 * a single background loop diffs them against the manifest, takes out trails
 * that went away or changed (touching only their tiles), walks new ones
 * (their geometry: in memory after an import, else the geometry cache), and
 * writes a batch per {@link FlushPolicy} — never once per trail of a big
 * import. A missing, corrupt or older-version store is cleared and refilled
 * by the same loop, visible trails first, a batch at a time; stopping it
 * (heat off, app closed) loses at most the unwritten batch.
 *
 * Crash safety: a tile file only counts for the slots the manifest places in
 * that tile, so a batch written without its manifest is ignored (and its
 * trails redone); a render whose revision disagrees with the manifest is
 * re-derived on first read.
 */

const MANIFEST = 'manifest.json';
const gridFile = (k: TileKey) => `g_${k}.bin`;
const renderFile = (k: TileKey) => `r_${k}.json`;

/** Most tiles kept decoded for reading (render pieces / tap tables). */
const RENDER_CACHE_TILES = 256;
const TAP_CACHE_TILES = 96;

class CorruptStore extends Error {}

type Work = { op: 'add'; track: TrackSummary } | { op: 'remove' };

export interface HeatStoreClock {
  now(): number;
  /** Resolve after `ms` (the loop's wait for a debounced batch). */
  sleep(ms: number): Promise<void>;
  /** Give the UI a turn between trails. */
  yieldToUi(): Promise<void>;
}

const realClock: HeatStoreClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  yieldToUi: () => new Promise((r) => setTimeout(r, 0)),
};

export interface HeatStoreOptions {
  io: HeatStoreIO;
  /** A trail's simplified geometry (null: nothing drawable). */
  loadGeometry?: (t: TrackSummary) => Promise<TrackGeometry | null>;
  policy?: FlushPolicy;
  clock?: HeatStoreClock;
}

/** What the store is doing, for progress display and tests. */
export interface HeatStoreStatus {
  /** A full (re)build is in progress. */
  rebuilding: boolean;
  /** Trails waiting to be added or taken out. */
  queued: number;
  /** Trails stored (written). */
  stored: number;
}

export class HeatStore {
  readonly grid = new CellGrid(HEAT_LINE_CELL_M);
  private readonly io: HeatStoreIO;
  private readonly loadGeometry: (t: TrackSummary) => Promise<TrackGeometry | null>;
  private readonly policy: FlushPolicy;
  private readonly clock: HeatStoreClock;

  // ---- written state (what readers see) ----
  private persistedTiles = new Map<TileKey, number>();
  private persistedSlots = new Map<number, string>();
  private persistedTileSlots = new Map<TileKey, Set<number>>();
  private stampValue = 0;
  private readonly listeners = new Set<() => void>();
  private readonly renderCache = new Map<TileKey, { rev: number; render: TileRender }>();
  private readonly tapCache = new Map<TileKey, { rev: number; tap: TileTap }>();

  // ---- working state (the loop's) ----
  private manifest: HeatManifest | null = null;
  private tileSlots = new Map<TileKey, Set<number>>();
  private working = new Map<TileKey, TileGrid>();
  private changedCells = new Set<number>();
  private gridDirty = new Set<TileKey>();
  private repairs = new Set<TileKey>();
  private pending = 0;
  private firstPendingAt = 0;
  private lastFlushMs = 0;
  private rebuilding = false;
  private wanted: TrackSummary[] | null = null;
  private wantedChanged = false;
  private queue = new Map<string, Work>();
  private running: Promise<void> | null = null;
  private stopRequested = false;
  private flushing = false;
  private wake: (() => void) | null = null;
  /** Counters (tests and the bench). */
  readonly stats = { flushes: 0, geometryLoads: 0, rebuilds: 0, filesRead: 0, filesWritten: 0 };

  constructor(options: HeatStoreOptions) {
    this.io = options.io;
    this.loadGeometry = options.loadGeometry ?? readTrackGeometryOnce;
    this.policy = options.policy ?? DEFAULT_FLUSH_POLICY;
    this.clock = options.clock ?? realClock;
  }

  // ---- reading ------------------------------------------------------------------

  /** Changes whenever a batch is written (or the store opens). */
  get stamp(): number {
    return this.stampValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Written tiles → revision. */
  storedTiles(): ReadonlyMap<TileKey, number> {
    return this.persistedTiles;
  }

  /** The trail stored under `slot` (as written), if any. */
  slotTrack(slot: number): string | undefined {
    return this.persistedSlots.get(slot);
  }

  status(): HeatStoreStatus {
    return {
      rebuilding: this.rebuilding,
      queued: this.queue.size + (this.wantedChanged ? 1 : 0),
      stored: this.persistedSlots.size,
    };
  }

  /** A tile's render pieces at its current revision (null: none, or being repaired). */
  async readRender(key: TileKey): Promise<TileRender | null> {
    const rev = this.persistedTiles.get(key);
    if (rev === undefined) return null;
    const hit = this.renderCache.get(key);
    if (hit && hit.rev === rev) return touch(this.renderCache, key, hit).render;
    this.stats.filesRead++;
    const text = await this.io.readText(renderFile(key)).catch(() => null);
    const decoded = text === null ? null : decodeTileRender(text);
    if (decoded && decoded.rev > rev && this.flushing) {
      // A batch is being written: this is its newer piece, shown (not cached).
      return decoded.render;
    }
    if (!decoded || decoded.rev !== rev) {
      // Torn or stale (a crash between a tile and its manifest): redo it.
      if (!this.flushing && this.persistedTiles.get(key) === rev) this.requestRepair(key);
      return null;
    }
    if (this.persistedTiles.get(key) === rev) {
      put(this.renderCache, key, { rev, render: decoded.render }, RENDER_CACHE_TILES);
    }
    return decoded.render;
  }

  /** A tile's cell → slots table at its current revision (for taps). */
  async readTap(key: TileKey): Promise<TileTap | null> {
    const rev = this.persistedTiles.get(key);
    if (rev === undefined) return null;
    const hit = this.tapCache.get(key);
    if (hit && hit.rev === rev) return touch(this.tapCache, key, hit).tap;
    this.stats.filesRead++;
    const bytes = await this.io.readBytes(gridFile(key)).catch(() => null);
    const decoded = bytes ? decodeTileGrid(bytes) : null;
    if (!decoded) return null;
    filterSlots(decoded.tile, this.persistedTileSlots.get(key));
    const tap = tileTap(decoded.tile);
    if (this.persistedTiles.get(key) === rev)
      put(this.tapCache, key, { rev, tap }, TAP_CACHE_TILES);
    return tap;
  }

  // ---- writing --------------------------------------------------------------------

  /**
   * Make the store hold exactly `tracks` (the trails the heat counts, the
   * ones to do first first). Returns at once; the work runs in the
   * background (see {@link whenIdle}).
   */
  sync(tracks: readonly TrackSummary[]): void {
    this.wanted = [...tracks];
    this.wantedChanged = true;
    this.stopRequested = false;
    this.kick();
  }

  /** Open the store (read its manifest) without changing it. */
  open(): Promise<void> {
    this.kick();
    return this.whenIdle();
  }

  /** Stop after the current trail, writing what was done. {@link sync} resumes. */
  pause(): Promise<void> {
    this.stopRequested = true;
    this.wake?.();
    return this.whenIdle();
  }

  /** Resolves when the background loop has nothing left to do (or paused). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private kick(): void {
    this.wake?.();
    if (this.running) return;
    this.running = this.run().finally(() => {
      this.running = null;
    });
  }

  private emit(): void {
    this.stampValue++;
    for (const l of [...this.listeners]) l();
  }

  private requestRepair(key: TileKey): void {
    this.repairs.add(key);
    this.kick();
  }

  // ---- the loop ----------------------------------------------------------------------

  private async run(): Promise<void> {
    for (let resets = 0; ; resets++) {
      try {
        await this.loop();
        return;
      } catch (e) {
        this.flushing = false;
        if (e instanceof CorruptStore && resets < 2) {
          await this.reset().catch(() => undefined);
          continue;
        }
        // Anything else (a full disk…): drop the unwritten batch and stop;
        // the next sync reopens the store from what was written.
        this.manifest = null;
        this.working = new Map();
        this.changedCells = new Set();
        this.gridDirty = new Set();
        this.repairs = new Set();
        this.pending = 0;
        this.wantedChanged = this.wanted !== null;
        return;
      }
    }
  }

  private async loop(): Promise<void> {
    if (!this.manifest) await this.openManifest();
    for (;;) {
      const item = this.stopRequested ? undefined : this.next();
      if (item) {
        await this.apply(item[0], item[1]);
        await this.clock.yieldToUi();
      }
      const state = {
        pending: this.pending,
        sinceFirstMs: this.pending > 0 ? this.clock.now() - this.firstPendingAt : 0,
        lastFlushMs: this.lastFlushMs,
      };
      const idle = !item;
      if (
        flushDue(state, this.policy) ||
        (idle && (this.stopRequested || this.pending === 0) && this.hasUnwritten())
      ) {
        await this.flush();
        continue;
      }
      if (!idle) continue;
      if (!this.hasUnwritten() || this.stopRequested) break;
      await this.sleepOrWake(flushWaitMs(state, this.policy));
    }
    if (this.queue.size === 0 && !this.wantedChanged) this.rebuilding = false;
    // Idle: free the decoded grids (the next change reloads what it touches).
    this.working = new Map();
  }

  private hasUnwritten(): boolean {
    return this.pending > 0 || this.repairs.size > 0;
  }

  private sleepOrWake(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.wake = null;
        resolve();
      };
      this.wake = finish;
      if (Number.isFinite(ms)) void this.clock.sleep(ms).then(finish);
    });
  }

  /** The next piece of work, re-diffing against the manifest after a sync. */
  private next(): [string, Work] | undefined {
    const m = this.manifest;
    if (!m) return undefined;
    if (this.wantedChanged && this.wanted) {
      this.wantedChanged = false;
      const wanted = new Map<string, string>();
      const byId = new Map<string, TrackSummary>();
      for (const t of this.wanted) {
        wanted.set(t.id, hashText(trackGeometryKey(t)));
        byId.set(t.id, t);
      }
      const { remove, add } = diffHeat(m.tracks, wanted);
      this.queue = new Map();
      for (const id of remove) if (!wanted.has(id)) this.queue.set(id, { op: 'remove' });
      for (const id of add) this.queue.set(id, { op: 'add', track: byId.get(id) as TrackSummary });
    }
    const first = this.queue.entries().next();
    if (first.done) return undefined;
    this.queue.delete(first.value[0]);
    return first.value;
  }

  private async openManifest(): Promise<void> {
    let text: string | null = null;
    try {
      text = await this.io.readText(MANIFEST);
      this.stats.filesRead++;
    } catch {
      text = null;
    }
    const m = parseManifest(text, this.grid.cellM, HEAT_TILE_DEG);
    if (!m) {
      await this.reset();
      return;
    }
    this.manifest = m;
    this.tileSlots = slotsByTile(m);
    this.snapshot();
    this.emit();
  }

  /** Start over: an empty store of the current version (a full rebuild follows). */
  private async reset(): Promise<void> {
    this.stats.rebuilds++;
    try {
      this.io.clear();
    } catch {
      // Best effort: the empty manifest below disowns any leftover tile.
    }
    const m = emptyManifest(this.grid.cellM, HEAT_TILE_DEG);
    this.manifest = m;
    this.tileSlots = new Map();
    this.working = new Map();
    this.changedCells = new Set();
    this.gridDirty = new Set();
    this.repairs = new Set();
    this.pending = 0;
    this.rebuilding = true;
    this.wantedChanged = this.wanted !== null;
    this.renderCache.clear();
    this.tapCache.clear();
    this.writeManifest(m);
    this.snapshot();
    this.emit();
  }

  private writeManifest(m: HeatManifest): void {
    this.io.writeText(MANIFEST, serializeManifest(m), true);
    this.stats.filesWritten++;
  }

  /** Publish the written manifest to readers. */
  private snapshot(): void {
    const m = this.manifest;
    if (!m) return;
    this.persistedTiles = new Map(m.tiles);
    this.persistedSlots = new Map([...m.tracks].map(([id, t]) => [t.slot, id]));
    this.persistedTileSlots = slotsByTile(m);
  }

  /** A tile's grid in the working set (loaded and filtered on first use). */
  private async workingTile(key: TileKey): Promise<TileGrid> {
    let tile = this.working.get(key);
    if (tile) return tile;
    const m = this.manifest as HeatManifest;
    if (m.tiles.has(key)) {
      const bytes = await this.io.readBytes(gridFile(key)).catch(() => null);
      this.stats.filesRead++;
      const decoded = bytes ? decodeTileGrid(bytes) : null;
      if (!decoded) throw new CorruptStore(`heat tile ${key}`);
      tile = decoded.tile;
      const allowed = this.tileSlots.get(key);
      // The manifest counts a trail here that the file lost (a crash mid-batch).
      for (const slot of allowed ?? []) {
        if (!tile.slots.has(slot)) throw new CorruptStore(`heat tile ${key} lost slot ${slot}`);
      }
      filterSlots(tile, allowed);
    } else tile = new TileGrid();
    this.working.set(key, tile);
    return tile;
  }

  private markPending(): void {
    if (this.pending === 0) this.firstPendingAt = this.clock.now();
    this.pending++;
  }

  private async apply(id: string, work: Work): Promise<void> {
    const m = this.manifest as HeatManifest;
    if (work.op === 'remove') {
      await this.removeTrack(id);
      return;
    }
    const t = work.track;
    const hash = hashText(trackGeometryKey(t));
    const current = m.tracks.get(id);
    if (current?.hash === hash) return;
    if (current) await this.removeTrack(id);
    this.stats.geometryLoads++;
    const g = await this.loadGeometry(t).catch(() => null);
    const mapper = new TileMapper(this.grid);
    const contributions = g
      ? trackContributions(walkTrackCells({ id, parts: g.parts }, this.grid), mapper)
      : new Map();
    // Loads first (a load filters by the tile's slots as they were).
    for (const key of contributions.keys()) await this.workingTile(key);
    // Re-check: a sync may have raced the geometry load.
    if (m.tracks.has(id)) return;
    const slot = m.nextSlot++;
    for (const [key, c] of contributions) {
      (this.working.get(key) as TileGrid).slots.set(slot, c);
      addSlot(this.tileSlots, key, slot);
      this.gridDirty.add(key);
      for (const cell of c.cells) this.changedCells.add(cell);
    }
    m.tracks.set(id, { slot, hash, tiles: [...contributions.keys()] });
    this.markPending();
  }

  private async removeTrack(id: string): Promise<void> {
    const m = this.manifest as HeatManifest;
    const current = m.tracks.get(id);
    if (!current) return;
    for (const key of current.tiles) await this.workingTile(key);
    if (m.tracks.get(id) !== current) return;
    for (const key of current.tiles) {
      const tile = this.working.get(key) as TileGrid;
      const c = tile.slots.get(current.slot);
      if (c) for (const cell of c.cells) this.changedCells.add(cell);
      tile.slots.delete(current.slot);
      this.tileSlots.get(key)?.delete(current.slot);
      this.gridDirty.add(key);
    }
    m.tracks.delete(id);
    this.markPending();
  }

  /** Write the batch: changed grids, re-derived renders, then the manifest. */
  private async flush(): Promise<void> {
    const m = this.manifest as HeatManifest;
    const t0 = this.clock.now();
    this.flushing = true;
    const mapper = new TileMapper(this.grid);
    const exists = (k: TileKey) => {
      const w = this.working.get(k);
      return w ? w.slots.size > 0 : m.tiles.has(k);
    };
    // Renders to redo: every tile within reach of a change, plus repairs.
    const renders = renderDirtyTiles(this.changedCells, mapper);
    for (const k of this.repairs) renders.add(k);
    for (const k of this.gridDirty) renders.add(k);
    const targets = [...renders].filter(exists);
    // Their neighbourhoods, aggregated once.
    const aggregates = new Map<TileKey, TileAggregate>();
    for (const k of targets) {
      for (const n of [k, ...neighbourTiles(k)]) {
        if (aggregates.has(n) || !exists(n)) continue;
        aggregates.set(n, aggregateTile(await this.workingTile(n), this.grid));
        await this.clock.yieldToUi();
      }
    }
    const merged = mergeAggregates(this.grid, aggregates.values());
    const bumped = new Map<TileKey, number>();
    const revOf = (k: TileKey) => {
      let rev = bumped.get(k);
      if (rev === undefined) {
        rev = (m.tiles.get(k) ?? 0) + 1;
        m.tiles.set(k, rev);
        bumped.set(k, rev);
      }
      return rev;
    };
    for (const k of this.gridDirty) {
      const tile = this.working.get(k);
      if (!tile) continue;
      if (tile.slots.size === 0) {
        m.tiles.delete(k);
        this.working.delete(k);
        this.io.remove(gridFile(k));
        this.io.remove(renderFile(k));
        continue;
      }
      this.io.writeBytes(gridFile(k), encodeTileGrid(tile, revOf(k)));
      this.stats.filesWritten++;
    }
    for (const k of targets) {
      const agg = aggregates.get(k);
      const render = agg ? deriveTileRender(merged, agg) : null;
      if (!render || !m.tiles.has(k)) continue;
      this.io.writeText(renderFile(k), encodeTileRender(render, revOf(k)));
      this.stats.filesWritten++;
      await this.clock.yieldToUi();
    }
    this.writeManifest(m);
    this.stats.flushes++;
    this.snapshot();
    this.flushing = false;
    this.changedCells = new Set();
    this.gridDirty = new Set();
    this.repairs = new Set();
    this.pending = 0;
    this.lastFlushMs = this.clock.now() - t0;
    this.emit();
  }
}

function slotsByTile(m: HeatManifest): Map<TileKey, Set<number>> {
  const out = new Map<TileKey, Set<number>>();
  for (const t of m.tracks.values()) for (const k of t.tiles) addSlot(out, k, t.slot);
  return out;
}

function addSlot(map: Map<TileKey, Set<number>>, key: TileKey, slot: number): void {
  const set = map.get(key);
  if (set) set.add(slot);
  else map.set(key, new Set([slot]));
}

/** Keep only the slots the manifest places in this tile (crash leftovers go). */
function filterSlots(tile: TileGrid, allowed: ReadonlySet<number> | undefined): void {
  for (const slot of [...tile.slots.keys()]) {
    if (!allowed?.has(slot)) tile.slots.delete(slot);
  }
}

function touch<V>(cache: Map<TileKey, V>, key: TileKey, value: V): V {
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function put<V>(cache: Map<TileKey, V>, key: TileKey, value: V, max: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

let shared: HeatStore | null = null;

/** The app's heat store (file-backed, under the cache directory). */
export function getHeatStore(): HeatStore {
  shared ??= new HeatStore({ io: createHeatFileIO() });
  return shared;
}

/** Test hook: replace (or drop, with null) the shared store. */
export function setHeatStoreForTests(store: HeatStore | null): void {
  shared = store;
}
