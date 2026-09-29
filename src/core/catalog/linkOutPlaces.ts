import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';
import { foldText } from './filterCatalog';
import type { LinkOutPlace } from './taxonomy';

/**
 * Sorting and grouping for a link-out collection's places (#447 — the Parcs
 * Québec screen): "Nearest first", or only one type of place ("National
 * parks", "Wildlife reserves"), each nearest-first when a position is known
 * and alphabetical otherwise. Pure.
 */

export interface PlaceEntry {
  place: LinkOutPlace;
  /** Metres from the user, when a position is known. */
  distanceMeters: number | null;
}

/** The distinct place types in first-seen order (the collection's own order). */
export function placeTypes(places: readonly LinkOutPlace[]): string[] {
  const seen: string[] = [];
  for (const place of places) if (!seen.includes(place.type)) seen.push(place.type);
  return seen;
}

/**
 * Places of `type` (all when null), nearest-first from `origin` when known,
 * else alphabetical (diacritic-folded, so "Île" sorts with the I's).
 */
export function sortLinkOutPlaces(
  places: readonly LinkOutPlace[],
  origin: LatLng | null,
  type: string | null = null,
): PlaceEntry[] {
  const entries: PlaceEntry[] = places
    .filter((place) => type === null || place.type === type)
    .map((place) => ({
      place,
      distanceMeters:
        origin === null
          ? null
          : haversineMeters(origin, { latitude: place.latitude, longitude: place.longitude }),
    }));
  entries.sort((a, b) => {
    if (a.distanceMeters !== null && b.distanceMeters !== null) {
      const d = a.distanceMeters - b.distanceMeters;
      if (d !== 0) return d;
    }
    const na = foldText(a.place.name);
    const nb = foldText(b.place.name);
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  return entries;
}

/** "National park" → "National parks" for a filter chip (naive English plural). */
export function pluralPlaceType(type: string): string {
  if (type === '') return type;
  if (/[^aeiou]y$/i.test(type)) return `${type.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(type)) return `${type}es`;
  return `${type}s`;
}
