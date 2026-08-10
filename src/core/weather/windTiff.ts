import { parseFloat32Grid } from '@core/geo/floatTiff';

/**
 * GeoMet WCS float32 GeoTIFF parsing for the weather M3 wind fields — now a
 * thin EPSG:4326 wrapper over the shared `@core/geo/floatTiff` parser (the
 * decoder was promoted there so the NONNA bathymetry pipeline can reuse it;
 * marine wave D). The GeoMet behavior is unchanged: little-endian
 * strip-organized single-band float32 with PixelScale+Tiepoint georeferencing
 * decodes to the same grid as before, and anything outside a plausible
 * degrees-space georeference (e.g. a mercator-metres NONNA grid) returns
 * null — callers treat null as "no wind field" and degrade to the gradient
 * drape (GeoMet answers bad TIME values with an XML ServiceException body,
 * which fails the shared parser's magic check).
 */

export interface WindGrid {
  /** Grid width in pixels (columns, west → east). */
  width: number;
  /** Grid height in pixels (rows, north → south). */
  height: number;
  /** Row-major samples; row 0 is the northernmost. */
  data: Float32Array;
  /** Longitude of the grid's west edge (tiepoint, degrees). */
  lon0: number;
  /** Latitude of the grid's NORTH edge (tiepoint, degrees). */
  lat0: number;
  /** Pixel width in degrees longitude (positive). */
  dLon: number;
  /** Pixel height in degrees latitude (positive; rows go south). */
  dLat: number;
}

/**
 * Parse a GeoMet WCS float32 single-band GeoTIFF. Null on anything that
 * violates the documented shape — never throws on arbitrary bytes.
 */
export function parseFloat32Tiff(bytes: Uint8Array): WindGrid | null {
  const grid = parseFloat32Grid(bytes);
  if (grid === null) return null;
  // Degrees-space sanity gate (kept from the original parser): a grid whose
  // top edge is outside ±90° latitude is not a 4326 weather field.
  if (grid.y0 < -90.01 || grid.y0 > 90.01) return null;
  return {
    width: grid.width,
    height: grid.height,
    data: grid.data,
    lon0: grid.x0,
    lat0: grid.y0,
    dLon: grid.dx,
    dLat: grid.dy,
  };
}
