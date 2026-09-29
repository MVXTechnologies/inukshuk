import type { LatLng } from '@core/models';
import type { FacetsOf } from './exploreFacets';
import type { NearbyCatalogItem } from './nearby';
import { nearbySections } from './nearbySections';
import type { CatalogItem } from './schema';
import type { CatalogKind } from './taxonomy';

/**
 * "Popular near you" — the explorer landing's carousel (#447).
 *
 * Built on {@link nearbySections}, so it keeps that module's hard-won rules:
 * Canadian sources first (from Québec City the nearest CanTopo sheet is far
 * but must still lead — see nearbySections for why), the per-category mix,
 * and the "near" radius. Within each national group the order is
 * nearest-first **weighted by kind**: a park or trail map a little further
 * away is what most people opening the tab want before the fourth adjacent
 * topo sheet, and aerial/geological sheets are specialist maps that should
 * not lead the row.
 *
 * Pure: the screen passes the loaded items, the user's last known position
 * and the facet accessor.
 */

/** Distance multiplier per kind: < 1 pulls a kind forward, > 1 pushes it back. */
export const POPULAR_KIND_WEIGHT: Record<CatalogKind, number> = {
  park: 0.6,
  trail: 0.7,
  topo: 1,
  'hunting-fishing': 1,
  nautical: 1.1,
  historical: 1.4,
  geological: 1.4,
  aerial: 1.4,
};

export const DEFAULT_POPULAR_LIMIT = 8;

export interface PopularNearOptions {
  limit?: number;
  radiusMeters?: number;
}

/** The carousel's cards, CA-first, kind-weighted nearest-first, capped at `limit`. */
export function popularNearYou(
  items: readonly CatalogItem[],
  origin: LatLng | null,
  facetsOf: FacetsOf,
  options?: PopularNearOptions,
): NearbyCatalogItem[] {
  const limit = Math.max(0, options?.limit ?? DEFAULT_POPULAR_LIMIT);
  if (origin === null || limit === 0) return [];
  const sections = nearbySections(items, origin, {
    limits: { CA: limit, US: limit, other: limit },
    ...(options?.radiusMeters !== undefined ? { radiusMeters: options.radiusMeters } : {}),
  });
  const weight = (entry: NearbyCatalogItem): number => {
    const kind = facetsOf(entry.item).kind;
    return entry.distanceMeters * (kind === null ? 1 : POPULAR_KIND_WEIGHT[kind]);
  };
  const out: NearbyCatalogItem[] = [];
  for (const section of sections) {
    const ranked = [...section.entries].sort((a, b) => {
      const d = weight(a) - weight(b);
      return d !== 0 ? d : a.item.id.localeCompare(b.item.id);
    });
    for (const entry of ranked) {
      if (out.length >= limit) return out;
      out.push(entry);
    }
  }
  return out;
}
