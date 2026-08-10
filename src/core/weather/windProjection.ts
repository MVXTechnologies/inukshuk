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

/**
 * Is this camera state usable for a particle frame? A view whose layout size
 * has not landed yet (0×0) projects every particle far outside clip space —
 * the overlay must idle instead of drawing an invisible frame and calling it
 * rendered.
 */
export function isRenderableView(view: WindViewState): boolean {
  return (
    view.width > 0 &&
    view.height > 0 &&
    Number.isFinite(view.zoom) &&
    Number.isFinite(view.centerLng) &&
    Number.isFinite(view.centerLat)
  );
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

/** Latitude of a web-mercator Y in world units [0, 1] (inverse of mercatorY). */
export function latFromMercatorY(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** MapLibre's world size in px at a zoom (512px world tile at z0). */
export function worldSizePx(zoom: number): number {
  return 512 * Math.pow(2, zoom);
}

/** A rectangle in the wind grid's UV space (u east from the west edge, v south from the north edge). */
export interface GridRect {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}

/** The field georeferencing the UV mapping needs. */
export interface FieldGeo {
  /** West edge longitude, degrees. */
  lon0: number;
  /** North edge latitude, degrees. */
  lat0: number;
  /** Longitude span, degrees (positive). */
  lonSpan: number;
  /** Latitude span, degrees (positive, extending south). */
  latSpan: number;
}

/** Extra fraction of the viewport seeded off-screen so streaks flow IN, not just out. */
export const SPAWN_PAD = 0.2;

/**
 * Screen pixels a 1 m/s wind advects a particle per frame (~30 fps). The
 * visual constant: at 10 m/s a streak crosses a phone screen in ~5 s, and
 * the ~28-frame trail reads as a comet rather than a dot or a smear.
 */
export const PX_PER_FRAME_PER_MPS = 0.25;

/**
 * The camera viewport expressed in the field's grid-UV space, padded and
 * clamped to the grid.
 *
 * This is what the particle spawner needs. The fetch bbox is deliberately far
 * larger than the viewport (≥ 0.5° so the WCS subset stays a usable grid and
 * pans don't refetch), so seeding particles uniformly across the GRID puts
 * essentially all of them off-screen at trail zooms — at z14 the viewport is
 * ~0.15% of a 0.5° grid, i.e. 3 of 2000 particles visible. Spawning inside
 * this rect instead keeps the particle budget where the user is looking.
 *
 * A rotated (bearing ≠ 0) camera is covered by the axis-aligned bounding box
 * of the rotated viewport — spawning slightly wide is free, missing corners
 * would show as empty wedges.
 */
export function viewportGridRect(view: WindViewState, field: FieldGeo, pad = SPAWN_PAD): GridRect {
  const world = worldSizePx(view.zoom);
  const b = (view.bearing * Math.PI) / 180;
  const cosb = Math.abs(Math.cos(b));
  const sinb = Math.abs(Math.sin(b));
  const halfW = Math.max(view.width, 1) / 2 / world;
  const halfH = Math.max(view.height, 1) / 2 / world;
  // Bounding half-extents of the rotated viewport, mercator world units.
  const halfX = (cosb * halfW + sinb * halfH) * (1 + 2 * pad);
  const halfY = (sinb * halfW + cosb * halfH) * (1 + 2 * pad);
  const mx = mercatorX(view.centerLng);
  const my = mercatorY(view.centerLat);
  const lonMin = (mx - halfX) * 360 - 180;
  const lonMax = (mx + halfX) * 360 - 180;
  // Mercator y grows southward; the north edge is the smaller y.
  const latNorth = latFromMercatorY(Math.max(0, my - halfY));
  const latSouth = latFromMercatorY(Math.min(1, my + halfY));
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const span = (v: number): number => (v > 0 ? v : 1);
  const rect = {
    minU: clamp01((lonMin - field.lon0) / span(field.lonSpan)),
    maxU: clamp01((lonMax - field.lon0) / span(field.lonSpan)),
    minV: clamp01((field.lat0 - latNorth) / span(field.latSpan)),
    maxV: clamp01((field.lat0 - latSouth) / span(field.latSpan)),
  };
  // A viewport entirely outside the grid would collapse the rect onto an edge;
  // keep it non-degenerate so the spawner never divides the world by zero.
  const EPS = 1e-4;
  const widen = (min: number, max: number): [number, number] =>
    max - min >= EPS ? [min, max] : max + EPS <= 1 ? [min, max + EPS] : [min - EPS, max];
  [rect.minU, rect.maxU] = widen(rect.minU, rect.maxU);
  [rect.minV, rect.maxV] = widen(rect.minV, rect.maxV);
  return rect;
}

/**
 * Grid-UV advected per frame per m/s, for the update shader's `u_uv_per_mps`
 * (which applies `x / cos(lat)` and `−y` itself).
 *
 * Anchoring this to the VIEWPORT is what makes streaks readable: a step
 * expressed as a fraction of the fetched GRID is ~30× too large on screen at
 * trail zooms — particles jump a screen width per frame and render as
 * uncorrelated noise instead of flowing streaks. Screen-relative also keeps
 * the look stable as the user zooms, which is the Windy behaviour.
 */
export function advectionUvPerMps(
  view: WindViewState,
  field: FieldGeo,
  rect: GridRect,
  pxPerFramePerMps = PX_PER_FRAME_PER_MPS,
): { x: number; y: number } {
  const cosLat = Math.max(Math.cos((view.centerLat * Math.PI) / 180), 0.05);
  const spanU = Math.max(rect.maxU - rect.minU, 1e-6);
  const width = Math.max(view.width, 1);
  const latSpan = field.latSpan > 0 ? field.latSpan : 1;
  const lonSpan = field.lonSpan > 0 ? field.lonSpan : 1;
  // Δpos.x = gain·V·spanU/width after the shader's 1/cos(lat); the y term
  // converts the same ground distance into latitude (hence ×cos(lat)) and
  // rescales for a non-square grid.
  const base = (pxPerFramePerMps * spanU * cosLat) / width;
  return { x: base, y: (base * lonSpan) / latSpan };
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
