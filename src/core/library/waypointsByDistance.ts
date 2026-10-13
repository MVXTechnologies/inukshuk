import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import type { LatLng } from '@core/models';

/**
 * The map's pins as a list, nearest first (2.5.1 review): the screen-reader
 * way to the pins. Since #675 the pins are GL symbols, which have no
 * accessibility nodes, so TalkBack and VoiceOver reach them through this
 * list instead (`WaypointScreenReaderList`).
 */

/** One pin, with how far and which way it is from where the list was opened. */
export interface WaypointNearby<T> {
  item: T;
  distanceM: number;
  /** Bearing from the origin, degrees clockwise from true north, [0, 360). */
  bearingDeg: number;
}

/**
 * `items` nearest first from `from`. Ties (same spot) keep their input order.
 * A pin whose stored coordinate is not a place on Earth is left out rather
 * than sorted somewhere arbitrary. O(n log n), once per opening of the list —
 * never per fix (a list re-sorting under a screen reader's focus would move
 * the row being read).
 */
export function waypointsByDistance<T extends LatLng>(
  items: readonly T[],
  from: LatLng,
): WaypointNearby<T>[] {
  const out: (WaypointNearby<T> & { index: number })[] = [];
  items.forEach((item, index) => {
    if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return;
    const distanceM = haversineMeters(from, item);
    out.push({
      item,
      distanceM,
      bearingDeg: distanceM > 0 ? initialBearingDeg(from, item) : 0,
      index,
    });
  });
  out.sort((a, b) => a.distanceM - b.distanceM || a.index - b.index);
  return out.map(({ item, distanceM, bearingDeg }) => ({ item, distanceM, bearingDeg }));
}

const DIRECTIONS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const;

/** A bearing as a spoken eighth of the compass ("north-east"), never "NE". */
export function spokenDirection(bearingDeg: number): string {
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return DIRECTIONS[i] ?? 'north';
}

/**
 * How far and which way, as a row reads it: "120 m north-east" (the distance
 * already formatted in the user's units). Under 1 m there is no direction to
 * give: "here".
 */
export function waypointRowDetail(distanceText: string, nearby: WaypointNearby<unknown>): string {
  if (nearby.distanceM < 1) return 'here';
  return `${distanceText} ${spokenDirection(nearby.bearingDeg)}`;
}
