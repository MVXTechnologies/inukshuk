import type { LatLng } from '@core/models';
import { catalogItemDistanceMeters } from './nearest';
import type { CatalogCategory, CatalogItem } from './schema';

/**
 * "Around you" — the short cross-category list the Search tab lands on.
 *
 * The nearest-first *list* ordering (`sortCatalogItems`) answers "which of
 * these 400 topo sheets is closest". This answers a different question: "of
 * everything in the world catalog, what would I want here, right now?" — so it
 * ranks across categories and deliberately caps each one. Without the cap the
 * section is eight adjacent topo quads and the nautical chart of the bay you
 * are standing on never appears.
 *
 * Pure: the screen passes `settingsStore.lastKnownPosition` (or null) in.
 */

/** Beyond this, "around you" would be a lie — the section simply stays empty. */
export const DEFAULT_NEARBY_RADIUS_METERS = 800_000;

/** How many rows the landing section shows. */
export const DEFAULT_NEARBY_LIMIT = 6;

/**
 * Floor for the per-category cap: however many categories are around, one of
 * them may always take at least this many rows (otherwise a nine-category
 * catalog would allow a single row each and the section would read as a menu).
 */
export const DEFAULT_NEARBY_PER_CATEGORY = 2;

export interface NearbyOptions {
  limit?: number;
  perCategory?: number;
  radiusMeters?: number;
}

export interface NearbyCatalogItem {
  item: CatalogItem;
  /** Great-circle metres from the origin to the item's bbox center. */
  distanceMeters: number;
}

/**
 * Nearest placeable items around `origin`, at most `perCategory` from any one
 * category and at most `limit` overall, all within `radiusMeters`.
 *
 * Returns `[]` when there is no known position — the caller hides the section
 * rather than guessing, which is the graceful no-location fallback: the
 * category grid below is unaffected and still browses the whole world.
 *
 * The cap is applied to a globally distance-sorted list, so the result is
 * always "the nearest thing of its kind" per category, never a category's
 * far-away sheet jumping ahead of a nearer one.
 *
 * With no explicit `perCategory` the cap **adapts to what is actually around**:
 * it is the share of `limit` each present category may take, never below
 * {@link DEFAULT_NEARBY_PER_CATEGORY}. That matters because the cap exists to
 * stop one dense category crowding the others out — when there is only one
 * category around (the published catalog is 65 877 topo sheets and nothing
 * else) there is nothing to crowd out, and a fixed cap would silently shrink
 * the section to two rows however many the caller asked for.
 */
export function nearbyCatalogItems(
  items: readonly CatalogItem[],
  origin: LatLng | null,
  options?: NearbyOptions,
): NearbyCatalogItem[] {
  if (origin === null) return [];
  const limit = Math.max(0, options?.limit ?? DEFAULT_NEARBY_LIMIT);
  const radius = Math.max(0, options?.radiusMeters ?? DEFAULT_NEARBY_RADIUS_METERS);
  if (limit === 0) return [];

  const candidates: NearbyCatalogItem[] = [];
  for (const item of items) {
    const distanceMeters = catalogItemDistanceMeters(item, origin);
    if (distanceMeters === null || distanceMeters > radius) continue;
    candidates.push({ item, distanceMeters });
  }

  // Adapt the cap to the categories genuinely in range, not to the vocabulary:
  // a category with nothing nearby must not reserve rows it will never use.
  const categoriesPresent = new Set(candidates.map((c) => c.item.category)).size;
  const perCategory = Math.max(
    1,
    options?.perCategory ??
      Math.max(DEFAULT_NEARBY_PER_CATEGORY, Math.ceil(limit / Math.max(1, categoriesPresent))),
  );

  candidates.sort((a, b) =>
    a.distanceMeters !== b.distanceMeters
      ? a.distanceMeters - b.distanceMeters
      : a.item.id.localeCompare(b.item.id),
  );

  const taken = new Map<CatalogCategory, number>();
  const picked: NearbyCatalogItem[] = [];
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    const used = taken.get(candidate.item.category) ?? 0;
    if (used >= perCategory) continue;
    taken.set(candidate.item.category, used + 1);
    picked.push(candidate);
  }
  return picked;
}
