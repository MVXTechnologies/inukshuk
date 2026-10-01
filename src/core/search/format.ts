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

/** Distance from the user, short; whole kilometres (or miles) past 100. */
export function placeDistance(distanceM: number | null, units: Units): string | null {
  if (distanceM === null || !Number.isFinite(distanceM)) return null;
  const far = units === 'imperial' ? distanceM >= 160_934 : distanceM >= 100_000;
  if (!far) {
    // One decimal is plenty for "how far is it": 23.5 km, not 23.46 km.
    const short = formatDistance(distanceM, units);
    const m = /^(\d+\.\d+) (km|mi)$/.exec(short);
    return m === null ? short : `${Number(m[1]).toFixed(1)} ${m[2]}`;
  }
  const n = Math.round(units === 'imperial' ? distanceM / 1609.344 : distanceM / 1000);
  const grouped = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped} ${units === 'imperial' ? 'mi' : 'km'}`;
}
