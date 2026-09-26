/**
 * Binding between a printed scale and the live map's camera (#349).
 *
 * The editor puts a fixed sheet on screen and moves the world under it, so the
 * two have to agree: the sheet's map window occupies a known number of screen
 * pixels and must show exactly the ground its page and scale imply. That makes
 * the camera zoom a function of the scale — and, because the relation inverts,
 * makes a pinch a way of *choosing* the scale.
 *
 * Web Mercator ground resolution, 256 px tiles, at the camera's latitude.
 */

/** Ground metres per pixel at zoom 0 on the equator, 256 px tiles. */
export const MERCATOR_M_PER_PX_Z0 = 156543.03392804097;

const cosLat = (latitude: number) =>
  Math.max(0.01, Math.cos((Math.max(-85, Math.min(85, latitude)) * Math.PI) / 180));

/** Ground metres each screen pixel covers at a zoom and latitude. */
export function metersPerPixel(zoom: number, latitude: number): number {
  return (MERCATOR_M_PER_PX_Z0 * cosLat(latitude)) / 2 ** zoom;
}

/**
 * The zoom at which `spanM` metres of ground exactly fills `spanPx` screen
 * pixels. This is what pins the sheet to its scale.
 */
export function zoomForGroundSpan(spanM: number, spanPx: number, latitude: number): number {
  if (spanM <= 0 || spanPx <= 0) return 0;
  return Math.log2((MERCATOR_M_PER_PX_Z0 * cosLat(latitude) * spanPx) / spanM);
}

/**
 * The print scale implied by a camera zoom — the inverse of the above, and the
 * reason a pinch can drive the scale chips instead of the other way round.
 * `mapRectPt` is the sheet's map frame width in points, `spanPx` the pixels it
 * occupies on screen.
 */
export function scaleDenomForZoom(
  zoom: number,
  spanPx: number,
  latitude: number,
  mapRectPt: number,
): number {
  const groundM = metersPerPixel(zoom, latitude) * spanPx;
  return groundM / mapRectPt / (0.0254 / 72);
}

/** Keep a zoom inside what the map (and the tile sources) can actually show. */
export function clampZoom(zoom: number, min = 1, max = 18): number {
  return Math.min(max, Math.max(min, zoom));
}

export interface CameraStop {
  center: [number, number];
  zoom: number;
}

/**
 * Whether two camera states differ enough to be worth restoring. Floating
 * point round-trips through the native bridge, so an exact compare would
 * "restore" on every exit and fight a user who never moved.
 */
export function cameraChanged(
  a: CameraStop,
  b: CameraStop,
  epsDeg = 1e-6,
  epsZoom = 1e-3,
): boolean {
  return (
    Math.abs(a.center[0] - b.center[0]) > epsDeg ||
    Math.abs(a.center[1] - b.center[1]) > epsDeg ||
    Math.abs(a.zoom - b.zoom) > epsZoom
  );
}

/** Canonical tile size the zoom scale is defined against. */
const CANONICAL_TILE_PX = 512;

/**
 * The deepest camera zoom at which a raster source still has REAL tiles.
 *
 * A source declared at `tileSize` is fetched `log2(512 / tileSize)` levels
 * below the camera, capped at the service's own maximum. Past that the map
 * overscales the deepest tiles it has — which looks exactly like a rendering
 * bug unless the UI says otherwise.
 */
export function maxSharpCameraZoom(sourceMaxZoom: number, tileSize: number): number {
  return sourceMaxZoom + 1 - Math.log2(CANONICAL_TILE_PX / tileSize);
}

/**
 * The smallest (most detailed) print scale a source can serve honestly, in
 * denominator terms — below this the sheet is showing overscaled tiles.
 * Returns 0 when the source can serve anything the editor can ask for.
 */
export function sharpestScaleDenom(
  sourceMaxZoom: number,
  tileSize: number,
  spanPx: number,
  latitude: number,
  mapRectPt: number,
): number {
  const zoom = maxSharpCameraZoom(sourceMaxZoom, tileSize);
  if (!Number.isFinite(zoom)) return 0;
  return scaleDenomForZoom(zoom, spanPx, latitude, mapRectPt);
}
