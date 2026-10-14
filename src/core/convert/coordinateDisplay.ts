/**
 * The app-wide coordinate DISPLAY format (Settings › Display › Coordinates,
 * #677): how a position is written wherever the app shows one to a person —
 * the map's centre chip, the info strip, waypoint cards, copy actions.
 *
 * Convert keeps its own millimetre-grade output; this is the field-grade
 * readout, at about a decimetre in every format (#701: six decimals of a
 * degree ≈ 0.11 m). It is ONE string per position: what is shown is what a
 * copy puts on the clipboard, so there is no shorter "narrow-screen" form;
 * a tight cell shrinks its font instead.
 *
 * - `dd`   `46.813944, -71.207611` — signed, "lat, lon", 6 decimals: pastes
 *          straight into every map app's search box. Identical to
 *          `formatLatLng`.
 * - `dms`  `46°48′50.20″N, 71°12′27.40″W` — Convert's `formatAngle`,
 *          compact; 0.01″ ≈ 0.3 m.
 * - `ddm`  `46°48.8366′N, 71°12.4567′W` — ditto; 0.0001′ ≈ 0.2 m.
 * - `utm`  `19T 331586.4 5186854.7` — zone + latitude band, easting,
 *          northing, to the decimetre.
 * - `mgrs` `19T CM 31586 86854` — 1 m (5+5 digits), the finest standard
 *          MGRS reference.
 *
 * Both TRUNCATE, as MGRS requires (a reference names the square the point is
 * in) and as GeographicLib does for UTM, so the two never disagree.
 *
 * UTM and MGRS are defined from 80°S to 84°N (beyond is UPS, which this
 * readout does not draw); outside it they fall back to decimal degrees
 * rather than print a wrong grid reference.
 */
import proj4 from 'proj4';

import { formatAngle } from './format';

export type CoordinateFormat = 'dd' | 'dms' | 'ddm' | 'utm' | 'mgrs';

/** Settings order: decimal degrees first (the default), then the rest. */
export const COORDINATE_FORMATS: readonly {
  value: CoordinateFormat;
  label: string;
  name: string;
}[] = [
  { value: 'dd', label: 'DD', name: 'Decimal degrees' },
  { value: 'dms', label: 'DMS', name: 'Degrees, minutes, seconds' },
  { value: 'ddm', label: 'DDM', name: 'Degrees, decimal minutes' },
  { value: 'utm', label: 'UTM', name: 'UTM' },
  { value: 'mgrs', label: 'MGRS', name: 'MGRS' },
];

export const DEFAULT_COORDINATE_FORMAT: CoordinateFormat = 'dd';

export function isCoordinateFormat(v: unknown): v is CoordinateFormat {
  return COORDINATE_FORMATS.some((f) => f.value === v);
}

/** Decimals of a degree in the DD readout: 1e-6° ≈ 0.11 m (#701). */
export const DD_DECIMALS = 6;
/** Decimals of a second in DMS: 0.01″ ≈ 0.3 m. */
export const DMS_DECIMALS = 2;
/** Decimals of a minute in DDM: 0.0001′ ≈ 0.2 m. */
export const DDM_DECIMALS = 4;

/** Longitude into [-180, 180): the camera reports e.g. -190 past the antimeridian. */
export function wrapLongitude(lon: number): number {
  const w = (((lon + 180) % 360) + 360) % 360;
  return w - 180;
}

/** `toFixed` without a "-0.0000" for a value that rounds to zero. */
function fixed(v: number, decimals: number): string {
  const s = v.toFixed(decimals);
  return Number(s) === 0 ? s.replace(/^-/, '') : s;
}

/** Latitude bands C–X, 8° each from 80°S (I and O skipped); X is 12° (72–84°N). */
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

/** The latitude band letter, or null outside 80°S–84°N. */
export function latitudeBand(lat: number): string | null {
  if (!(lat >= -80 && lat <= 84)) return null;
  return BANDS[Math.min(Math.floor((lat + 80) / 8), BANDS.length - 1)] ?? null;
}

/**
 * The UTM zone of a point, with the two standard exceptions: 32V is widened
 * to 3–12°E over south-west Norway (56–64°N), and over Svalbard (72–84°N)
 * only the odd zones 31, 33, 35 and 37 are used, each widened.
 */
export function utmZone(lat: number, lon: number): number {
  const L = wrapLongitude(lon);
  if (lat >= 56 && lat < 64 && L >= 3 && L < 12) return 32;
  if (lat >= 72 && lat <= 84 && L >= 0 && L < 42) {
    if (L < 9) return 31;
    if (L < 21) return 33;
    if (L < 33) return 35;
    return 37;
  }
  return Math.min(Math.floor((L + 180) / 6) + 1, 60);
}

export interface UtmPosition {
  zone: number;
  band: string;
  south: boolean;
  easting: number;
  northing: number;
}

// One converter per zone and hemisphere, built on first use (at most 120).
const converters = new Map<string, proj4.Converter>();

function converter(zone: number, south: boolean): proj4.Converter {
  const key = `${zone}${south ? 's' : 'n'}`;
  let c = converters.get(key);
  if (c === undefined) {
    c = proj4(
      'WGS84',
      `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`,
    );
    converters.set(key, c);
  }
  return c;
}

/** WGS 84 → UTM, or null outside the UTM latitude range (80°S–84°N). */
export function toUtm(lat: number, lon: number): UtmPosition | null {
  const band = latitudeBand(lat);
  if (band === null || !Number.isFinite(lon)) return null;
  const zone = utmZone(lat, lon);
  const south = lat < 0;
  // The zone's central meridian may sit across the antimeridian from a
  // wrapped longitude (zone 1 for 180°E): unwrap to within 180° of it.
  const cm = -183 + 6 * zone;
  let L = wrapLongitude(lon);
  if (L - cm > 180) L -= 360;
  if (L - cm < -180) L += 360;
  const [easting, northing] = converter(zone, south).forward([L, lat]);
  if (easting === undefined || northing === undefined) return null;
  return { zone, band, south, easting, northing };
}

/** 100 km square column letters, by zone set (zone − 1) mod 3. */
const MGRS_COLUMNS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
/** 100 km square row letters (I and O skipped), offset by 5 in even zones. */
const MGRS_ROWS = 'ABCDEFGHJKLMNPQRSTUV';

/** The two-letter 100 km square of a UTM position (WGS 84 "AA" lettering). */
export function mgrsSquare(zone: number, easting: number, northing: number): string | null {
  const col = Math.floor(easting / 100_000);
  const colLetter = MGRS_COLUMNS[(zone - 1) % 3]?.[col - 1];
  const rowIndex = (Math.floor(northing / 100_000) + (zone % 2 === 0 ? 5 : 0)) % 20;
  const rowLetter = MGRS_ROWS[rowIndex];
  return colLetter !== undefined && rowLetter !== undefined ? colLetter + rowLetter : null;
}

/** "19T CN 30587 86370" (digits per axis: 5 = 1 m, 4 = 10 m), or null outside 80°S–84°N. */
export function toMgrs(lat: number, lon: number, digits = 5): string | null {
  const u = toUtm(lat, lon);
  if (u === null) return null;
  const square = mgrsSquare(u.zone, u.easting, u.northing);
  if (square === null) return null;
  const div = 10 ** (5 - digits);
  // Truncate, never round: an MGRS reference names the square the point is IN.
  const e = Math.floor((Math.floor(u.easting) % 100_000) / div);
  const n = Math.floor((Math.floor(u.northing) % 100_000) / div);
  const pad = (v: number) => String(v).padStart(digits, '0');
  return `${u.zone}${u.band} ${square} ${pad(e)} ${pad(n)}`;
}

/** Metres truncated (never rounded) to the decimetre: 330587.48 → "330587.4". */
function decimetres(v: number): string {
  return (Math.floor(v * 10) / 10).toFixed(1);
}

/** "19T 330587.4 5186370.9", or null outside 80°S–84°N. */
export function formatUtm(lat: number, lon: number): string | null {
  const u = toUtm(lat, lon);
  if (u === null) return null;
  // Truncated like MGRS (and GeographicLib), so the two readouts of one
  // point agree digit for digit: the whole metres are MGRS's digits.
  return `${u.zone}${u.band} ${decimetres(u.easting)} ${decimetres(u.northing)}`;
}

/** A position in the given display format (see the module note). */
export function formatCoordinate(lat: number, lon: number, fmt: CoordinateFormat): string {
  const L = wrapLongitude(lon);
  if (fmt === 'utm') {
    const s = formatUtm(lat, L);
    if (s !== null) return s;
  } else if (fmt === 'mgrs') {
    const s = toMgrs(lat, L, 5);
    if (s !== null) return s;
  } else if (fmt === 'dms' || fmt === 'ddm') {
    const decimals = fmt === 'dms' ? DMS_DECIMALS : DDM_DECIMALS;
    const o = { decimals, compact: true };
    return `${formatAngle(lat, 'lat', fmt, o)}, ${formatAngle(L, 'lon', fmt, o)}`;
  }
  return `${fixed(lat, DD_DECIMALS)}, ${fixed(L, DD_DECIMALS)}`;
}
