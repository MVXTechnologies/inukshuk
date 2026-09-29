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
