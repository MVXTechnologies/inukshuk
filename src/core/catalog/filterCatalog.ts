import type { CatalogCategory, CatalogItem } from './schema';

/**
 * Pure client-side search over the catalog (mirrors `filterTracks` for the
 * Library). Text matching is diacritic-folded so "riviere" finds "Rivière" —
 * the QC catalog content is largely French while phone keyboards often aren't.
 */

/** Lowercase and strip combining diacritics ("Rivière" → "riviere"). */
export function foldText(text: string): string {
  // NFD splits accented letters into base + combining marks (U+0300–U+036F).
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export interface CatalogFilter {
  /** Free-text query; every whitespace-separated token must match. */
  text?: string;
  /** Category chip; null/undefined = all categories. */
  category?: CatalogCategory | null;
}

/** The folded haystack a text token is matched against. */
function haystack(item: CatalogItem): string {
  return foldText(`${item.title} ${item.id} ${item.region ?? ''}`);
}

/** Does one catalog item match every active criterion? */
export function matchesCatalogFilter(item: CatalogItem, filter: CatalogFilter): boolean {
  if (filter.category != null && item.category !== filter.category) return false;
  const query = filter.text?.trim();
  if (query !== undefined && query !== '') {
    const hay = haystack(item);
    for (const token of foldText(query).split(/\s+/)) {
      if (token !== '' && !hay.includes(token)) return false;
    }
  }
  return true;
}

/**
 * Apply a filter, preserving manifest order. With no active criteria the input
 * array is returned as-is (stable identity for memoized consumers).
 */
export function filterCatalogItems(
  items: readonly CatalogItem[],
  filter: CatalogFilter,
): readonly CatalogItem[] {
  const textActive = filter.text !== undefined && filter.text.trim() !== '';
  if (!textActive && filter.category == null) return items;
  return items.filter((item) => matchesCatalogFilter(item, filter));
}

/**
 * Categories present in the manifest, in the fixed vocabulary order the chips
 * render in (manifest order would jump around between generator runs).
 */
export function categoriesPresent(
  items: readonly CatalogItem[],
  order: readonly CatalogCategory[],
): CatalogCategory[] {
  const present = new Set(items.map((i) => i.category));
  return order.filter((c) => present.has(c));
}
