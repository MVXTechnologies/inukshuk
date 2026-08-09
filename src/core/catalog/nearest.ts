import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';
import { foldText } from './filterCatalog';
import type { CatalogBbox, CatalogItem } from './schema';

/**
 * Nearest-first ordering for the map store (Wave C): sort catalog items by
 * distance from the user's last known position to the item's bbox center, so
 * "maps around me" surface before the far shore of the country. Pure — the UI
 * passes `settingsStore.lastKnownPosition` (or null) in.
 */

/** Center of a WGS84 [west, south, east, north] bbox. */
export function bboxCenter(bbox: CatalogBbox): LatLng {
  return { latitude: (bbox[1] + bbox[3]) / 2, longitude: (bbox[0] + bbox[2]) / 2 };
}

/**
 * Great-circle metres from `origin` to the item's bbox center, or null when
 * the item has no bbox (it can't be placed, so it can't be ranked by place).
 */
export function catalogItemDistanceMeters(item: CatalogItem, origin: LatLng): number | null {
  if (item.bbox === undefined) return null;
  return haversineMeters(origin, bboxCenter(item.bbox));
}

/** Diacritic-folded A→Z title comparison (ties broken by id for stability). */
function compareAlphabetical(a: CatalogItem, b: CatalogItem): number {
  const ta = foldText(a.title);
  const tb = foldText(b.title);
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sort catalog items for display: nearest-first from `origin` when one is
 * known, alphabetical otherwise. Items without a bbox always sort after
 * placeable ones (alphabetically among themselves). Never mutates the input.
 */
export function sortCatalogItems(
  items: readonly CatalogItem[],
  origin: LatLng | null,
): CatalogItem[] {
  const sorted = [...items];
  if (origin === null) {
    sorted.sort(compareAlphabetical);
    return sorted;
  }
  const distances = new Map<string, number | null>(
    items.map((item) => [item.id, catalogItemDistanceMeters(item, origin)]),
  );
  sorted.sort((a, b) => {
    const da = distances.get(a.id) ?? null;
    const db = distances.get(b.id) ?? null;
    if (da === null && db === null) return compareAlphabetical(a, b);
    if (da === null) return 1;
    if (db === null) return -1;
    if (da !== db) return da - db;
    return compareAlphabetical(a, b);
  });
  return sorted;
}
