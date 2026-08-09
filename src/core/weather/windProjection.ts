/**
 * Camera math for the wind particle overlay (weather M3): maps the wind
 * grid's mercator space onto the GLView's clip space from a MapLibre
 * ViewState (center/zoom/bearing + layout size).
 *
 * The particle shaders keep positions in grid-UV space; the draw shader
 * turns UV into mercator offsets RELATIVE to the field's north-west corner
 * (small numbers — float32-safe at deep zooms) and multiplies by the matrix
 * built here, which folds the field-origin-to-camera translation in at
 * float64 precision. Pitch is deliberately absent: the overlay fades out
 * above PARTICLES_MAX_PITCH_DEG instead of projecting a tilted camera.
 */

/** The slice of a MapLibre ViewState the projection needs, plus layout px. */
export interface WindViewState {
  centerLng: number;
  centerLat: number;
  zoom: number;
  /** Map bearing, degrees (compass direction that points screen-up). */
  bearing: number;
  pitch: number;
  /** GLView layout size in px (density-independent is fine — ratios only). */
  width: number;
  height: number;
}

/** Web-mercator X of a longitude, world units [0, 1]. */
export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

/** Web-mercator Y of a latitude, world units [0, 1] (0 = north), clamped. */
export function mercatorY(lat: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const rad = (clamped * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI);
}

/** MapLibre's world size in px at a zoom (512px world tile at z0). */
export function worldSizePx(zoom: number): number {
  return 512 * Math.pow(2, zoom);
}

/**
 * Column-major mat4 mapping field-relative mercator offsets → clip space.
 * Input vertex coords: x = mercator-X offset EAST of the field's west edge,
 * y = mercator-Y offset SOUTH of the field's north edge (both world units).
 * Verified conventions: clip +y is up; bearing 90° puts east at the top.
 */
export function fieldClipMatrix(
  view: WindViewState,
  fieldLon0: number,
  fieldLat0: number,
): Float32Array {
  const world = worldSizePx(view.zoom);
  const dxo = mercatorX(fieldLon0) - mercatorX(view.centerLng);
  const dyo = mercatorY(fieldLat0) - mercatorY(view.centerLat);
  const b = (view.bearing * Math.PI) / 180;
  const cosb = Math.cos(b);
  const sinb = Math.sin(b);
  const sx = (2 * world) / Math.max(view.width, 1);
  const sy = (2 * world) / Math.max(view.height, 1);
  // clip.x = sx·(cosb·(dxo+x) + sinb·(dyo+y))
  // clip.y = sy·(sinb·(dxo+x) − cosb·(dyo+y))
  return new Float32Array([
    sx * cosb,
    sy * sinb,
    0,
    0,
    sx * sinb,
    -sy * cosb,
    0,
    0,
    0,
    0,
    1,
    0,
    sx * (cosb * dxo + sinb * dyo),
    sy * (sinb * dxo - cosb * dyo),
    0,
    1,
  ]);
}
