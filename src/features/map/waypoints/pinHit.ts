import type { PendingWaypoint } from '@state/recorderStore';
import type { Waypoint } from '@core/models';
import type { PinInput } from '@core/map/waypointPinStyle';

import { waypointAtPoint, type WaypointTapMap } from './waypointTap';

/** A drawn pin, tagged with the store it lives in (as MapScreen's `visiblePins`). */
export type VisiblePin = ({ source: 'saved' } & Waypoint) | ({ source: 'live' } & PendingWaypoint);

/** A drawn pin's key, as the layers name it (`saved-<id>`, `live-<id>`). */
export function visiblePinKey(pin: Pick<VisiblePin, 'source' | 'id'>): string {
  return `${pin.source}-${pin.id}`;
}

/** The drawn pins as the symbol layer's input (#675). Live pins take no style. */
export function toPinInputs(pins: readonly VisiblePin[]): PinInput[] {
  return pins.map((w) => ({
    key: visiblePinKey(w),
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

/**
 * The pin under a long-press, or null (#676 long-press → Move). The same
 * rule as a tap (#343), with the tighter long-press disc: every pin is
 * projected through the real camera, one that cannot be projected is
 * skipped, never fatal. A pin folded into a cluster (#685) is not on screen
 * and never starts a Move; neither does a long-press on a cluster.
 */
export async function pinAtPoint<T extends VisiblePin>(
  map: WaypointTapMap,
  pins: readonly T[],
  point: readonly [number, number],
  selectedKey: string | null = null,
  /** Every pin drawn (live ones included), when `pins` is only some of them. */
  drawnCount: number = pins.length,
): Promise<T | null> {
  // Long-press: the tight disc, so one next to a pin stays the coordinates chip.
  const hit = await waypointAtPoint(
    map,
    pins,
    visiblePinKey,
    selectedKey,
    point,
    'longPress',
    drawnCount,
  );
  return hit.kind === 'pin' ? hit.pin : null;
}
