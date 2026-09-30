import type { ExploreFilter } from '@core/catalog/exploreFacets';
import { isCatalogActivity, isCatalogKind, isCatalogTerrain } from '@core/catalog/taxonomy';

/**
 * The explorer's stack routes (`app/explore/*`) and their query strings. A
 * filter travels as plain params — `kind`, `activity`, `terrain`, `source` —
 * so a list, its map view and back stay one shareable state.
 */

type Params = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Route params → a filter; unknown vocabulary is ignored, never trusted. */
export function filterFromParams(params: Params): ExploreFilter {
  const kind = first(params.kind);
  const activity = first(params.activity);
  const terrain = first(params.terrain);
  const source = first(params.source);
  return {
    ...(isCatalogKind(kind) ? { kind } : {}),
    ...(isCatalogActivity(activity) ? { activity } : {}),
    ...(isCatalogTerrain(terrain) ? { terrain } : {}),
    ...(source !== undefined && source !== '' ? { sourceId: source } : {}),
  };
}

function query(filter: ExploreFilter): string {
  const parts: string[] = [];
  const add = (key: string, value: string | null | undefined) => {
    if (value != null && value !== '') parts.push(`${key}=${encodeURIComponent(value)}`);
  };
  add('kind', filter.kind);
  add('activity', filter.activity);
  add('terrain', filter.terrain);
  add('source', filter.sourceId);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

export const exploreListHref = (filter: ExploreFilter): string => `/explore/list${query(filter)}`;
export const exploreMapHref = (filter: ExploreFilter = {}): string =>
  `/explore/map${query(filter)}`;
export const exploreItemHref = (id: string): string => `/explore/item/${encodeURIComponent(id)}`;
export const exploreCollectionHref = (id: string): string =>
  `/explore/collection/${encodeURIComponent(id)}`;

/** Long-distance trails (#467): the full list, and one trail's page. */
export const exploreTrailsHref = (): string => '/explore/trails';
export const exploreTrailHref = (id: string): string => `/explore/trail/${encodeURIComponent(id)}`;
