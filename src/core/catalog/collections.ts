import {
  CATALOG_ACTIVITIES,
  isCatalogActivity,
  type CatalogActivity,
  type CatalogKind,
  type LinkOutCollection,
  type LinkOutPlace,
} from './taxonomy';

/**
 * Parser for `/catalog/v2/collections.json` — the explorer's link-out
 * collections (see `LinkOutCollection` in `./taxonomy`). Wire shape is a bare
 * `LinkOutCollection[]`; `{ collections: [...] }` is accepted too so the
 * document can grow a header later without breaking this client.
 *
 * Same contract as the catalog parsers: any JSON in, never throws; a malformed
 * place or collection is dropped with a warning, never the whole document.
 */

export interface LinkOutCollectionsParseResult {
  collections: LinkOutCollection[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Link-outs open in the system browser: https only (http is upgraded by nobody). */
function httpsUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/[^\s/]+\.[^\s]+$/.test(value) ? value : null;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

function coordinate(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit
    ? value
    : null;
}

function parsePlace(raw: unknown): LinkOutPlace | string {
  if (!isRecord(raw)) return 'place is not an object';
  if (!isId(raw.id)) return `place with an unusable id "${String(raw.id)}"`;
  const name = text(raw.name);
  const type = text(raw.type);
  const url = httpsUrl(raw.url);
  const latitude = coordinate(raw.latitude, 90);
  const longitude = coordinate(raw.longitude, 180);
  if (name === null) return `place "${raw.id}": missing name`;
  if (type === null) return `place "${raw.id}": missing type`;
  if (url === null) return `place "${raw.id}": missing or non-https url`;
  if (latitude === null || longitude === null) return `place "${raw.id}": bad coordinates`;
  const present = new Set<CatalogActivity>(
    Array.isArray(raw.activities) ? raw.activities.filter(isCatalogActivity) : [],
  );
  const activities = CATALOG_ACTIVITIES.filter((a) => present.has(a));
  return {
    id: raw.id,
    name,
    type,
    latitude,
    longitude,
    url,
    ...(activities.length > 0 ? { activities } : {}),
  };
}

function parseCollection(raw: unknown, warnings: string[]): LinkOutCollection | null {
  if (!isRecord(raw) || !isId(raw.id)) {
    warnings.push('dropped a collection without a usable id');
    return null;
  }
  const name = text(raw.name);
  const publisher = text(raw.publisher);
  const blurb = text(raw.blurb);
  const homepage = httpsUrl(raw.homepage);
  if (name === null || publisher === null || blurb === null || homepage === null) {
    warnings.push(`dropped collection "${raw.id}": missing name, publisher, blurb or homepage`);
    return null;
  }
  const places: LinkOutPlace[] = [];
  const ids = new Set<string>();
  for (const rawPlace of Array.isArray(raw.places) ? raw.places : []) {
    const place = parsePlace(rawPlace);
    if (typeof place === 'string') {
      warnings.push(`collection "${raw.id}": dropped ${place}`);
      continue;
    }
    if (ids.has(place.id)) {
      warnings.push(`collection "${raw.id}": dropped duplicate place "${place.id}"`);
      continue;
    }
    ids.add(place.id);
    places.push(place);
  }
  if (places.length === 0) {
    warnings.push(`dropped collection "${raw.id}": no usable places`);
    return null;
  }
  return { id: raw.id, name, publisher, blurb, homepage, places };
}

export function parseLinkOutCollections(raw: unknown): LinkOutCollectionsParseResult {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.collections)
      ? raw.collections
      : null;
  if (list === null) return { collections: [], warnings: ['collections is not a list'] };
  const warnings: string[] = [];
  const collections: LinkOutCollection[] = [];
  const ids = new Set<string>();
  for (const rawCollection of list) {
    const collection = parseCollection(rawCollection, warnings);
    if (collection === null) continue;
    if (ids.has(collection.id)) {
      warnings.push(`dropped duplicate collection "${collection.id}"`);
      continue;
    }
    ids.add(collection.id);
    collections.push(collection);
  }
  return { collections, warnings };
}

/**
 * Default activities per place type, applied by the generator to places that
 * carry none of their own. Coarse on purpose: it is what the place *type* is
 * for (a Québec wildlife reserve exists for hunting and fishing; a national
 * park for hiking and camping), not a claim about any one park's offer.
 */
export const PLACE_TYPE_ACTIVITIES: Readonly<Record<string, CatalogActivity[]>> = {
  'National park': ['hiking', 'camping'],
  'Marine park': ['paddling'],
  'Wildlife reserve': ['hunting', 'fishing'],
  // A zec (zone d'exploitation contrôlée) is a hunting and fishing territory.
  ZEC: ['hunting', 'fishing'],
};

/** A place's own activities, else its type's defaults (vocabulary order). */
export function placeActivities(
  place: Pick<LinkOutPlace, 'type' | 'activities'>,
): CatalogActivity[] {
  if (place.activities !== undefined && place.activities.length > 0) return [...place.activities];
  const defaults = new Set(PLACE_TYPE_ACTIVITIES[place.type] ?? []);
  return CATALOG_ACTIVITIES.filter((a) => defaults.has(a));
}

/**
 * The explorer "Type" a place is browsed under, by place type — so the map's
 * Type chip ("Hunting & fishing", "Parks") reaches places as well as map
 * sheets. Same vocabulary as catalog items (`CatalogKind`); a type not listed
 * has no kind and only shows while no Type is selected.
 */
export const PLACE_TYPE_KINDS: Readonly<Record<string, CatalogKind>> = {
  'National park': 'park',
  'Marine park': 'park',
  'Wildlife reserve': 'hunting-fishing',
  ZEC: 'hunting-fishing',
};

export function placeKind(place: Pick<LinkOutPlace, 'type'>): CatalogKind | null {
  return PLACE_TYPE_KINDS[place.type] ?? null;
}
