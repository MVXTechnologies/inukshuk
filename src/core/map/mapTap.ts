/**
 * Who owns a tap on the 2D map — the top of MapScreen's onMapPress routing.
 *
 * The point chip (the tapped-point bubble: coordinates to copy, Navigate,
 * Add waypoint) draws ABOVE every waypoint pin, so a tap that lands on it
 * belongs to it. The routing used to ask the pins first, which was fine until
 * a pin sat under an open chip — and "Add waypoint here" puts one there every
 * time: the new pin is planted on the very coordinate the chip is anchored to.
 * From then on the pin's (deliberately generous) hit disc swallowed every tap
 * on the bubble. It stayed on screen but did nothing — Copy, Navigate and
 * Waypoint all toggled the pin's viewer instead (owner report 2026-09-28,
 * "the bubble just stays open but isn't clickable").
 *
 * Kept free of screen geometry: the caller measures the chip hit and the pin
 * hit (`hitMapPointChip`, `nearestPinAt`) and this decides who wins.
 */

/** What a tap on the open point chip does. `copy` also closes the chip. */
export type PointChipHit = 'navigate' | 'waypoint' | 'copy';

export type MapTapRoute<P> =
  | { kind: 'chip'; hit: PointChipHit }
  | { kind: 'pin'; pin: P }
  /** Nothing on top claimed it — the heat/trail/dot/bare-map routes decide. */
  | { kind: 'map' };

/** The open chip first (it is drawn on top), then the pins, then the map. */
export function routeMapTap<P>(chipHit: PointChipHit | null, pin: P | null): MapTapRoute<P> {
  if (chipHit !== null) return { kind: 'chip', hit: chipHit };
  if (pin !== null) return { kind: 'pin', pin };
  return { kind: 'map' };
}

/**
 * Whether the chip stays up after one of its own actions ran.
 *
 * Navigate keeps it (the coordinates dialog opens over it and "Go" re-drops it
 * on the target anyway). Copy is the dismiss gesture. Waypoint closes it: the
 * pin that is about to be created takes over that exact spot, and a chip left
 * sitting on its own new pin is the stale bubble this module exists for.
 */
export function chipSurvivesHit(hit: PointChipHit): boolean {
  return hit === 'navigate';
}

/**
 * The chip after a bare tap nothing else claimed (#258): an open chip closes,
 * and only the NEXT tap on a clean map drops a fresh one — so the chip never
 * chases the finger around the map.
 */
export function pointChipAfterBareTap<T>(open: T | null, tapped: T): T | null {
  return open === null ? tapped : null;
}

/** A map press, copied out of MapLibre's `onPress` event: screen px and [lng, lat]. */
export interface MapPress {
  point: readonly [number, number];
  lngLat: readonly [number, number] | null;
}

/** The slice of MapLibre's press event this reads (flat tuples, not GeoJSON). */
export interface MapPressEvent {
  nativeEvent?: { point?: readonly [number, number]; lngLat?: readonly [number, number] } | null;
}

/**
 * Copy a MapLibre press out of its event — call it FIRST, synchronously, in
 * the `onPress` handler, and hand the copy to anything that awaits.
 *
 * React Native still recycles its synthetic events: the moment the handler
 * yields (its first `await`), the event's `nativeEvent` is nulled out.
 * MapScreen's onMapPress read `lngLat` only AFTER awaiting the camera
 * projection of the open chip and of every visible waypoint pin, so it got
 * `undefined` whenever either existed (owner report 2026-09-28, verified on
 * the emulator: `nativeEvent` is `null` after the await). Every route that
 * needs the tapped coordinate went dead:
 * - with the bubble open, a tap elsewhere could not close it (#258's close is
 *   in the `lngLat` branch) — only its own buttons, which have their own
 *   responders, still worked;
 * - with any waypoint pin on screen (e.g. right after "Add waypoint"), no tap
 *   could drop a bubble, and heat/trail taps were dead too.
 *
 * `null` when the press carries no screen point (nothing to hit-test).
 */
export function readMapPress(e: MapPressEvent): MapPress | null {
  const point = e.nativeEvent?.point;
  if (!point) return null;
  const lngLat = e.nativeEvent?.lngLat;
  return {
    point: [point[0], point[1]],
    lngLat: lngLat ? [lngLat[0], lngLat[1]] : null,
  };
}
