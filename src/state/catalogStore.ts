import type { CatalogCategory, CatalogIndex, CatalogItem } from '@core/catalog/schema';
import { selectShards } from '@core/catalog/shard';
import type { LatLng } from '@core/models';
import { loadCatalogManifest, loadCatalogShard } from '@data/catalogCache';
import { create } from 'zustand';

/**
 * Map-store (Search tab) state: the catalog index, the shards loaded so far,
 * and per-item download progress.
 *
 * The world catalog is too big to hold in one document, so this store owns the
 * *progressive* half of the design: `load()` fetches the small index (sources,
 * per-category totals, shard directory), and `ensureShardsNear()` pulls the
 * handful of geographic shards the current screen actually needs — nearest
 * first, capped by count and bytes. Items accumulate in `items`; nothing is
 * ever evicted during a session, so backing out of a category and returning is
 * instant and works offline.
 *
 * Lives in a store (not screen state) so an in-flight download keeps its
 * progress bar when the user hops to another tab and back. The download
 * orchestration itself is `@features/store/downloadCatalogItem`; it drives
 * `setDownloadProgress`/`clearDownload` here.
 */

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

/** How many shards one screen-load may pull, and their combined byte budget. */
const SHARD_FETCH_LIMIT = 6;
const SHARD_BYTE_BUDGET = 1_500_000;

interface CatalogState {
  status: CatalogStatus;
  index: CatalogIndex | null;
  /** True when the index came from the on-device cache (offline browse). */
  fromCache: boolean;
  /** Every item loaded so far: the index's inline items plus fetched shards. */
  items: CatalogItem[];
  /** Shard ids already merged into `items`. */
  loadedShardIds: string[];
  /** True while any shard fetch is in flight (drives the list's spinner). */
  loadingShards: boolean;
  /** itemId → fraction 0..1, or null for indeterminate. */
  downloads: Record<string, number | null>;
  /** Destination folder of the last store download (pre-selected next time). */
  lastFolderId: string | null;
  /** Load (or refresh, with `force`) the index. Safe to call repeatedly. */
  load: (force?: boolean) => Promise<void>;
  /**
   * Fetch the shards nearest `origin` for `category` (all categories when
   * null), skipping any already loaded. Resolves once they have merged.
   */
  ensureShardsNear: (origin: LatLng | null, category: CatalogCategory | null) => Promise<void>;
  setDownloadProgress: (itemId: string, fraction: number | null) => void;
  clearDownload: (itemId: string) => void;
  setLastFolderId: (folderId: string | null) => void;
}

/** Shard ids currently being fetched, so two screens can't double-fetch one. */
const inFlight = new Set<string>();

/** Merge new items in, keeping the first row for any duplicated id. */
function mergeItems(existing: CatalogItem[], incoming: readonly CatalogItem[]): CatalogItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const added = incoming.filter((item) => !seen.has(item.id));
  return added.length === 0 ? existing : [...existing, ...added];
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  status: 'idle',
  index: null,
  fromCache: false,
  items: [],
  loadedShardIds: [],
  loadingShards: false,
  downloads: {},
  lastFolderId: null,

  load: async (force) => {
    if (get().status === 'loading') return;
    set({ status: 'loading' });
    const result = await loadCatalogManifest(force === true ? { force: true } : undefined);
    if (result === null) {
      // Keep any previously loaded index browsable; only flag error state
      // when there is nothing at all to show.
      set((s) => ({ status: s.index !== null ? 'ready' : 'error' }));
      return;
    }
    set({
      status: 'ready',
      index: result.index,
      fromCache: result.fromCache,
      // A refreshed index may rename shards; start from its inline items and
      // let the screens re-request what they need.
      items: result.index.items,
      loadedShardIds: [],
    });
  },

  ensureShardsNear: async (origin, category) => {
    const { index, loadedShardIds } = get();
    if (index === null || index.shards.length === 0) return;
    const loaded = new Set(loadedShardIds);
    const wanted = selectShards(
      index.shards.filter((shard) => !loaded.has(shard.id) && !inFlight.has(shard.id)),
      origin,
      { category, limit: SHARD_FETCH_LIMIT, byteBudget: SHARD_BYTE_BUDGET },
    );
    if (wanted.length === 0) return;

    const sourceIds = new Set(index.sources.map((source) => source.id));
    for (const shard of wanted) inFlight.add(shard.id);
    set({ loadingShards: true });
    try {
      const results = await Promise.all(
        wanted.map(async (shard) => ({ shard, result: await loadCatalogShard(shard, sourceIds) })),
      );
      set((s) => {
        let items = s.items;
        const ids = [...s.loadedShardIds];
        for (const { shard, result } of results) {
          if (result === null) continue;
          items = mergeItems(items, result.items);
          if (!ids.includes(shard.id)) ids.push(shard.id);
        }
        return { items, loadedShardIds: ids };
      });
    } finally {
      for (const shard of wanted) inFlight.delete(shard.id);
      set({ loadingShards: inFlight.size > 0 });
    }
  },

  setDownloadProgress: (itemId, fraction) =>
    set((s) => ({ downloads: { ...s.downloads, [itemId]: fraction } })),

  clearDownload: (itemId) =>
    set((s) => {
      const { [itemId]: _gone, ...rest } = s.downloads;
      return { downloads: rest };
    }),

  setLastFolderId: (folderId) => set({ lastFolderId: folderId }),
}));
