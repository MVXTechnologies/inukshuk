/**
 * The map explorer's taxonomy (owner request 2026-09-29: browse "like
 * mountains, rivers, glacier, etc. or by activity", Avenza-style). Three
 * independent facets per catalog item, all OPTIONAL on the wire so older
 * manifests and older apps keep working (the legacy `category` stays):
 *
 * - `kind`       — what sort of map it is (one per item).
 * - `activities` — what it is good for (zero or more).
 * - `terrain`    — what the covered ground is like (zero or more).
 *
 * They are derived at manifest-build time (scripts/catalog, via
 * `@core/catalog/classify`) from the source, the title and the footprint, so
 * the app only reads them.
 */

export const CATALOG_KINDS = [
  'topo',
  'park',
  'trail',
  'hunting-fishing',
  'nautical',
  'aerial',
  'geological',
  'historical',
] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const CATALOG_ACTIVITIES = [
  'hiking',
  'ski',
  'snowshoe',
  'paddling',
  'cycling',
  'hunting',
  'fishing',
  'camping',
  'climbing',
  'offroad',
] as const;
export type CatalogActivity = (typeof CATALOG_ACTIVITIES)[number];

export const CATALOG_TERRAINS = ['mountains', 'water', 'glacier', 'coast', 'forest'] as const;
export type CatalogTerrain = (typeof CATALOG_TERRAINS)[number];

export const CATALOG_KIND_LABELS: Record<CatalogKind, string> = {
  topo: 'Topographic',
  park: 'Parks',
  trail: 'Trails',
  'hunting-fishing': 'Hunting & fishing',
  nautical: 'Nautical',
  aerial: 'Aerial',
  geological: 'Geological',
  historical: 'Historical',
};

export const CATALOG_ACTIVITY_LABELS: Record<CatalogActivity, string> = {
  hiking: 'Hiking',
  ski: 'Ski',
  snowshoe: 'Snowshoe',
  paddling: 'Paddling',
  cycling: 'Cycling',
  hunting: 'Hunting',
  fishing: 'Fishing',
  camping: 'Camping',
  climbing: 'Climbing',
  offroad: 'Off-road',
};

export const CATALOG_TERRAIN_LABELS: Record<CatalogTerrain, string> = {
  mountains: 'Mountains',
  water: 'Rivers & lakes',
  glacier: 'Glaciers',
  coast: 'Coast',
  forest: 'Forest',
};

/** MaterialCommunityIcons glyphs for the activity grid. */
export const CATALOG_ACTIVITY_ICONS: Record<CatalogActivity, string> = {
  hiking: 'hiking',
  ski: 'ski',
  snowshoe: 'snowshoeing',
  paddling: 'kayaking',
  cycling: 'bike',
  hunting: 'crosshairs',
  fishing: 'fish',
  camping: 'tent',
  climbing: 'carabiner',
  offroad: 'atv',
};

export const isCatalogKind = (v: unknown): v is CatalogKind =>
  typeof v === 'string' && (CATALOG_KINDS as readonly string[]).includes(v);
export const isCatalogActivity = (v: unknown): v is CatalogActivity =>
  typeof v === 'string' && (CATALOG_ACTIVITIES as readonly string[]).includes(v);
export const isCatalogTerrain = (v: unknown): v is CatalogTerrain =>
  typeof v === 'string' && (CATALOG_TERRAINS as readonly string[]).includes(v);

/**
 * A "link-out" collection: places whose maps live on the publisher's own
 * site (e.g. SÉPAQ — copyrighted, not redistributable, and sepaq.com refuses
 * scripted downloads), shown as cards that open the publisher's page. Served
 * as `collections.json` next to the catalog index.
 */
export interface LinkOutPlace {
  id: string;
  name: string;
  /** e.g. "National park", "Wildlife reserve". */
  type: string;
  latitude: number;
  longitude: number;
  /** The publisher's page for this place's maps. */
  url: string;
  activities?: CatalogActivity[];
}

export interface LinkOutCollection {
  id: string;
  name: string;
  publisher: string;
  /** One line under the title ("Maps on sepaq.com"). */
  blurb: string;
  homepage: string;
  places: LinkOutPlace[];
}
