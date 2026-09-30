import { itemActivities, itemKind } from './classify';
import { parseFacetCounts, type CatalogItem } from './schema';
import {
  CATALOG_ACTIVITIES,
  CATALOG_KINDS,
  CATALOG_TERRAINS,
  type CatalogActivity,
  type CatalogKind,
  type CatalogTerrain,
} from './taxonomy';

/**
 * Explorer facet counts — global (carried in `index.json`) and per shard
 * (`facets.json`, a lazy side document like `search.json`).
 *
 * Why per-shard counts at all: shards are keyed by category × place, not by
 * terrain or activity, so "glacier maps near me" would otherwise mean
 * fetching every nearby shard to find out that most hold none. With this
 * digest the client fetches only shards that actually contain the facet.
 * It is a separate document because the index is fetched on every cold start
 * and must stay small; the digest is only paid for by someone who opens the
 * explorer.
 *
 * Counting rules are shared with the UI: kind is {@link itemKind} and
 * activities are {@link itemActivities} (explicit evidence, else terrain
 * affinity), so a tile's count equals what tapping it lists.
 */

export const CATALOG_FACETS_SCHEMA_VERSION = 1;

export interface FacetCounts {
  kinds: Partial<Record<CatalogKind, number>>;
  activities: Partial<Record<CatalogActivity, number>>;
  terrain: Partial<Record<CatalogTerrain, number>>;
}

export interface CatalogFacets {
  schemaVersion: typeof CATALOG_FACETS_SCHEMA_VERSION;
  /** Shard id → that shard's facet counts (empty groups omitted on the wire). */
  shards: Record<string, FacetCounts>;
}

export type FacetGroup = keyof FacetCounts;

function bump<K extends string>(counts: Partial<Record<K, number>>, key: K): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Facet counts over a list of items. */
export function countFacets(items: readonly CatalogItem[]): FacetCounts {
  const counts: FacetCounts = { kinds: {}, activities: {}, terrain: {} };
  for (const item of items) {
    bump(counts.kinds, itemKind(item));
    for (const activity of itemActivities(item)) bump(counts.activities, activity);
    for (const terrain of item.terrain ?? []) bump(counts.terrain, terrain);
  }
  return counts;
}

/** The per-shard digest for a planned catalog. */
export function buildCatalogFacets(
  shards: readonly { id: string; items: readonly CatalogItem[] }[],
): CatalogFacets {
  const out: Record<string, FacetCounts> = {};
  for (const shard of shards) out[shard.id] = countFacets(shard.items);
  return { schemaVersion: CATALOG_FACETS_SCHEMA_VERSION, shards: out };
}

/** Wire form: drop empty groups so a shard with no terrain costs nothing. */
export function serializeCatalogFacets(facets: CatalogFacets): unknown {
  const shards: Record<string, Partial<FacetCounts>> = {};
  for (const [id, counts] of Object.entries(facets.shards)) {
    const entry: Partial<FacetCounts> = {};
    if (Object.keys(counts.kinds).length > 0) entry.kinds = counts.kinds;
    if (Object.keys(counts.activities).length > 0) entry.activities = counts.activities;
    if (Object.keys(counts.terrain).length > 0) entry.terrain = counts.terrain;
    shards[id] = entry;
  }
  return { schemaVersion: facets.schemaVersion, shards };
}

export interface CatalogFacetsParseResult {
  facets: CatalogFacets | null;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse `facets.json`. Never throws; unknown facet values are ignored. */
export function parseCatalogFacets(raw: unknown): CatalogFacetsParseResult {
  if (!isRecord(raw)) return { facets: null, warnings: ['facets is not a JSON object'] };
  if (raw.schemaVersion !== CATALOG_FACETS_SCHEMA_VERSION) {
    return {
      facets: null,
      warnings: [`unsupported facets schemaVersion ${String(raw.schemaVersion)}`],
    };
  }
  if (!isRecord(raw.shards)) return { facets: null, warnings: ['facets has no shards object'] };
  const warnings: string[] = [];
  const shards: Record<string, FacetCounts> = {};
  for (const [id, entry] of Object.entries(raw.shards)) {
    if (!isRecord(entry)) {
      warnings.push(`dropped facets for shard "${id}"`);
      continue;
    }
    shards[id] = {
      kinds: parseFacetCounts(entry.kinds, CATALOG_KINDS) ?? {},
      activities: parseFacetCounts(entry.activities, CATALOG_ACTIVITIES) ?? {},
      terrain: parseFacetCounts(entry.terrain, CATALOG_TERRAINS) ?? {},
    };
  }
  return { facets: { schemaVersion: CATALOG_FACETS_SCHEMA_VERSION, shards }, warnings };
}

/**
 * Ids of the shards holding at least one item with `value` in `group` — the
 * only shards worth fetching to browse that facet. Order follows the digest;
 * rank them with `rankShardsByDistance` for "near me".
 */
/** The facet constraints a shard pick can honour (publisher and text cannot). */
export interface FacetShardFilter {
  kind?: CatalogKind | null;
  activity?: CatalogActivity | null;
  terrain?: CatalogTerrain | null;
}

/**
 * The shards that can hold an item matching EVERY set facet — the digest
 * counts each facet separately, so this is their intersection (a superset of
 * the exact answer, never a subset). Null when the filter sets no facet: then
 * any shard may match and the caller should rank them all.
 */
export function shardIdsForFacetFilter(
  facets: CatalogFacets,
  filter: FacetShardFilter,
): Set<string> | null {
  const wanted: [FacetGroup, string][] = [];
  if (filter.kind != null) wanted.push(['kinds', filter.kind]);
  if (filter.activity != null) wanted.push(['activities', filter.activity]);
  if (filter.terrain != null) wanted.push(['terrain', filter.terrain]);
  if (wanted.length === 0) return null;
  const sets = wanted.map(([group, value]) => new Set(shardIdsWithFacet(facets, group, value)));
  const [first, ...rest] = sets;
  return new Set([...(first ?? [])].filter((id) => rest.every((ids) => ids.has(id))));
}

export function shardIdsWithFacet(
  facets: CatalogFacets,
  group: FacetGroup,
  value: string,
): string[] {
  return Object.entries(facets.shards)
    .filter(([, counts]) => ((counts[group] as Record<string, number | undefined>)[value] ?? 0) > 0)
    .map(([id]) => id);
}
