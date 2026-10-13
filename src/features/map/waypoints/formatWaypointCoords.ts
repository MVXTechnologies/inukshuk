import { formatLatLng } from '@core/geo/formatCoords';

/**
 * The ONE place the waypoint features (#676 move bar) turn a coordinate into
 * text. Decimal degrees today; when Settings › Units › Coordinates format
 * lands (#677), this is the call site to switch to the user's format.
 */
export function formatWaypointCoords(latitude: number, longitude: number): string {
  return formatLatLng(latitude, longitude);
}
