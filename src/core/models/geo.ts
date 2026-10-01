/**
 * Primitive geographic types shared across the whole app.
 *
 * Convention: we keep `LatLng` (object form, latitude/longitude) for app/UI code
 * because expo-location speaks that dialect, and `LngLat` (tuple form,
 * [lng, lat]) for anything touching GeoJSON / MapLibre, which use that ordering.
 */

/** WGS84 position in decimal degrees. */
export interface LatLng {
  latitude: number;
  longitude: number;
}

/** [longitude, latitude] in decimal degrees — GeoJSON / MapLibre ordering. */
export type LngLat = [longitude: number, latitude: number];

/** Axis-aligned geographic bounding box in WGS84 decimal degrees. */
export interface BoundingBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}
