import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';
import type { FacetsOf } from './exploreFacets';
import type { NearbyCatalogItem } from './nearby';
import { catalogItemCountry, nearbySections } from './nearbySections';
import type { CatalogItem } from './schema';
import type { CatalogKind, LinkOutCollection, LinkOutPlace } from './taxonomy';

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

/**
 * One "Popular near you" card: a catalog map, or a place from a link-out
 * collection (a Parcs Québec park) whose maps live on the publisher's site.
 */
export type PopularCard =
  | { type: 'item'; item: CatalogItem; distanceMeters: number }
  | {
      type: 'place';
      place: LinkOutPlace;
      collection: LinkOutCollection;
      distanceMeters: number;
    };

/** A link-out place counts as "near" within this radius — a park 600 km off is not. */
export const POPULAR_PLACE_RADIUS_METERS = 250_000;

export interface PopularCardsOptions extends PopularNearOptions {
  /** At most this many place cards, so the row stays mostly downloadable maps. */
  maxPlaces?: number;
  placeRadiusMeters?: number;
}

/**
 * The carousel with link-out places folded in (2.1.x fix for "Popular near
 * you never shows anything"). From Québec City the catalog's nearest Canadian
 * sheets are New Brunswick CanTopo 321 km+ away (CanTopo does not cover the
 * area), so every card was a far-off sheet over a generic placeholder. The
 * parks with real maps 40–150 km away were only reachable three screens
 * down, under Collections.
 *
 * Places are weighted like parks ({@link POPULAR_KIND_WEIGHT}) and merged into
 * the leading national group's ranking — the link-out collections are Québec
 * publishers, and in any case a place within {@link POPULAR_PLACE_RADIUS_METERS}
 * is closer than the radius any catalog group uses. At most `maxPlaces`
 * (default half the row) are places.
 */
export function popularNearYouCards(
  items: readonly CatalogItem[],
  collections: readonly LinkOutCollection[],
  origin: LatLng | null,
  facetsOf: FacetsOf,
  options?: PopularCardsOptions,
): PopularCard[] {
  const limit = Math.max(0, options?.limit ?? DEFAULT_POPULAR_LIMIT);
  if (origin === null || limit === 0) return [];
  const maxPlaces = Math.max(0, options?.maxPlaces ?? Math.ceil(limit / 2));
  const placeRadius = options?.placeRadiusMeters ?? POPULAR_PLACE_RADIUS_METERS;

  const places: Extract<PopularCard, { type: 'place' }>[] = [];
  const seen = new Set<string>();
  for (const collection of collections) {
    for (const place of collection.places) {
      if (seen.has(place.id)) continue;
      seen.add(place.id);
      const distanceMeters = haversineMeters(origin, {
        latitude: place.latitude,
        longitude: place.longitude,
      });
      if (!Number.isFinite(distanceMeters) || distanceMeters > placeRadius) continue;
      places.push({ type: 'place', place, collection, distanceMeters });
    }
  }
  places.sort((a, b) =>
    a.distanceMeters !== b.distanceMeters
      ? a.distanceMeters - b.distanceMeters
      : a.place.id.localeCompare(b.place.id),
  );
  const keptPlaces = places.slice(0, maxPlaces);

  const mapCards: PopularCard[] = popularNearYou(items, origin, facetsOf, {
    ...options,
    limit,
  }).map((entry) => ({ type: 'item', ...entry }));
  if (keptPlaces.length === 0) return mapCards;

  // Merge places into the leading group: the leading group is every card up
  // to the first change of country in the CA → US → other order.
  const countryOf = (card: PopularCard | undefined) =>
    card?.type === 'item' ? catalogItemCountry(card.item) : null;
  const firstCountry = countryOf(mapCards[0]);
  let leadEnd = 0;
  while (leadEnd < mapCards.length && countryOf(mapCards[leadEnd]) === firstCountry) leadEnd += 1;
  const weight = (card: PopularCard): number => {
    if (card.type === 'place') return card.distanceMeters * POPULAR_KIND_WEIGHT.park;
    const kind = facetsOf(card.item).kind;
    return card.distanceMeters * (kind === null ? 1 : POPULAR_KIND_WEIGHT[kind]);
  };
  const lead = [...mapCards.slice(0, leadEnd), ...keptPlaces].sort((a, b) => weight(a) - weight(b));
  return [...lead, ...mapCards.slice(leadEnd)].slice(0, limit);
}

/** What the "Popular near you" section shows — it never silently disappears. */
export type PopularNearStatus = 'no-position' | 'loading' | 'none-in-range' | 'cards';

export function popularNearStatus(input: {
  position: LatLng | null;
  cardCount: number;
  loading: boolean;
}): PopularNearStatus {
  if (input.cardCount > 0) return 'cards';
  if (input.position === null) return 'no-position';
  return input.loading ? 'loading' : 'none-in-range';
}
