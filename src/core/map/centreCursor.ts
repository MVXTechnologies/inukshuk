/**
 * The point the centre cursor marks (#677 dot, 2.6.0 cursor icons): the map
 * centre — which is you while the map follows you and there is a fix, as the
 * info strip's centre coordinates read it. A bare long-press and the + menu's
 * "Add waypoint" act here (#709), not at the finger.
 */
import type { LatLng } from '@core/models';

import { isRealCenter } from './coordinatesChip';

export function centreCursorPoint(
  mapCenter: LatLng | null,
  followsUser: boolean,
  position: LatLng | null,
): LatLng | null {
  if (followsUser && position !== null) {
    return { latitude: position.latitude, longitude: position.longitude };
  }
  return mapCenter !== null && isRealCenter(mapCenter)
    ? { latitude: mapCenter.latitude, longitude: mapCenter.longitude }
    : null;
}
