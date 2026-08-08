import type { MapDocument } from '@core/models';
import type { CatalogItem } from './schema';

/**
 * Dedup between the catalog and the Library. A downloaded map carries
 * `sourceItemId` (the catalog item it came from) and `sourceUpdatedAt` (the
 * item's revision date at download time) — see `MapDocument` schema v5.
 * Re-tapping Download must never duplicate; a newer manifest revision surfaces
 * as "Update" instead.
 */

export type InstallStatus = 'not-installed' | 'installed' | 'update-available';

/** The Library map downloaded from this catalog item, if any. */
export function findInstalledMap(
  maps: readonly MapDocument[],
  itemId: string,
): MapDocument | undefined {
  return maps.find((m) => m.sourceItemId === itemId);
}

/** Strict "b is a later date than a" on ISO date strings; false on junk. */
function isNewerDate(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && tb > ta;
}

/**
 * Where this item stands relative to the Library. `update-available` only when
 * both revision dates parse and the manifest's is strictly newer — a map
 * downloaded before revisions were tracked (no `sourceUpdatedAt`) stays plain
 * `installed` rather than nagging for a re-download.
 */
export function installStatusFor(
  item: CatalogItem,
  maps: readonly MapDocument[],
): InstallStatus {
  const installed = findInstalledMap(maps, item.id);
  if (installed === undefined) return 'not-installed';
  return isNewerDate(installed.sourceUpdatedAt, item.updatedAt) ? 'update-available' : 'installed';
}
