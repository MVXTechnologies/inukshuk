/**
 * Web-Mercator conventions of MapLibre Native, which the native terrain must
 * share bit-for-bit with the map it is drawn into: 512-px world tiles, the
 * world `512 · 2^zoom` pixels wide, x east, y SOUTH, and heights in metres
 * scaled by the pixels-per-metre at a latitude.
 */

/** MapLibre's world tile size in pixels (`util::tileSize_D`). */
export const WORLD_TILE_SIZE = 512;
/** WGS84 equatorial radius (`util::EARTH_RADIUS_M`). */
export const EARTH_RADIUS_M = 6378137;
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;
/** Mercator's latitude limit (`util::LATITUDE_MAX`). */
export const MAX_MERCATOR_LAT = 85.051128779806604;

const DEG2RAD = Math.PI / 180;

export function clampLat(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

/** World width in pixels at a (fractional) zoom. */
export function worldSize(zoom: number): number {
  return WORLD_TILE_SIZE * 2 ** zoom;
}

/** Longitude → mercator x in [0, 1) (unwrapped: 180° maps to 1). */
export function lngToMercX(lng: number): number {
  return (lng + 180) / 360;
}

/** Latitude → mercator y in [0, 1], 0 = north edge. Clamped to Mercator's range. */
export function latToMercY(lat: number): number {
  const phi = clampLat(lat) * DEG2RAD;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
}

export function mercXToLng(x: number): number {
  return x * 360 - 180;
}

export function mercYToLat(y: number): number {
  const n = Math.PI * (1 - 2 * y);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/**
 * Pixels per metre on the ground at `lat`, at `zoom` — the factor MapLibre's
 * projection applies to a vertex's z (metres) so heights and x/y share a unit.
 */
export function pixelsPerMeter(lat: number, zoom: number): number {
  return worldSize(zoom) / (EARTH_CIRCUMFERENCE_M * Math.cos(clampLat(lat) * DEG2RAD));
}

/** Ground metres covered by one tile edge at tile zoom `z`, at latitude `lat`. */
export function tileSizeMeters(z: number, lat: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos(clampLat(lat) * DEG2RAD)) / 2 ** z;
}

/** Normalise a longitude into [−180, 180). */
export function wrapLng(lng: number): number {
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  return w === 180 ? -180 : w;
}
