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
export function installStatusFor(item: CatalogItem, maps: readonly MapDocument[]): InstallStatus {
  const installed = findInstalledMap(maps, item.id);
  if (installed === undefined) return 'not-installed';
  return isNewerDate(installed.sourceUpdatedAt, item.updatedAt) ? 'update-available' : 'installed';
}

/**
 * `installStatusFor` for a whole catalog in one pass, keyed by item id.
 *
 * Per-item it is a `maps.find(...)` over the entire Library, which the store
 * screen was paying for every visible row on every render — O(rows × library)
 * on a screen that re-renders on each download-progress tick. Indexing the
 * Library once makes it O(items + library).
 *
 * The index keeps the FIRST map for a given sourceItemId, because that is what
 * `findInstalledMap`'s `find` returns. Duplicates are reachable in practice (a
 * repeat download, or an "Update" that adds rather than replaces), and their
 * `sourceUpdatedAt` values can differ — last-wins would flip a row between
 * `installed` and `update-available` on Library order alone.
 */
export function indexInstallStatus(
  items: readonly CatalogItem[],
  maps: readonly MapDocument[],
): Map<string, InstallStatus> {
  const bySourceItem = new Map<string, MapDocument>();
  for (const m of maps) {
    if (m.sourceItemId !== undefined && !bySourceItem.has(m.sourceItemId)) {
      bySourceItem.set(m.sourceItemId, m);
    }
  }
  const out = new Map<string, InstallStatus>();
  for (const item of items) {
    const doc = bySourceItem.get(item.id);
    out.set(item.id, doc === undefined ? 'not-installed' : installStatusFor(item, [doc]));
  }
  return out;
}
