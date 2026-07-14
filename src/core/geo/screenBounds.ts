import type { BoundingBox } from '@core/models';

/**
 * Screen-space ⇄ geographic conversion for the offline region selector.
 *
 * The region box is drawn in the map view's pixel space; the downloaded pack
 * needs geographic bounds. For a **north-up, unpitched** map the mapping is
 * exact and purely local: screen X is linear in longitude and screen Y is linear
 * in *web-mercator* Y (NOT in latitude — that is the flat-earth approximation
 * this module replaces; it stretches the box toward the poles).
 *
 * Callers must therefore hand in the map's visible bounds captured while the
 * camera is flat and north-up (`bearing = 0`, `pitch = 0`). With any pitch the
 * visible region is a trapezoid reaching to the horizon and its bounding box is
 * far larger than the viewport rectangle, so a box drawn against it maps to a
 * much bigger area than the user sees.
 */

/** Rectangle in screen pixels, relative to the map view's top-left. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The map view's size in pixels. */
export interface ViewportSize {
  w: number;
  h: number;
}

/** The map's visible geographic bounds, in MapLibre's order: [west, south, east, north]. */
export type VisibleBounds = readonly [number, number, number, number];

/** The latitude where the web-mercator projection is cut off. */
const MAX_MERCATOR_LAT = 85.05112878;

/** Latitude → normalized web-mercator Y (0 at the north edge, 1 at the south edge). */
export function latToMercatorY(lat: number): number {
  const clamped = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/** Normalized web-mercator Y → latitude (the inverse of {@link latToMercatorY}). */
export function mercatorYToLat(y: number): number {
  const n = Math.PI * (1 - 2 * y);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Wrap a longitude into [-180, 180). */
function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Convert a point in the map view's pixel space to `[lng, lat]`.
 *
 * Returns `null` when the viewport has no size yet (nothing sensible to map to;
 * the caller should keep whatever estimate it had rather than fall back to
 * [0, 0] "null island").
 */
export function screenPointToLngLat(
  point: { x: number; y: number },
  viewport: ViewportSize,
  visible: VisibleBounds,
): [number, number] | null {
  if (viewport.w <= 0 || viewport.h <= 0) return null;
  const [west, south, east, north] = visible;

  const fx = clamp01(point.x / viewport.w);
  const fy = clamp01(point.y / viewport.h);

  // Longitude: linear across the viewport. A negative span means the visible
  // region crosses the antimeridian (e.g. west = 179, east = -179).
  const lngSpan = east - west >= 0 ? east - west : east - west + 360;
  const lng = normalizeLng(west + fx * lngSpan);

  // Latitude: linear in mercator Y, not in latitude.
  const yTop = latToMercatorY(north);
  const yBottom = latToMercatorY(south);
  const lat = mercatorYToLat(yTop + fy * (yBottom - yTop));

  return [lng, lat];
}

/**
 * Convert a rectangle drawn in the map view's pixel space to the geographic
 * bounds it covers — i.e. exactly the area the user framed, no more.
 */
export function screenRectToBounds(
  rect: ScreenRect,
  viewport: ViewportSize,
  visible: VisibleBounds,
): BoundingBox | null {
  const topLeft = screenPointToLngLat({ x: rect.x, y: rect.y }, viewport, visible);
  const bottomRight = screenPointToLngLat(
    { x: rect.x + rect.w, y: rect.y + rect.h },
    viewport,
    visible,
  );
  if (topLeft === null || bottomRight === null) return null;

  const [lng0, lat0] = topLeft;
  const [lng1, lat1] = bottomRight;
  return {
    minLat: Math.min(lat0, lat1),
    maxLat: Math.max(lat0, lat1),
    minLng: Math.min(lng0, lng1),
    maxLng: Math.max(lng0, lng1),
  };
}
