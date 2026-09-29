import { matchesCatalogFilter } from './filterCatalog';
import type { CatalogCategory, CatalogItem } from './schema';
import type { CatalogActivity, CatalogKind, CatalogTerrain } from './taxonomy';

/**
 * The map explorer's facet logic (#447): filter and count catalog items by
 * the taxonomy in `./taxonomy` — kind, activities, terrain — plus the
 * publisher (source).
 *
 * Pure and deliberately agnostic of WHERE an item's facets come from: every
 * function takes a {@link FacetsOf} accessor. The explorer UI passes one that
 * reads the optional wire fields defensively (so it works before and after the
 * manifests carry them); tests pass plain lookups.
 */

/** An item's taxonomy, resolved. `kind` is null only when nothing implies one. */
export interface ItemFacets {
  kind: CatalogKind | null;
  activities: readonly CatalogActivity[];
  terrain: readonly CatalogTerrain[];
}

export type FacetsOf = (item: CatalogItem) => ItemFacets;

/** One active explorer filter. Unset (or null) fields do not constrain. */
export interface ExploreFilter {
  kind?: CatalogKind | null;
  activity?: CatalogActivity | null;
  terrain?: CatalogTerrain | null;
  sourceId?: string | null;
  /** Free text, diacritic-folded like the store search. */
  text?: string;
}

/** True when the filter constrains nothing at all. */
export function isExploreFilterEmpty(filter: ExploreFilter): boolean {
  return (
    filter.kind == null &&
    filter.activity == null &&
    filter.terrain == null &&
    filter.sourceId == null &&
    (filter.text === undefined || filter.text.trim() === '')
  );
}

/** Does one item satisfy every active criterion? */
export function matchesExploreFilter(
  item: CatalogItem,
  filter: ExploreFilter,
  facetsOf: FacetsOf,
): boolean {
  if (filter.sourceId != null && item.sourceId !== filter.sourceId) return false;
  if (filter.kind != null || filter.activity != null || filter.terrain != null) {
    const facets = facetsOf(item);
    if (filter.kind != null && facets.kind !== filter.kind) return false;
    if (filter.activity != null && !facets.activities.includes(filter.activity)) return false;
    if (filter.terrain != null && !facets.terrain.includes(filter.terrain)) return false;
  }
  if (filter.text !== undefined && filter.text.trim() !== '') {
    return matchesCatalogFilter(item, { text: filter.text });
  }
  return true;
}

/**
 * Apply a filter, preserving input order. An empty filter returns the input
 * array itself (stable identity for memoized consumers).
 */
export function filterExploreItems(
  items: readonly CatalogItem[],
  filter: ExploreFilter,
  facetsOf: FacetsOf,
): readonly CatalogItem[] {
  if (isExploreFilterEmpty(filter)) return items;
  return items.filter((item) => matchesExploreFilter(item, filter, facetsOf));
}

/** Per-value totals of every facet over a set of items. */
export interface FacetCounts {
  kinds: Partial<Record<CatalogKind, number>>;
  activities: Partial<Record<CatalogActivity, number>>;
  terrains: Partial<Record<CatalogTerrain, number>>;
  sources: Record<string, number>;
}

/** Count every facet value across `items` (the loaded-items fallback for the index totals). */
export function countFacets(items: readonly CatalogItem[], facetsOf: FacetsOf): FacetCounts {
  const counts: FacetCounts = { kinds: {}, activities: {}, terrains: {}, sources: {} };
  for (const item of items) {
    const facets = facetsOf(item);
    if (facets.kind !== null) counts.kinds[facets.kind] = (counts.kinds[facets.kind] ?? 0) + 1;
    for (const a of facets.activities) counts.activities[a] = (counts.activities[a] ?? 0) + 1;
    for (const t of facets.terrain) counts.terrains[t] = (counts.terrains[t] ?? 0) + 1;
    counts.sources[item.sourceId] = (counts.sources[item.sourceId] ?? 0) + 1;
  }
  return counts;
}

/**
 * The kind a legacy `category` implies, for items published before the
 * manifests carried `kind`. Everything maps somewhere, so an old manifest
 * still fills the explorer's "Type" filter.
 */
const KIND_BY_CATEGORY: Record<CatalogCategory, CatalogKind> = {
  topo: 'topo',
  parks: 'park',
  geological: 'geological',
  aerial: 'aerial',
  forest: 'topo',
  hunting: 'hunting-fishing',
  touristic: 'trail',
  nautical: 'nautical',
  river: 'trail',
};

export function kindFromCategory(category: CatalogCategory): CatalogKind {
  return KIND_BY_CATEGORY[category];
}

/**
 * The single legacy category whose shards hold a kind, when there is exactly
 * one — lets a "Nautical" list pull only nautical shards. Null when the kind
 * spans several categories (or none), so the caller loads across all.
 */
export function categoryForKind(kind: CatalogKind | null | undefined): CatalogCategory | null {
  if (kind == null) return null;
  const matches = (Object.keys(KIND_BY_CATEGORY) as CatalogCategory[]).filter(
    (category) => KIND_BY_CATEGORY[category] === kind,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** "1:25 000" — a map scale from its denominator, thin-space grouped like the board. */
export function formatMapScale(denominator: number): string {
  if (!Number.isFinite(denominator) || denominator <= 0) return '';
  const grouped = String(Math.round(denominator)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `1:${grouped}`;
}

/** "1 map" / "14 200 maps" — thin-space grouped counts for tiles and rows. */
export function formatMapCount(count: number): string {
  const grouped = String(Math.max(0, Math.round(count))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return count === 1 ? '1 map' : `${grouped} maps`;
}
