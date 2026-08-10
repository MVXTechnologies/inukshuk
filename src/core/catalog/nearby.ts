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

/** How many rows one category may take, so the section stays a mix. */
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
 */
export function nearbyCatalogItems(
  items: readonly CatalogItem[],
  origin: LatLng | null,
  options?: NearbyOptions,
): NearbyCatalogItem[] {
  if (origin === null) return [];
  const limit = Math.max(0, options?.limit ?? DEFAULT_NEARBY_LIMIT);
  const perCategory = Math.max(1, options?.perCategory ?? DEFAULT_NEARBY_PER_CATEGORY);
  const radius = Math.max(0, options?.radiusMeters ?? DEFAULT_NEARBY_RADIUS_METERS);
  if (limit === 0) return [];

  const candidates: NearbyCatalogItem[] = [];
  for (const item of items) {
    const distanceMeters = catalogItemDistanceMeters(item, origin);
    if (distanceMeters === null || distanceMeters > radius) continue;
    candidates.push({ item, distanceMeters });
  }
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
