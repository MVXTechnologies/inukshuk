import proj4 from 'proj4';
import type { LngLat } from '@core/models';

/**
 * CRS helpers: detect an EPSG code from the loose hints that GeoPDFs carry
 * (EPSG numbers, WKT strings, datum + projection + UTM zone), and build a
 * reprojection function to WGS84 lon/lat (EPSG:4326).
 *
 * Pure TS, depends only on proj4 — runs in Node and the RN JS runtime.
 */

/** proj4 def for WGS84 geographic lon/lat. */
export const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

/** A reprojector mapping native CRS coordinates -> WGS84 [lng, lat]. */
export interface Reprojector {
  /** The EPSG code we resolved, if any. */
  epsg?: number;
  /** Whether the native CRS is already WGS84 geographic (no transform needed). */
  isWgs84: boolean;
  /** Map a native (x, y) — already in (lng, lat) order for geographic CRS — to WGS84. */
  toWgs84(x: number, y: number): LngLat;
  /**
   * The inverse: WGS84 lon/lat -> native (x, y). Needed to place a known
   * geographic outline (an NTS sheet's neatline, say) into a projected
   * raster's own pixel grid without inverse-projecting every pixel.
   */
  fromWgs84(lng: number, lat: number): [number, number];
}

/** Build a UTM proj4 definition string for a zone + hemisphere. */
export function utmProj4(zone: number, north: boolean): string {
  return `+proj=utm +zone=${zone} ${north ? '' : '+south '}+datum=WGS84 +units=m +no_defs`;
}

/** EPSG code for a WGS84 UTM zone. North = 326xx, South = 327xx. */
export function utmEpsg(zone: number, north: boolean): number {
  return (north ? 32600 : 32700) + zone;
}

/** Is an EPSG code a WGS84 UTM zone? Returns {zone, north} or null. */
export function utmFromEpsg(epsg: number): { zone: number; north: boolean } | null {
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, north: true };
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, north: false };
  return null;
}

/**
 * Is an EPSG code a North-American-datum UTM zone? NAD83 north is 269zz
 * (zones 3–23) and NAD27 north is 267zz (zones 3–22). Every NRCan CanMatrix
 * scan is one of the NAD83 ones — 021L14 is 26919, 103I09 is 26909 — so
 * without this the whole Canadian GeoTIFF catalog would fall through to the
 * "unknown CRS, assume lon/lat" branch and land off the coast of Africa.
 */
export function northAmericanUtmFromEpsg(
  epsg: number,
): { zone: number; datum: 'NAD83' | 'NAD27' } | null {
  if (epsg >= 26903 && epsg <= 26923) return { zone: epsg - 26900, datum: 'NAD83' };
  if (epsg >= 26703 && epsg <= 26722) return { zone: epsg - 26700, datum: 'NAD27' };
  return null;
}

/**
 * Resolve a proj4 source definition for a known EPSG code. Returns null if we
 * don't have a built-in mapping (proj4 only ships 4326 + 3857 by default).
 */
export function proj4DefForEpsg(epsg: number): string | null {
  if (epsg === 4326) return WGS84;
  if (epsg === 3857 || epsg === 900913) {
    return '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs';
  }
  if (epsg === 4269) return '+proj=longlat +datum=NAD83 +no_defs';
  if (epsg === 4267) return '+proj=longlat +datum=NAD27 +no_defs';
  const utm = utmFromEpsg(epsg);
  if (utm) return utmProj4(utm.zone, utm.north);
  const na = northAmericanUtmFromEpsg(epsg);
  if (na) return `+proj=utm +zone=${na.zone} +datum=${na.datum} +units=m +no_defs`;
  return null;
}

/**
 * Try to pull an EPSG code out of a WKT string or a free-form CRS description.
 * Looks for AUTHORITY["EPSG","32618"], "EPSG:4326", a UTM zone phrase, or a
 * Web-Mercator hint. Returns undefined if nothing recognizable is found.
 */
export function epsgFromText(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const t = text.trim();

  // AUTHORITY["EPSG","32618"] — take the LAST one (outermost CRS authority).
  const authMatches = [...t.matchAll(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)];
  if (authMatches.length > 0) {
    const last = authMatches[authMatches.length - 1]!;
    return Number(last[1]);
  }
  // ID["EPSG",32618] (WKT2)
  const id = t.match(/ID\s*\[\s*"EPSG"\s*,\s*(\d+)\s*\]/i);
  if (id) return Number(id[1]);
  // EPSG:4326 / EPSG 4326 / urn:ogc:def:crs:EPSG::4326
  const colon = t.match(/EPSG\s*[:]{1,2}\s*(\d{4,6})/i);
  if (colon) return Number(colon[1]);

  // Web mercator by name.
  if (/web[\s_-]*mercator|pseudo[\s_-]*mercator|spherical\s+mercator/i.test(t)) {
    return 3857;
  }

  // UTM zone phrasing: "UTM zone 18N" / "UTM Zone 18 North".
  const utm = t.match(/UTM\s+zone\s+(\d{1,2})\s*([NS]|north|south)?/i);
  if (utm) {
    const zone = Number(utm[1]);
    const hemi = (utm[2] ?? 'N').toUpperCase();
    const north = hemi.startsWith('N');
    if (/WGS\s*84|WGS84|D_WGS_1984|World Geodetic/i.test(t) || !/NAD/i.test(t)) {
      return utmEpsg(zone, north);
    }
  }
  // Bare WGS84 geographic.
  if (/GEOGCS|GEOGCRS|longlat|geographic/i.test(t) && /WGS[\s_]*84/i.test(t)) {
    return 4326;
  }
  return undefined;
}

/**
 * Build a Reprojector from an EPSG code and/or a WKT/proj string. We prefer a
 * recognized EPSG; if proj4 lacks a built-in def we synthesize one, otherwise
 * fall back to passing the WKT/proj string straight to proj4.
 */
export function makeReprojector(opts: {
  epsg?: number;
  wkt?: string;
  proj4Def?: string;
}): Reprojector {
  const { epsg, wkt, proj4Def } = opts;

  const identity: Reprojector = {
    ...(epsg !== undefined ? { epsg } : {}),
    isWgs84: true,
    toWgs84: (x, y) => [x, y],
    fromWgs84: (lng, lat) => [lng, lat],
  };
  if (epsg === 4326) return identity;

  let sourceDef: string | undefined = proj4Def ?? undefined;
  if (!sourceDef && epsg != null) {
    sourceDef = proj4DefForEpsg(epsg) ?? undefined;
  }
  if (!sourceDef && wkt) {
    sourceDef = wkt;
  }

  if (!sourceDef) {
    // Unknown CRS — assume it's already lon/lat WGS84 to avoid throwing.
    return identity;
  }

  let transformer: proj4.Converter;
  try {
    transformer = proj4(sourceDef, WGS84);
  } catch {
    return identity;
  }
  return {
    ...(epsg !== undefined ? { epsg } : {}),
    isWgs84: false,
    toWgs84: (x, y) => {
      const out = transformer.forward([x, y]);
      return [out[0]!, out[1]!] as LngLat;
    },
    fromWgs84: (lng, lat) => {
      const out = transformer.inverse([lng, lat]);
      return [out[0]!, out[1]!];
    },
  };
}
