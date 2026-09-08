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
  /**
   * False when the CRS could NOT be resolved and `toWgs84` is the identity —
   * i.e. the coordinates pass through **unprojected**. Callers must treat that
   * as a failure to place the map, not as lon/lat: a CanTopo sheet whose UTM
   * metres fell through this branch produced a bbox of `{300848, 5202313}`
   * that every downstream validity check rejected, silently (#243).
   */
  resolved: boolean;
  /** Map a native (x, y) — already in (lng, lat) order for geographic CRS — to WGS84. */
  toWgs84(x: number, y: number): LngLat;
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
 * (zones 3–23) and NAD27 north is 267zz (zones 3–22). Every NRCan sheet is one
 * of the NAD83 ones — CanTopo 021G14 is 26919, 092G03 is 26910 — so without
 * this the whole Canadian catalog falls through to the "unknown CRS, assume
 * lon/lat" branch and lands off the coast of Africa.
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

  /** Pass-through. `resolved` says whether that is the answer or the fallback. */
  const identity = (resolved: boolean): Reprojector => ({
    epsg,
    isWgs84: true,
    resolved,
    toWgs84: (x, y) => [x, y],
  });

  if (epsg === 4326) return identity(true);

  let sourceDef: string | undefined = proj4Def ?? undefined;
  if (!sourceDef && epsg != null) {
    sourceDef = proj4DefForEpsg(epsg) ?? undefined;
  }
  if (!sourceDef && wkt) {
    sourceDef = wkt;
  }

  // Unknown CRS — pass coordinates through rather than throw, but say so.
  if (!sourceDef) return identity(false);

  let transformer: proj4.Converter;
  try {
    transformer = proj4(sourceDef, WGS84);
  } catch {
    return identity(false);
  }
  return {
    epsg,
    isWgs84: false,
    resolved: true,
    toWgs84: (x, y) => {
      const out = transformer.forward([x, y]);
      return [out[0]!, out[1]!] as LngLat;
    },
  };
}

// --- LGIDict /Projection ------------------------------------------------------

/**
 * The parameters an OGC-Best-Practice `/Projection` dictionary carries. This is
 * NOT a WKT and NOT an EPSG code: TerraGo writes the projection out as a
 * GCTP-style two-letter type plus its parameters, all as PDF strings.
 *
 * A real NRCan CanTopo map frame (021G14, Canterbury NB) reads:
 *
 *   << /CentralMeridian (-69.00000) /Datum (NAR) /FalseEasting (500000.00000)
 *      /FalseNorthing (0.00000) /OriginLatitude (0.00000) /ProjectionType (TC)
 *      /ScaleFactor (0.99960) /Type /Projection >>
 *
 * — i.e. NAD83 / UTM zone 19N, spelled out as a Transverse Mercator. Nothing in
 * it matches an EPSG code or a "UTM zone" phrase, which is why all 2,234
 * CanTopo sheets used to fall through un-reprojected, in metres (#243).
 */
export interface LgiProjection {
  /** `/ProjectionType` — a GCTP-style code (`TC`, `LE`, `UT`) or `GEOGRAPHIC`. */
  projectionType?: string;
  /** `/Datum` — a NIMA/DMA code: `WE` (WGS 84), `NAR` (NAD83), `NAS` (NAD27). */
  datum?: string;
  /** `/Zone` + `/Hemisphere`, present on `/ProjectionType (UT)` frames. */
  zone?: number;
  hemisphere?: string;
  centralMeridian?: number;
  originLatitude?: number;
  scaleFactor?: number;
  falseEasting?: number;
  falseNorthing?: number;
  standardParallelOne?: number;
  standardParallelTwo?: number;
  /** `/WKT`, when a producer writes one instead of the parameters. */
  wkt?: string;
  /** `/EPSG`, when a producer writes an explicit code. */
  epsg?: number;
}

/** A CRS resolved from an LGIDict `/Projection` — or not, see `proj4Def`. */
export interface ResolvedCrs {
  /**
   * proj4 source definition, or `null` when we cannot place this projection.
   * `null` is the honest answer and the caller must surface it: assuming
   * lon/lat instead is exactly what made #243 invisible.
   */
  proj4Def: string | null;
  /** EPSG code, when the parameters identify a standard one. */
  epsg?: number;
  /** Human-readable CRS description, for diagnostics and the Library card. */
  label: string;
}

/** Display names for the GCTP-style `/ProjectionType` codes we may meet. */
const PROJECTION_NAMES: Record<string, string> = {
  AC: 'Albers Equal Area',
  AL: 'Azimuthal Equidistant',
  CP: 'Equidistant Cylindrical',
  GEODETIC: 'Geographic lon/lat',
  GEOGRAPHIC: 'Geographic lon/lat',
  LE: 'Lambert Conformal Conic',
  LL: 'Geographic lon/lat',
  MC: 'Mercator',
  MH: 'Miller Cylindrical',
  OC: 'Oblique Mercator',
  PG: 'Polar Stereographic',
  PH: 'Polyconic',
  SA: 'Sinusoidal',
  SD: 'Stereographic',
  TC: 'Transverse Mercator',
  UT: 'UTM',
  VA: 'Van der Grinten',
};

interface DatumInfo {
  /** Display name. */
  name: string;
  /** proj4 datum fragment. */
  proj4: string;
  /** EPSG of this datum's geographic CRS. */
  geographicEpsg: number;
  /** EPSG base for a northern UTM zone on this datum (add the zone number). */
  utmNorthBase: number;
  /** EPSG base for a southern UTM zone, when the datum publishes any. */
  utmSouthBase?: number;
}

const WGS84_DATUM: DatumInfo = {
  name: 'WGS 84',
  proj4: '+datum=WGS84',
  geographicEpsg: 4326,
  utmNorthBase: 32600,
  utmSouthBase: 32700,
};

/**
 * Resolve a NIMA/DMA datum code. Codes are prefixes: NRCan writes `NAR`, and
 * regional realizations append a suffix (`NAR-C` for the Canadian one).
 *
 * An unrecognized code falls back to WGS 84 rather than refusing the sheet: a
 * datum shift is at most a couple of hundred metres, where refusing means not
 * drawing the map at all. The label keeps the raw code so a mismatch is still
 * visible in a report.
 */
export function datumInfoForCode(code: string | undefined): DatumInfo {
  const c = (code ?? '').trim().toUpperCase();
  if (c.startsWith('NAR')) {
    return { name: 'NAD83', proj4: '+datum=NAD83', geographicEpsg: 4269, utmNorthBase: 26900 };
  }
  if (c.startsWith('NAS')) {
    return { name: 'NAD27', proj4: '+datum=NAD27', geographicEpsg: 4267, utmNorthBase: 26700 };
  }
  if (c === '' || c.startsWith('WE') || c.startsWith('WGS')) return WGS84_DATUM;
  return { ...WGS84_DATUM, name: c };
}

/** An EPSG code, but only if we can actually build a proj4 def for it. */
function definedEpsg(epsg: number): number | undefined {
  return proj4DefForEpsg(epsg) === null ? undefined : epsg;
}

/**
 * The UTM zone a Transverse Mercator parameter set spells out, or null when it
 * is a plain TM. UTM is exactly `k=0.9996`, false easting 500 000 m, origin on
 * the equator, false northing 0 (north) or 10 000 000 (south), and a central
 * meridian on the 6° zone grid — which is how NRCan writes `/ProjectionType
 * (TC)` for every CanTopo sheet, from zone 7 (Yukon) to zone 22 (Labrador).
 */
export function utmZoneFromTmParams(p: {
  centralMeridian: number;
  scaleFactor?: number;
  falseEasting?: number;
  falseNorthing?: number;
  originLatitude?: number;
}): { zone: number; north: boolean } | null {
  const k = p.scaleFactor ?? 1;
  const fe = p.falseEasting ?? 0;
  const fn = p.falseNorthing ?? 0;
  const lat0 = p.originLatitude ?? 0;
  if (Math.abs(k - 0.9996) > 1e-9 || Math.abs(fe - 500000) > 1e-6 || Math.abs(lat0) > 1e-9) {
    return null;
  }
  const north = Math.abs(fn) < 1e-6;
  if (!north && Math.abs(fn - 10000000) > 1e-6) return null;
  const zone = (p.centralMeridian + 183) / 6;
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return null;
  return { zone, north };
}

/** proj4 def + EPSG (when standard) for a UTM zone on a given datum. */
function utmCrs(zone: number, north: boolean, datum: DatumInfo): ResolvedCrs {
  const base = north ? datum.utmNorthBase : datum.utmSouthBase;
  const epsg = base === undefined ? undefined : definedEpsg(base + zone);
  const suffix = epsg === undefined ? '' : ` (EPSG:${epsg})`;
  return {
    proj4Def: `+proj=utm +zone=${zone} ${north ? '' : '+south '}${datum.proj4} +units=m +no_defs`,
    ...(epsg === undefined ? {} : { epsg }),
    label: `${datum.name} / UTM zone ${zone}${north ? 'N' : 'S'}${suffix}`,
  };
}

/** The CRS string an unplaceable projection is reported under. */
function describeUnknown(type: string, datum: DatumInfo): string {
  const name = PROJECTION_NAMES[type];
  const projection = type === '' ? 'unnamed projection' : (name ?? `projection "${type}"`);
  return `${projection}, datum ${datum.name}`;
}

/**
 * Resolve an LGIDict `/Projection` dictionary into something proj4 can use.
 *
 * Supported: geographic, UTM (`UT`), Transverse Mercator (`TC` — recognized as
 * UTM when its parameters say so, which keeps a sheet straddling a zone
 * boundary on its own central meridian), Lambert Conformal Conic (`LE`),
 * Mercator (`MC`) and Albers (`AC`). Anything else returns `proj4Def: null`
 * **with a label**, so the map can say which projection it cannot place
 * instead of quietly drawing nothing.
 */
export function resolveLgiProjection(p: LgiProjection): ResolvedCrs {
  const datum = datumInfoForCode(p.datum);
  const type = (p.projectionType ?? '').trim().toUpperCase();

  // An explicit EPSG, or a WKT naming one, wins over the parameters.
  const explicit = p.epsg ?? epsgFromText(p.wkt);
  if (explicit !== undefined) {
    const def = proj4DefForEpsg(explicit) ?? p.wkt ?? null;
    if (def !== null) return { proj4Def: def, epsg: explicit, label: `EPSG:${explicit}` };
  }

  if (type.startsWith('GEOG') || type.startsWith('GEOD') || type === 'LL') {
    return {
      proj4Def: proj4DefForEpsg(datum.geographicEpsg) ?? WGS84,
      epsg: datum.geographicEpsg,
      label: `Geographic lon/lat (${datum.name})`,
    };
  }

  if (type === 'UT' && p.zone !== undefined && Number.isFinite(p.zone)) {
    return utmCrs(p.zone, !/^S/i.test(p.hemisphere ?? 'N'), datum);
  }

  const cm = p.centralMeridian;
  const fe = p.falseEasting ?? 0;
  const fn = p.falseNorthing ?? 0;
  const sp1 = p.standardParallelOne;
  const sp2 = p.standardParallelTwo;

  if ((type === 'TC' || type === 'TM') && cm !== undefined) {
    const utm = utmZoneFromTmParams({
      centralMeridian: cm,
      scaleFactor: p.scaleFactor ?? 1,
      falseEasting: fe,
      falseNorthing: fn,
      originLatitude: p.originLatitude ?? 0,
    });
    if (utm) return utmCrs(utm.zone, utm.north, datum);
    return {
      proj4Def:
        `+proj=tmerc +lat_0=${p.originLatitude ?? 0} +lon_0=${cm} ` +
        `+k_0=${p.scaleFactor ?? 1} +x_0=${fe} +y_0=${fn} ${datum.proj4} +units=m +no_defs`,
      label: `Transverse Mercator (${datum.name}, CM ${cm}°)`,
    };
  }

  if ((type === 'LE' || type === 'LCC') && sp1 !== undefined && cm !== undefined) {
    return {
      proj4Def:
        `+proj=lcc +lat_1=${sp1} +lat_2=${sp2 ?? sp1} +lat_0=${p.originLatitude ?? sp1} ` +
        `+lon_0=${cm} +x_0=${fe} +y_0=${fn} ${datum.proj4} +units=m +no_defs`,
      label: `Lambert Conformal Conic (${datum.name}, CM ${cm}°)`,
    };
  }

  if (type === 'AC' && sp1 !== undefined && sp2 !== undefined && cm !== undefined) {
    return {
      proj4Def:
        `+proj=aea +lat_1=${sp1} +lat_2=${sp2} +lat_0=${p.originLatitude ?? 0} ` +
        `+lon_0=${cm} +x_0=${fe} +y_0=${fn} ${datum.proj4} +units=m +no_defs`,
      label: `Albers Equal Area (${datum.name}, CM ${cm}°)`,
    };
  }

  if (type === 'MC' && cm !== undefined) {
    return {
      proj4Def:
        `+proj=merc +lat_ts=${sp1 ?? p.originLatitude ?? 0} +lon_0=${cm} ` +
        `+x_0=${fe} +y_0=${fn} ${datum.proj4} +units=m +no_defs`,
      label: `Mercator (${datum.name}, CM ${cm}°)`,
    };
  }

  // A WKT we could not turn into an EPSG is still worth handing to proj4.
  if (p.wkt) return { proj4Def: p.wkt, label: describeUnknown(type, datum) };

  return { proj4Def: null, label: describeUnknown(type, datum) };
}
