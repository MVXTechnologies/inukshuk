/**
 * Keep a tapped map feature in view above the bottom card that describes it
 * (the geodetic-point card): where the camera's centre must go so the
 * feature sits in the middle of the map area the card and the top chrome
 * leave visible. The zoom is not touched — only the centre slides.
 *
 * Works in screen pixels of the map view: the caller projects the feature
 * (`map.project`), calls this, and unprojects the returned centre pixel back
 * to a coordinate for the camera. That keeps it right at any zoom and under
 * rotation; under a tilt it is a close first-order answer, which is all a
 * "keep it in view" nudge needs.
 */

export interface CardCameraInput {
  /** The feature's position in map-view pixels. */
  featurePx: readonly [number, number];
  /** The map view's size, px. */
  mapSize: { width: number; height: number };
  /** The top of the free area: below the search bar and buttons, px. */
  visibleTop: number;
  /** The bottom of the free area: the card's top edge, px. */
  visibleBottom: number;
  /** Below this distance the feature is left where it is (no jitter). Default 12 px. */
  minShiftPx?: number;
}

/** Where the free area's centre is, or null when the card leaves no room. */
export function freeAreaCenter(input: CardCameraInput): [number, number] | null {
  const top = Math.max(0, input.visibleTop);
  const bottom = Math.min(input.mapSize.height, input.visibleBottom);
  if (bottom - top < 48 || input.mapSize.width <= 0) return null;
  return [input.mapSize.width / 2, (top + bottom) / 2];
}

/**
 * The map-view pixel the camera centre should move to, or null to stay put
 * (already centred, no room, or nonsense input).
 */
export function cardCameraCenterPx(input: CardCameraInput): [number, number] | null {
  const target = freeAreaCenter(input);
  const [fx, fy] = input.featurePx;
  if (target === null || !Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  const dx = target[0] - fx;
  const dy = target[1] - fy;
  if (Math.hypot(dx, dy) < (input.minShiftPx ?? 12)) return null;
  // Moving the content by (dx, dy) = moving the camera centre by (−dx, −dy).
  return [input.mapSize.width / 2 - dx, input.mapSize.height / 2 - dy];
}
