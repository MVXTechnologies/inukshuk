import { itemActivities } from '@core/catalog/classify';
import { kindFromCategory, type FacetCounts, type ItemFacets } from '@core/catalog/exploreFacets';
import type { CatalogIndex, CatalogItem } from '@core/catalog/schema';
import {
  CATALOG_ACTIVITIES,
  CATALOG_KINDS,
  CATALOG_TERRAINS,
  isCatalogActivity,
  isCatalogKind,
  isCatalogTerrain,
} from '@core/catalog/taxonomy';

/**
 * ADAPTER (#447, explorer UI ↔ data branch) — reads the taxonomy fields the
 * data side is adding to catalog items and to the index, DEFENSIVELY, so the
 * explorer works both before and after those land:
 *
 * - item fields (optional): `kind: CatalogKind`, `activities: CatalogActivity[]`,
 *   `terrain: CatalogTerrain[]`, `scale: number` (the denominator, 25000 for
 *   1:25 000; a "1:25000" string is accepted too);
 * - index fields (optional): `kindCounts`, `activityCounts`, `terrainCounts`,
 *   `sourceCounts` (each `{ [value]: number }`, like `categoryCounts`), or the
 *   same four nested under `facetCounts` as `kinds` / `activities` /
 *   `terrains` / `sources`.
 *
 * Until `@core/catalog/schema` parses them, the typed objects simply don't
 * carry these keys, so every read goes through `unknown` and a type guard.
 * Once the schema types them, this file collapses to plain property reads —
 * nothing else in the explorer needs to change.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList<T extends string>(value: unknown, guard: (v: unknown) => v is T): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) if (guard(entry) && !out.includes(entry)) out.push(entry);
  return out;
}

/** Items are immutable once parsed, so their facets are resolved once. */
const facetCache = new WeakMap<CatalogItem, ItemFacets>();

/**
 * An item's kind / activities / terrain. A missing or unknown `kind` falls
 * back to the legacy category's implied kind, so an old manifest still
 * fills the Type filter.
 *
 * Activities are the ones the explorer BROWSES the item under
 * (`itemActivities`): its stored evidence, else what its terrain implies. Topo
 * sheets never store activities (a toponym is not evidence), so reading the raw
 * field alone left "Hiking" empty on every US Topo / CanTopo sheet while the
 * landing's tile — counted by the same rule at build time — promised 27 000
 * (#474).
 */
export function itemFacets(item: CatalogItem): ItemFacets {
  const cached = facetCache.get(item);
  if (cached !== undefined) return cached;
  const raw: unknown = item;
  const record = isRecord(raw) ? raw : {};
  const terrain = stringList(record.terrain, isCatalogTerrain);
  const facets: ItemFacets = {
    kind: isCatalogKind(record.kind) ? record.kind : kindFromCategory(item.category),
    activities: itemActivities({
      activities: stringList(record.activities, isCatalogActivity),
      terrain,
    }),
    terrain,
  };
  facetCache.set(item, facets);
  return facets;
}

/** The map's scale denominator (25000 for 1:25 000), when the item states one. */
export function itemScaleDenominator(item: CatalogItem): number | null {
  const raw: unknown = item;
  if (!isRecord(raw)) return null;
  const scale = raw.scale;
  if (typeof scale === 'number' && Number.isFinite(scale) && scale > 1) return scale;
  if (typeof scale === 'string') {
    const match = /^\s*1\s*:\s*([\d\s ,.]+)\s*$/.exec(scale);
    const value = match?.[1] !== undefined ? Number(match[1].replace(/[\s ,.]/g, '')) : NaN;
    if (Number.isFinite(value) && value > 1) return value;
  }
  return null;
}

function countRecord<T extends string>(
  value: unknown,
  vocabulary: readonly T[] | null,
): Partial<Record<T, number>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Partial<Record<T, number>> = {};
  for (const [key, count] of Object.entries(value)) {
    if (vocabulary !== null && !(vocabulary as readonly string[]).includes(key)) continue;
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      out[key as T] = Math.round(count);
    }
  }
  return out;
}

/** Whole-catalog facet totals as the index states them; a missing facet stays undefined. */
export type IndexFacetCounts = {
  [K in keyof FacetCounts]?: FacetCounts[K];
};

/**
 * The index's facet totals, or null when it carries none (an index from
 * before the taxonomy). The landing then falls back to what is loaded.
 */
export function indexFacetCounts(index: CatalogIndex | null): IndexFacetCounts | null {
  const raw: unknown = index;
  if (!isRecord(raw)) return null;
  const nested = isRecord(raw.facetCounts) ? raw.facetCounts : {};
  const kinds = countRecord(raw.kindCounts ?? nested.kinds, CATALOG_KINDS);
  const activities = countRecord(raw.activityCounts ?? nested.activities, CATALOG_ACTIVITIES);
  const terrains = countRecord(raw.terrainCounts ?? nested.terrains, CATALOG_TERRAINS);
  const sources = countRecord<string>(raw.sourceCounts ?? nested.sources, null);
  if (!kinds && !activities && !terrains && !sources) return null;
  return {
    ...(kinds ? { kinds } : {}),
    ...(activities ? { activities } : {}),
    ...(terrains ? { terrains } : {}),
    ...(sources ? { sources: sources as Record<string, number> } : {}),
  };
}
