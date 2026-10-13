import {
  WAYPOINT_PIN_HIT,
  nearestPinAt,
  projectablePins,
  type PinCandidate,
  type ProjectedPin,
} from '@core/geo/pinHitTest';
import type { PendingWaypoint } from '@state/recorderStore';
import type { Waypoint } from '@core/models';
import type { PinInput } from '@core/map/waypointPinStyle';

/** A drawn pin, tagged with the store it lives in (as MapScreen's `visiblePins`). */
export type VisiblePin = ({ source: 'saved' } & Waypoint) | ({ source: 'live' } & PendingWaypoint);

/** The drawn pins as the symbol layer's input (#675). Live pins take no style. */
export function toPinInputs(pins: readonly VisiblePin[]): PinInput[] {
  return pins.map((w) => ({
    key: `${w.source}-${w.id}`,
    latitude: w.latitude,
    longitude: w.longitude,
    label: w.label,
    hasPhoto: !!w.photoUri,
    ...(w.source === 'saved'
      ? {
          ...(w.icon ? { icon: w.icon } : {}),
          ...(w.color ? { color: w.color } : {}),
          ...(w.size ? { size: w.size } : {}),
        }
      : {}),
  }));
}

/** What the hit-test needs from the map: its camera projection. */
interface Projector {
  project: (lngLat: [number, number]) => Promise<readonly [number, number] | null | undefined>;
}

/**
 * The pin under a screen point, or null (#676 long-press → Move). The same
 * rule as a tap (#343): every pin is projected through the real camera, one
 * that cannot be projected is skipped, never fatal.
 */
export async function pinAtPoint<T extends PinCandidate>(
  map: Projector,
  pins: readonly T[],
  point: readonly [number, number],
): Promise<T | null> {
  if (pins.length === 0) return null;
  const projected: ProjectedPin[] = new Array<ProjectedPin>(pins.length).fill(null);
  const results = await Promise.allSettled(
    projectablePins(pins).map(async ({ index, lngLat }) => ({
      index,
      point: await map.project([lngLat[0], lngLat[1]]),
    })),
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.point != null) {
      projected[r.value.index] = [r.value.point[0], r.value.point[1]];
    }
  }
  return nearestPinAt(
    pins,
    projected,
    point,
    WAYPOINT_PIN_HIT.radiusPx,
    WAYPOINT_PIN_HIT.badgeOffsetPx,
  );
}
