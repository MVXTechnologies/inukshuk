import { formatCoordinateNow } from '@state/useCoordinateFormatter';

/**
 * The ONE place the waypoint features (#676 move bar) turn a coordinate into
 * text: the user's Settings › Display › Coordinates format (#677).
 */
export function formatWaypointCoords(latitude: number, longitude: number): string {
  return formatCoordinateNow(latitude, longitude);
}
