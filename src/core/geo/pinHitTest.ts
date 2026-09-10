import { isValidLngLat } from './geomath';
import type { LngLat } from '@core/models';

/**
 * Choosing which map pin a tap hit (#343).
 *
 * Split out of `MapScreen` because the bug it exists to prevent was invisible
 * there: the handler projected every pin with `Promise.all`, so ONE pin the
 * projector rejected aborted the whole tap — and because the handler is
 * `async`, the rejection was swallowed with no crash and no report. A stored
 * waypoint with a coordinate that cannot be projected therefore killed every
 * map tap, permanently, until the app was reinstalled.
 */

/** A pin as the hit-test needs it: an id, where it is, and where it drew. */
export interface PinCandidate {
  longitude: number;
  latitude: number;
}

/** One pin's projected position, or `null` when it could not be projected. */
export type ProjectedPin = readonly [number, number] | null;

/** Pins worth asking the projector about, with the indices they came from. */
export function projectablePins<T extends PinCandidate>(
  pins: readonly T[],
): { index: number; lngLat: LngLat }[] {
  const out: { index: number; lngLat: LngLat }[] = [];
  pins.forEach((pin, index) => {
    const lngLat: LngLat = [pin.longitude, pin.latitude];
    if (isValidLngLat(lngLat)) out.push({ index, lngLat });
  });
  return out;
}

/** Pins whose stored coordinate is not a place on Earth — never projected. */
export function unprojectablePins<T extends PinCandidate>(pins: readonly T[]): T[] {
  return pins.filter((pin) => !isValidLngLat([pin.longitude, pin.latitude]));
}

/**
 * The nearest pin within `hitRadiusPx` of the tap, or `null`.
 *
 * `projected[i]` is the screen position of `pins[i]`, or `null` if that one
 * could not be projected — a pin that fails is skipped, never fatal. Pins draw
 * above their anchor, so `badgeOffsetPx` shifts the comparison up.
 */
export function nearestPinAt<T extends PinCandidate>(
  pins: readonly T[],
  projected: readonly ProjectedPin[],
  tap: readonly [number, number],
  hitRadiusPx: number,
  badgeOffsetPx: number,
): T | null {
  const [px, py] = tap;
  let best: T | null = null;
  let bestDistance = hitRadiusPx;
  for (let i = 0; i < pins.length; i++) {
    const point = projected[i];
    const pin = pins[i];
    if (!point || !pin) continue;
    const distance = Math.hypot(px - point[0], py - (point[1] - badgeOffsetPx));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = pin;
    }
  }
  return best;
}
