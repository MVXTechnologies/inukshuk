import type { MapDocument } from '@core/models';

import { itemCredit } from './credit';
import type { CatalogItem, CatalogSource } from './schema';

/** The provenance fields a phone rolled back to 2.5.1 drops from a downloaded map. */
export type CreditedProvenance = Pick<
  MapDocument,
  'sourceCredit' | 'sourceFreeAt' | 'sourcePageUrl' | 'sourceVersion'
>;

/** One map's missing provenance, as the catalog gives it now. */
export interface ProvenancePatch {
  id: string;
  patch: CreditedProvenance;
}

/**
 * The credit fields to put back on downloaded maps (2.5.2 review, #680).
 *
 * 2.5.1 does not know `sourceCredit`, `sourceFreeAt`, `sourcePageUrl` or
 * `sourceVersion`, so a phone rolled back to it and forward again has
 * Cartes Plein-air maps whose Library rows no longer credit their author.
 * They come back from the catalog item the map was downloaded from
 * (`sourceItemId`), once that item is loaded:
 *
 * - the author credit, the "free at" host and the page, whenever missing;
 * - the publisher file `version` only when the map holds that very revision
 *   (its `sourceUpdatedAt` is the item's `updatedAt`): a version filled in
 *   from a newer item would hide the "Update" the map is due.
 *
 * Never overwrites a field that is there. Pure; cheap when nothing is missing
 * (no item index is built).
 */
export function provenanceBackfill(
  maps: readonly MapDocument[],
  items: readonly CatalogItem[],
  sources: readonly CatalogSource[],
): ProvenancePatch[] {
  const needy = maps.filter(
    (m) =>
      m.sourceItemId !== undefined &&
      (m.sourceCredit === undefined ||
        m.sourceFreeAt === undefined ||
        m.sourcePageUrl === undefined ||
        m.sourceVersion === undefined),
  );
  if (needy.length === 0 || items.length === 0) return [];
  const wanted = new Set(needy.map((m) => m.sourceItemId));
  const byId = new Map<string, CatalogItem>();
  for (const item of items) if (wanted.has(item.id) && !byId.has(item.id)) byId.set(item.id, item);
  if (byId.size === 0) return [];
  const freeAt = new Map(sources.map((s) => [s.id, s.freeAt]));

  const out: ProvenancePatch[] = [];
  for (const m of needy) {
    const item = m.sourceItemId === undefined ? undefined : byId.get(m.sourceItemId);
    if (item === undefined) continue;
    const patch: CreditedProvenance = {};
    const credit = itemCredit(item);
    if (m.sourceCredit === undefined && credit !== undefined) patch.sourceCredit = credit;
    const host = freeAt.get(item.sourceId);
    if (m.sourceFreeAt === undefined && host !== undefined) patch.sourceFreeAt = host;
    if (m.sourcePageUrl === undefined && item.pageUrl !== undefined) {
      patch.sourcePageUrl = item.pageUrl;
    }
    if (
      m.sourceVersion === undefined &&
      item.version !== undefined &&
      m.sourceUpdatedAt !== undefined &&
      m.sourceUpdatedAt === item.updatedAt
    ) {
      patch.sourceVersion = item.version;
    }
    if (Object.keys(patch).length > 0) out.push({ id: m.id, patch });
  }
  return out;
}
