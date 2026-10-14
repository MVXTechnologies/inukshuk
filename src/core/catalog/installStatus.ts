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

/** What a downloaded map says when the publisher has replaced its file (#680). */
export const NEWER_VERSION_NOTICE = 'A newer version is available';

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
 * Where this item stands relative to the Library.
 *
 * - When both the item and the Library copy carry a publisher file `version`
 *   (an ETag or content hash, #680), any difference is an update: the
 *   publisher replaced the file, whatever the dates say.
 * - Otherwise `update-available` only when both revision dates parse and the
 *   manifest's is strictly newer — a map downloaded before revisions were
 *   tracked (no `sourceUpdatedAt`) stays plain `installed` rather than nagging
 *   for a re-download.
 */
export function installStatusFor(item: CatalogItem, maps: readonly MapDocument[]): InstallStatus {
  const installed = findInstalledMap(maps, item.id);
  if (installed === undefined) return 'not-installed';
  if (item.version !== undefined && installed.sourceVersion !== undefined) {
    return item.version !== installed.sourceVersion ? 'update-available' : 'installed';
  }
  return isNewerDate(installed.sourceUpdatedAt, item.updatedAt) ? 'update-available' : 'installed';
}

/**
 * Library maps whose catalog item (among those loaded) has a newer file:
 * the Library row says {@link NEWER_VERSION_NOTICE}. One pass over each list.
 * A map whose item is not loaded right now is simply not reported.
 */
export function mapsWithNewerVersion(
  maps: readonly MapDocument[],
  items: readonly CatalogItem[],
): Set<string> {
  const out = new Set<string>();
  if (items.length === 0) return out;
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const m of maps) {
    if (m.sourceItemId === undefined) continue;
    const item = byId.get(m.sourceItemId);
    if (item !== undefined && installStatusFor(item, [m]) === 'update-available') out.add(m.id);
  }
  return out;
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
