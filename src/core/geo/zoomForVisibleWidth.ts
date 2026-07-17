/** Earth's equatorial circumference in metres (Web-Mercator constant). */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/**
 * MapLibre's world size at zoom 0, in logical pixels. MapLibre (GL JS and the
 * native SDKs alike) uses the 512-px tile convention: the whole world spans
 * `512 * 2^zoom` logical pixels.
 */
const WORLD_PX_AT_ZOOM_0 = 512;

/** Web-Mercator's usable latitude domain; beyond it cos(lat) → 0 and the math degenerates. */
const MAX_MERCATOR_LAT = 85;

/**
 * The Web-Mercator zoom level at which `widthM` metres of ground span
 * `screenWidthPx` logical pixels at `latitude` (metres-per-pixel shrinks with
 * cos(latitude), so the same zoom shows less ground the further from the
 * equator you are).
 *
 * Used by the locate button to zoom in until roughly 2.5 km of terrain is
 * visible across the screen. Total: junk inputs (non-positive width, poles)
 * clamp instead of returning NaN/Infinity; the result is clamped to [0, 22].
 */
export function zoomForVisibleWidth(
  widthM: number,
  latitude: number,
  screenWidthPx: number,
): number {
  if (!(widthM > 0) || !(screenWidthPx > 0)) return 0;
  const lat = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, latitude));
  const zoom = Math.log2(
    (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180) * screenWidthPx) /
      (WORLD_PX_AT_ZOOM_0 * widthM),
  );
  return Math.min(22, Math.max(0, zoom));
}
