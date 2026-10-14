import { WAYPOINT_PIN_DIAMETER, pinGeometry, waypointSize } from '@core/library/waypointStyle';
import type { LngLat, WaypointSize } from '@core/models';

import { comparePinDraw } from '@core/map/waypointPinStyle';

import { isValidLngLat } from './geomath';

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

/** Which gesture is asking: a tap opens a pin, a long-press starts Move (#676). */
export type PinHitGesture = 'tap' | 'longPress';

/**
 * Finger slack around a pin's head, px. A tap is generous: missing a pin
 * opens the coordinates chip instead, which is cheap to close (and why the
 * open chip is asked BEFORE the pins, see @core/map/mapTap). A long-press is
 * tight: it starts Move, and a long-press next to a pin must stay the
 * coordinates chip (navigate.yaml long-presses the map centre).
 */
export const PIN_HIT_SLOP_PX: Readonly<Record<PinHitGesture, number>> = { tap: 22, longPress: 8 };
/** A tap target is never smaller than a 48 dp touch target. */
export const PIN_MIN_TAP_RADIUS_PX = 24;

/** Heads this close to equally near count as one spot (px): the top-most pin wins. */
export const PIN_TIE_PX = 1;

/** A pin's hit disc: centred `headOffsetPx` above its anchor (the tip), `radiusPx` wide. */
export interface PinHitArea {
  radiusPx: number;
  headOffsetPx: number;
  /** The drawn head's own radius (no slack): a tap inside it is dead on the pin. */
  headRadiusPx: number;
}

/**
 * The hit disc of a pin of `size` (#675): centred on the pin's HEAD, which a
 * symbol pin draws `pinGeometry(d).headCenterY` above the tip anchored on the
 * coordinate, and as wide as the head plus the gesture's slack. Screen px are
 * the map's own (dp), as `project` returns them.
 *
 * `scale` is the Pin size setting (#686, `@core/map/pinScale`): the head is
 * drawn that much larger or smaller, so its disc is too. The finger's slack
 * and the 48 dp minimum stay what they are: a finger does not change size.
 */
export function pinHitArea(
  size: WaypointSize | undefined,
  gesture: PinHitGesture,
  scale = 1,
): PinHitArea {
  const d = WAYPOINT_PIN_DIAMETER[waypointSize(size)] * scale;
  const radius = d / 2 + PIN_HIT_SLOP_PX[gesture];
  return {
    radiusPx: gesture === 'tap' ? Math.max(PIN_MIN_TAP_RADIUS_PX, radius) : radius,
    headOffsetPx: pinGeometry(d).headCenterY,
    headRadiusPx: d / 2,
  };
}

/** A pin as the hit-test needs it: where it is, and how big it draws (absent = M). */
export interface PinCandidate {
  longitude: number;
  latitude: number;
  size?: WaypointSize;
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
 * The pin whose hit disc holds the tap and whose head is nearest, or `null`.
 *
 * `projected[i]` is the screen position of `pins[i]`, or `null` if that one
 * could not be projected — a pin that fails is skipped, never fatal. Each pin
 * is measured from its own head (see `pinHitArea`), so an XL pin is hit where
 * an XL pin draws.
 *
 * Two heads equally near (within {@link PIN_TIE_PX} — pins at one spot):
 * the one DRAWN ON TOP wins, by the layer's own rule (`comparePinDraw`:
 * south in front, then later in `pins`), so a tap opens the pin you see.
 *
 * `scale`: the Pin size setting (#686), see `pinHitArea`.
 */
export function nearestPinAt<T extends PinCandidate>(
  pins: readonly T[],
  projected: readonly ProjectedPin[],
  tap: readonly [number, number],
  gesture: PinHitGesture,
  scale = 1,
): T | null {
  return nearestPinHitAt(pins, projected, tap, gesture, scale)?.pin ?? null;
}

/** A pin hit, and how far the tap was from its head's centre. */
export interface PinHit<T> {
  pin: T;
  distancePx: number;
  /** The tap landed on the drawn head itself, not in the finger's slack round it. */
  onHead: boolean;
}

/** {@link nearestPinAt}, with the distance: the tap router weighs it against a cluster (#685). */
export function nearestPinHitAt<T extends PinCandidate>(
  pins: readonly T[],
  projected: readonly ProjectedPin[],
  tap: readonly [number, number],
  gesture: PinHitGesture,
  scale = 1,
): PinHit<T> | null {
  const [px, py] = tap;
  let best: T | null = null;
  let bestIndex = -1;
  let bestDistance = Infinity;
  let bestHead = 0;
  for (let i = 0; i < pins.length; i++) {
    const point = projected[i];
    const pin = pins[i];
    if (!point || !pin) continue;
    const { radiusPx, headOffsetPx, headRadiusPx } = pinHitArea(pin.size, gesture, scale);
    const distance = Math.hypot(px - point[0], py - (point[1] - headOffsetPx));
    if (distance >= radiusPx) continue;
    const nearer = distance < bestDistance - PIN_TIE_PX;
    const tiedOnTop =
      best !== null &&
      Math.abs(distance - bestDistance) <= PIN_TIE_PX &&
      comparePinDraw(pin.latitude, i, best.latitude, bestIndex) > 0;
    if (best === null || nearer || tiedOnTop) {
      bestDistance = distance;
      best = pin;
      bestIndex = i;
      bestHead = headRadiusPx;
    }
  }
  return best === null
    ? null
    : { pin: best, distancePx: bestDistance, onHead: bestDistance <= bestHead };
}
