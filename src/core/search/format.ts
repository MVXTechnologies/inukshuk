import { formatDistance, formatElevation, type Units } from '@core/format';
import type { Place } from './place';
import { PLACE_TYPES } from './placeTypes';

/**
 * The lines of a result row: "Peak · 1 120 m" and "Beaupré, Québec, Canada",
 * plus the distance from the user ("23.4 km", or "1 200 km" far away).
 */
export function placeKindLine(place: Place, units: Units): string {
  const label = PLACE_TYPES[place.type].label;
  return place.elevationM === undefined
    ? label
    : `${label} · ${formatElevation(place.elevationM, units)}`;
}

/** Distance from the user, short; whole kilometres (miles, NM) past 100. */
export function placeDistance(distanceM: number | null, units: Units): string | null {
  if (distanceM === null || !Number.isFinite(distanceM)) return null;
  // One decimal is plenty for "how far is it": 23.5 km, not 23.46 km.
  return formatDistance(distanceM, units, { style: 'tenths' });
}
