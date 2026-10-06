import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { filterCatalogItems } from '@core/catalog/filterCatalog';
import { nearbyCatalogItems, type NearbyCatalogItem } from '@core/catalog/nearby';
import {
  parseCatalogIndex,
  parseCatalogShard,
  type CatalogCategory,
  type CatalogIndex,
  type CatalogItem,
} from '@core/catalog/schema';
import {
  parseCatalogSearchDigest,
  shardIdsForQuery,
  type CatalogSearchDigest,
} from '@core/catalog/searchDigest';
import { rankShardsByDistance, resolveCatalogUrl, selectShards } from '@core/catalog/shard';
import type { LatLng } from '@core/models';

/** The live, static, no-auth catalog the phone reads. */
export const CATALOG_INDEX_URL = 'https://inukshuk.mvxtechnologies.com/catalog/v2/index.json';

/** Shards to pull for the "around here" section. */
const NEARBY_SHARD_LIMIT = 6;
/** ...and the byte ceiling on that pull, so a dense area stays cheap. */
const NEARBY_BYTE_BUDGET = 400_000;
/** Shards to pull for a search hit list. The digest narrows to the right
 *  cells; this caps what a very common word ("lake") can cost. */
const SEARCH_SHARD_LIMIT = 8;

export interface CatalogState {
  index: CatalogIndex | null;
  warnings: string[];
  error: string | null;
  loading: boolean;
  /** Items nearest the current map centre, by category, from `@core/catalog`. */
  nearby: NearbyCatalogItem[];
  nearbyLoading: boolean;
  /** Search hits, or null when the query is too short to constrain anything. */
  results: CatalogItem[] | null;
  searching: boolean;
  /** True when the digest says "no shard in the whole catalog holds this". */
  searchExhausted: boolean;
  category: CatalogCategory | null;
  setCategory: (c: CatalogCategory | null) => void;
  query: string;
  setQuery: (q: string) => void;
}

/**
 * The catalog browser's data layer.
 *
 * Every decision that matters is `@core/catalog`'s, unchanged:
 *  - `parseCatalogIndex` / `parseCatalogShard` validate and drop junk (and the
 *    warnings they return are surfaced, not swallowed);
 *  - `selectShards` picks which shards are worth fetching — nearest-first,
 *    round-robin across categories so the 30 000 US topo quads cannot crowd
 *    everything else out, capped by count AND bytes;
 *  - `resolveCatalogUrl` turns a shard's relative path into a URL, and refuses
 *    anything that is not a plain relative path;
 *  - `nearbyCatalogItems` does the per-category "around you" pick;
 *  - `shardIdsForQuery` narrows a search to the shards that can hold a match,
 *    and `filterCatalogItems` does the actual matching.
 *
 * The browser only supplies fetch and a cache. That is the point.
 */
export function useCatalog(origin: LatLng | null): CatalogState {
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [category, setCategory] = useState<CatalogCategory | null>(null);
  const [query, setQuery] = useState('');

  const [nearby, setNearby] = useState<NearbyCatalogItem[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [results, setResults] = useState<CatalogItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchExhausted, setSearchExhausted] = useState(false);

  // shard id -> parsed items. A shard is immutable for a given catalog build,
  // so this never needs invalidating within a session.
  const shardCache = useRef(new Map<string, CatalogItem[]>());
  const digestRef = useRef<CatalogSearchDigest | null>(null);

  // ---------------------------------------------------------------- index --
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(CATALOG_INDEX_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseCatalogIndex(await res.json());
        if (parsed.index === null) {
          setError(parsed.warnings[0] ?? 'catalog index could not be parsed');
        } else {
          setIndex(parsed.index);
        }
        setWarnings(parsed.warnings);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'catalog unreachable');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const fetchShard = useCallback(
    async (id: string, path: string, sourceIds: ReadonlySet<string>, signal: AbortSignal) => {
      const hit = shardCache.current.get(id);
      if (hit !== undefined) return hit;
      const url = resolveCatalogUrl(CATALOG_INDEX_URL, path);
      if (url === null) return [];
      const res = await fetch(url, { signal });
      if (!res.ok) return [];
      const { items } = parseCatalogShard(await res.json(), sourceIds);
      shardCache.current.set(id, items);
      return items;
    },
    [],
  );

  const sourceIds = useMemo(() => new Set((index?.sources ?? []).map((s) => s.id)), [index]);

  // --------------------------------------------------------------- nearby --
  // Keyed on a COARSE origin: the section must not refetch on every pixel of
  // pan. ~0.25° is well inside the shard grid, so the selection is stable.
  const originKey =
    origin === null
      ? null
      : `${(Math.round(origin.latitude * 4) / 4).toFixed(2)},${(
          Math.round(origin.longitude * 4) / 4
        ).toFixed(2)}`;

  useEffect(() => {
    if (index === null || origin === null || originKey === null) return;
    const controller = new AbortController();
    // Not a cascading render: this flag is the React-side mirror of a network
    // request that is about to start, which is precisely the external-system
    // synchronisation effects exist for. Deriving it is impossible — nothing in
    // props or state knows a fetch is in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNearbyLoading(true);
    void (async () => {
      try {
        const picked = selectShards(index.shards, origin, {
          category,
          limit: NEARBY_SHARD_LIMIT,
          byteBudget: NEARBY_BYTE_BUDGET,
        });
        const lists = await Promise.all(
          picked.map((s) => fetchShard(s.id, s.path, sourceIds, controller.signal).catch(() => [])),
        );
        if (controller.signal.aborted) return;
        const items = [...index.items, ...lists.flat()];
        const scoped = category === null ? items : items.filter((i) => i.category === category);
        setNearby(nearbyCatalogItems(scoped, origin, { limit: 12 }));
      } finally {
        if (!controller.signal.aborted) setNearbyLoading(false);
      }
    })();
    return () => controller.abort();
    // `origin` itself is intentionally not a dep — `originKey` is its coarse,
    // stable form and re-running on raw coordinates would refetch per pixel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, originKey, category, sourceIds, fetchShard]);

  // --------------------------------------------------------------- search --
  const trimmedQuery = query.trim();
  useEffect(() => {
    const trimmed = trimmedQuery;
    if (index === null || trimmed === '') return;
    const controller = new AbortController();
    // Debounce: the digest fetch is ~440 KB once, but each keystroke would
    // otherwise re-run the shard pull behind it.
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true);
        setSearchExhausted(false);
        try {
          // The digest is fetched lazily and once — a client that never
          // searches never pays for it, which is why the index only points
          // at it rather than inlining it.
          if (digestRef.current === null && index.search !== undefined) {
            const url = resolveCatalogUrl(CATALOG_INDEX_URL, index.search.path);
            if (url !== null) {
              const res = await fetch(url, { signal: controller.signal });
              if (res.ok) {
                digestRef.current = parseCatalogSearchDigest(await res.json()).digest;
              }
            }
          }
          const digest = digestRef.current;
          // No digest published: we can only search what has been fetched, and
          // we must say so rather than claim "no results" (core's rule).
          const ids = digest === null ? null : shardIdsForQuery(digest, trimmed);
          if (ids !== null && ids.length === 0) {
            setResults([]);
            setSearchExhausted(true);
            return;
          }

          const candidates =
            ids === null ? index.shards : index.shards.filter((s) => ids.includes(s.id));
          const scoped =
            category === null ? candidates : candidates.filter((s) => s.category === category);
          const picked = rankShardsByDistance(scoped, origin).slice(0, SEARCH_SHARD_LIMIT);
          const lists = await Promise.all(
            picked.map((s) =>
              fetchShard(s.id, s.path, sourceIds, controller.signal).catch(() => []),
            ),
          );
          if (controller.signal.aborted) return;
          const items = [...index.items, ...lists.flat()];
          setResults(
            filterCatalogItems(items, {
              text: trimmed,
              ...(category === null ? {} : { category }),
            }).slice(0, 80),
          );
        } finally {
          if (!controller.signal.aborted) setSearching(false);
        }
      })();
    }, 260);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, trimmedQuery, category, sourceIds, fetchShard, originKey]);

  // Both sections are DERIVED at the edges rather than reset inside an effect:
  // an empty query means "no result list", full stop, and it must read that way
  // on the very same render the field is cleared — not one render later, which
  // is what a reset-in-effect would give (a flash of the previous hits).
  const visibleResults = index === null || trimmedQuery === '' ? null : results;
  const visibleNearby = index === null || origin === null ? [] : nearby;

  return {
    index,
    warnings,
    error,
    loading,
    nearby: visibleNearby,
    nearbyLoading,
    results: visibleResults,
    searching: searching && trimmedQuery !== '',
    searchExhausted: searchExhausted && trimmedQuery !== '',
    category,
    setCategory,
    query,
    setQuery,
  };
}
