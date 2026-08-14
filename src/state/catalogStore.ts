import { shardIdsForQuery, type CatalogSearchDigest } from '@core/catalog/searchDigest';
import type {
  CatalogCategory,
  CatalogIndex,
  CatalogItem,
  CatalogShardRef,
} from '@core/catalog/schema';
import { selectShards } from '@core/catalog/shard';
import type { LatLng } from '@core/models';
import { loadCatalogManifest, loadCatalogSearchDigest, loadCatalogShard } from '@data/catalogCache';
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
 * Sharding costs the Search tab its reach, so `ensureShardsForQuery()` buys it
 * back: it consults the published search digest to learn which shards *could*
 * match a query anywhere in the world and pulls those, and it reports how much
 * of the catalog the answer actually covers (`searchScope`) so the screen can
 * distinguish "nothing exists" from "still looking" from "only your area".
 *
 * Lives in a store (not screen state) so an in-flight download keeps its
 * progress bar when the user hops to another tab and back. The download
 * orchestration itself is `@features/store/downloadCatalogItem`; it drives
 * `setDownloadProgress`/`clearDownload` here.
 */

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * How completely the current query has been answered — what the empty state is
 * allowed to claim.
 *
 * - `complete`: every shard that could match is loaded (or the catalog is
 *   inline). Zero results genuinely means "the catalog has none".
 * - `partial`: matching shards remain unfetched — more results are coming, so
 *   "no maps match" would be a lie.
 * - `area-only`: no digest (never published, or unreachable offline), so the
 *   query only ever saw the shards loaded for the user's area.
 */
export type SearchScope = 'complete' | 'partial' | 'area-only';

/** How many shards one screen-load may pull, and their combined byte budget. */
const SHARD_FETCH_LIMIT = 6;
const SHARD_BYTE_BUDGET = 1_500_000;

/**
 * How long a shard that failed to load is left out of the running.
 *
 * Without this, a shard the CDN hasn't published yet (partial deploy, cache
 * lag) is re-picked nearest-first on every single call: it is never added to
 * `loadedShardIds`, so `selectShards` keeps handing back the same dead id and
 * it permanently consumes one of the {@link SHARD_FETCH_LIMIT} slots — burning
 * up to a 15 s timeout each time and starving the 7th-nearest real shard.
 * Three such shards and the user simply never sees half their maps. Excluding
 * a failure for a few minutes lets the budget advance, while the cooldown
 * still lets a genuinely transient failure (a tunnel) recover in-session.
 */
const SHARD_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

interface CatalogState {
  status: CatalogStatus;
  index: CatalogIndex | null;
  /** True when the index came from the on-device cache (offline browse). */
  fromCache: boolean;
  /** Every item loaded so far: the index's inline items plus fetched shards. */
  items: CatalogItem[];
  /** Shard ids already merged into `items`. */
  loadedShardIds: string[];
  /** Shard id → when its load last failed, so a dead shard stops being picked. */
  shardFailures: Record<string, number>;
  /** True while any shard fetch is in flight (drives the list's spinner). */
  loadingShards: boolean;
  /** The search digest, once a query has made it worth fetching. */
  searchDigest: CatalogSearchDigest | null;
  /** True once a digest fetch has been attempted (successfully or not). */
  searchDigestTried: boolean;
  /** True while the digest is being fetched (first keystroke only). */
  loadingSearch: boolean;
  /** How much of the catalog the last `ensureShardsForQuery` actually covered. */
  searchScope: SearchScope;
  /** Matching shards still unfetched for the current query. */
  pendingQueryShardIds: string[];
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
  /**
   * Fetch the shards that could answer `query`, nearest to `origin` first.
   * Consults the search digest (fetching it once, lazily) so a query reaches
   * the whole catalog, not just the area already loaded. Call again to pull the
   * next batch while `pendingQueryShardIds` is non-empty.
   */
  ensureShardsForQuery: (query: string, origin: LatLng | null) => Promise<void>;
  /**
   * The explicit "search the whole catalog" affordance: retry a digest that
   * failed (offline first time) and pull the next batch of matching shards.
   */
  searchWholeCatalog: (query: string, origin: LatLng | null) => Promise<void>;
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

/** Is a recorded failure still inside its cooldown? */
function isCoolingDown(failedAt: number | undefined): boolean {
  return failedAt !== undefined && Date.now() - failedAt < SHARD_FAILURE_COOLDOWN_MS;
}

type SetState = (
  partial: Partial<CatalogState> | ((s: CatalogState) => Partial<CatalogState>),
) => void;
type GetState = () => CatalogState;

/**
 * The shards worth offering to `selectShards`: not already merged, not in
 * flight, and not a known-dead id still inside its cooldown.
 */
function selectableShards(state: CatalogState): CatalogShardRef[] {
  if (state.index === null) return [];
  const loaded = new Set(state.loadedShardIds);
  return state.index.shards.filter(
    (shard) =>
      !loaded.has(shard.id) &&
      !inFlight.has(shard.id) &&
      !isCoolingDown(state.shardFailures[shard.id]),
  );
}

/**
 * Fetch a chosen set of shards and merge what came back. A shard that fails is
 * recorded (see {@link SHARD_FAILURE_COOLDOWN_MS}) so the next selection moves
 * past it; a shard that succeeds clears any earlier failure.
 */
async function fetchShards(
  set: SetState,
  get: GetState,
  wanted: readonly CatalogShardRef[],
): Promise<void> {
  if (wanted.length === 0) return;
  const index = get().index;
  if (index === null) return;

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
      const failures = { ...s.shardFailures };
      const now = Date.now();
      for (const { shard, result } of results) {
        if (result === null) {
          failures[shard.id] = now;
          continue;
        }
        delete failures[shard.id];
        items = mergeItems(items, result.items);
        if (!ids.includes(shard.id)) ids.push(shard.id);
      }
      return { items, loadedShardIds: ids, shardFailures: failures };
    });
  } finally {
    for (const shard of wanted) inFlight.delete(shard.id);
    set({ loadingShards: inFlight.size > 0 });
  }
}

/**
 * The search digest, fetched at most once per session-with-an-index. A failed
 * fetch is remembered (`searchDigestTried`) so every keystroke does not retry a
 * few hundred KB on a dead connection; `load(force)` resets it.
 */
async function ensureSearchDigest(
  set: SetState,
  get: GetState,
): Promise<CatalogSearchDigest | null> {
  const state = get();
  if (state.searchDigest !== null) return state.searchDigest;
  const ref = state.index?.search;
  if (ref === undefined || state.searchDigestTried) return null;

  set({ loadingSearch: true });
  try {
    const result = await loadCatalogSearchDigest(ref);
    set({ searchDigest: result?.digest ?? null, searchDigestTried: true });
    return result?.digest ?? null;
  } finally {
    set({ loadingSearch: false });
  }
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  status: 'idle',
  index: null,
  fromCache: false,
  items: [],
  loadedShardIds: [],
  shardFailures: {},
  loadingShards: false,
  searchDigest: null,
  searchDigestTried: false,
  loadingSearch: false,
  searchScope: 'area-only',
  pendingQueryShardIds: [],
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
      // A shard missing an hour ago may exist in the refreshed directory.
      shardFailures: {},
      pendingQueryShardIds: [],
      searchScope: 'area-only',
    });
  },

  ensureShardsNear: async (origin, category) => {
    const { index } = get();
    if (index === null || index.shards.length === 0) return;
    const wanted = selectShards(selectableShards(get()), origin, {
      category,
      limit: SHARD_FETCH_LIMIT,
      byteBudget: SHARD_BYTE_BUDGET,
    });
    await fetchShards(set, get, wanted);
  },

  ensureShardsForQuery: async (query, origin) => {
    const { index } = get();
    if (index === null) return;
    // A catalog with no shard directory is entirely inline: the item filter
    // already searches all of it, so the answer is complete by construction.
    if (index.shards.length === 0) {
      set({ searchScope: 'complete', pendingQueryShardIds: [] });
      return;
    }

    const digest = await ensureSearchDigest(set, get);
    if (digest === null) {
      // No digest: honest about only having searched the loaded area.
      set({ searchScope: 'area-only', pendingQueryShardIds: [] });
      return;
    }

    const candidateIds = shardIdsForQuery(digest, query);
    if (candidateIds === null) {
      // Too short to constrain anything — say nothing about completeness.
      set({ searchScope: 'area-only', pendingQueryShardIds: [] });
      return;
    }

    const loaded = new Set(get().loadedShardIds);
    const outstanding = candidateIds.filter((id) => !loaded.has(id));
    if (outstanding.length === 0) {
      set({ searchScope: 'complete', pendingQueryShardIds: [] });
      return;
    }

    const candidates = new Set(outstanding);
    const wanted = selectShards(
      selectableShards(get()).filter((shard) => candidates.has(shard.id)),
      origin,
      { category: null, limit: SHARD_FETCH_LIMIT, byteBudget: SHARD_BYTE_BUDGET },
    );
    await fetchShards(set, get, wanted);

    const nowLoaded = new Set(get().loadedShardIds);
    const failed = get().shardFailures;
    // A shard that failed is not "still coming": leaving it pending would keep
    // the screen saying "searching" forever. It is excluded from the remaining
    // work, and the scope stays partial only while real shards are left.
    const remaining = candidateIds.filter((id) => !nowLoaded.has(id) && !isCoolingDown(failed[id]));
    set({
      pendingQueryShardIds: remaining,
      searchScope: remaining.length === 0 ? 'complete' : 'partial',
    });
  },

  searchWholeCatalog: async (query, origin) => {
    // Let a digest that failed while offline be tried again — this is the
    // user explicitly asking, not a keystroke.
    if (get().searchDigest === null) set({ searchDigestTried: false });
    await get().ensureShardsForQuery(query, origin);
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
