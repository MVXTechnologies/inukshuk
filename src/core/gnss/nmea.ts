/**
 * NMEA 0183 sentence parser for external GNSS receivers: GGA, RMC, GSA, GSV,
 * GST, VTG and ZDA, any talker (GP, GL, GA, GB/BD, GQ, GI, GN…).
 *
 * One line in, a typed message or a typed rejection out — never a throw.
 * Framing a byte stream into lines is `stream.ts`'s job; assembling the
 * sentences of one epoch into a fix is `fix.ts`'s.
 *
 * Empty fields are `null`, never 0: an empty HDOP is "not reported", not
 * "perfect geometry".
 */

/** Which constellation a talker ID speaks for. */
export type Constellation =
  'gps' | 'glonass' | 'galileo' | 'beidou' | 'qzss' | 'navic' | 'multi' | 'other';

const TALKERS: Record<string, Constellation> = {
  GP: 'gps',
  GL: 'glonass',
  GA: 'galileo',
  GB: 'beidou',
  BD: 'beidou',
  GQ: 'qzss',
  QZ: 'qzss',
  GI: 'navic',
  GN: 'multi',
};

export function constellationOf(talker: string): Constellation {
  return TALKERS[talker] ?? 'other';
}

/** NMEA 4.10 GSA/GSV system IDs. */
const SYSTEM_IDS: Record<number, Constellation> = {
  1: 'gps',
  2: 'glonass',
  3: 'galileo',
  4: 'beidou',
  5: 'qzss',
  6: 'navic',
};

export function constellationOfSystemId(id: number | null): Constellation | null {
  return id === null ? null : (SYSTEM_IDS[id] ?? 'other');
}

interface Base {
  talker: string;
}

/** GGA fix quality: 0 invalid … 8 simulation (the raw indicator, mapped by `quality.ts`). */
export interface Gga extends Base {
  type: 'GGA';
  /** UTC seconds since midnight. */
  tod: number | null;
  lat: number | null;
  lon: number | null;
  quality: number;
  satsUsed: number | null;
  hdop: number | null;
  /** Altitude above the receiver's geoid model (MSL), metres. */
  altMsl: number | null;
  /** Geoid separation N (ellipsoid h = altMsl + N), metres. */
  geoidSep: number | null;
  /** Age of differential corrections, seconds. */
  ageS: number | null;
  baseId: string | null;
}

export interface Rmc extends Base {
  type: 'RMC';
  tod: number | null;
  /** Status A = valid. */
  valid: boolean;
  lat: number | null;
  lon: number | null;
  speedMps: number | null;
  courseDeg: number | null;
  /** UTC date. */
  date: { y: number; m: number; d: number } | null;
  /** NMEA 2.3+ mode indicator (A, D, E, F, R, N, …). */
  mode: string | null;
}

export interface Gsa extends Base {
  type: 'GSA';
  /** 1 = no fix, 2 = 2D, 3 = 3D. */
  fixType: number | null;
  prns: number[];
  pdop: number | null;
  hdop: number | null;
  vdop: number | null;
  /** NMEA 4.10 system ID (1 GPS … 6 NavIC), else null. */
  systemId: number | null;
}

export interface GsvSat {
  prn: number;
  elevDeg: number | null;
  azDeg: number | null;
  snr: number | null;
}

export interface Gsv extends Base {
  type: 'GSV';
  total: number;
  index: number;
  inView: number;
  sats: GsvSat[];
  /** NMEA 4.10 signal ID, else null. */
  signalId: string | null;
}

/** GST pseudorange error statistics: the receiver's own 1σ position errors, metres. */
export interface Gst extends Base {
  type: 'GST';
  tod: number | null;
  rms: number | null;
  semiMajor: number | null;
  semiMinor: number | null;
  orientDeg: number | null;
  sigmaLat: number | null;
  sigmaLon: number | null;
  sigmaAlt: number | null;
}

export interface Vtg extends Base {
  type: 'VTG';
  courseTrue: number | null;
  courseMag: number | null;
  speedMps: number | null;
  mode: string | null;
}

export interface Zda extends Base {
  type: 'ZDA';
  tod: number | null;
  date: { y: number; m: number; d: number } | null;
}

export type NmeaMessage = Gga | Rmc | Gsa | Gsv | Gst | Vtg | Zda;
export type NmeaType = NmeaMessage['type'];

export type NmeaReject =
  | 'format'
  | 'checksum'
  | 'no-checksum'
  /** A well-formed sentence of a type we don't use (GLL, GNS, proprietary…). */
  | 'unsupported';

export type NmeaResult =
  { ok: true; msg: NmeaMessage } | { ok: false; reason: NmeaReject; sentence?: string };

const KNOTS_TO_MPS = 1852 / 3600;

/** XOR of the characters between '$' and '*'. */
export function nmeaChecksum(body: string): number {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i) & 0xff;
  return c;
}

/** "$" + body + "*HH" + CRLF. */
export function formatNmea(body: string): string {
  return `$${body}*${nmeaChecksum(body).toString(16).toUpperCase().padStart(2, '0')}\r\n`;
}

/** A sentence's fields; a missing trailing field reads as ''. */
interface Fields {
  n: number;
  at(i: number): string;
}

function num(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  // Number('0x1A'), Number('1e3'), Number(' ') are all "numbers" to JS; NMEA fields are plain decimals.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  return Number(t);
}

function int(s: string): number | null {
  const n = num(s);
  return n !== null && Number.isInteger(n) ? n : null;
}

/** "hhmmss.ss" → seconds since midnight. */
export function parseTod(s: string | undefined): number | null {
  if (!s || !/^\d{6}(\.\d+)?$/.test(s)) return null;
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4));
  const sec = Number(s.slice(4));
  if (h > 23 || m > 59 || sec >= 61) return null;
  return h * 3600 + m * 60 + sec;
}

/** "ddmm.mmmm" + hemisphere → signed degrees. */
export function parseLatLon(
  v: string | undefined,
  hemi: string | undefined,
  isLon: boolean,
): number | null {
  if (!v || !hemi) return null;
  const degDigits = isLon ? 3 : 2;
  if (!new RegExp(`^\\d{${degDigits}}\\d{2}(\\.\\d+)?$`).test(v)) return null;
  const deg = Number(v.slice(0, degDigits));
  const min = Number(v.slice(degDigits));
  if (min >= 60) return null;
  const val = deg + min / 60;
  if (val > (isLon ? 180 : 90)) return null;
  const h = hemi.toUpperCase();
  if (isLon ? h !== 'E' && h !== 'W' : h !== 'N' && h !== 'S') return null;
  return h === 'S' || h === 'W' ? -val : val;
}

function ddmmyy(s: string): { y: number; m: number; d: number } | null {
  if (!s || !/^\d{6}$/.test(s)) return null;
  const d = Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4));
  const yy = Number(s.slice(4, 6));
  if (d < 1 || d > 31 || m < 1 || m > 12) return null;
  // RMC carries a 2-digit year; GNSS receivers in use today report 20xx.
  return { y: 2000 + yy, m, d };
}

function charField(s: string): string | null {
  return s && /^[A-Z]$/i.test(s) ? s.toUpperCase() : null;
}

/** Split and verify a sentence. Returns the fields (address first) or a rejection. */
function frame(line: string, requireChecksum: boolean): string[] | NmeaReject {
  const s = line.replace(/[\r\n]+$/, '');
  if (s.length < 7 || s[0] !== '$') return 'format';
  const star = s.lastIndexOf('*');
  let body: string;
  if (star >= 0) {
    body = s.slice(1, star);
    const ck = s.slice(star + 1);
    if (!/^[0-9A-Fa-f]{2}$/.test(ck)) return 'format';
    if (parseInt(ck, 16) !== nmeaChecksum(body)) return 'checksum';
  } else {
    if (requireChecksum) return 'no-checksum';
    body = s.slice(1);
  }
  // Printable ASCII only between $ and *.
  if (!/^[\x20-\x7e]+$/.test(body) || body.includes('$')) return 'format';
  const f = body.split(',');
  const addr = f[0] as string;
  if (!/^[A-Z0-9]{3,6}$/.test(addr)) return 'format';
  return f;
}

export interface ParseOptions {
  /** Reject sentences without "*HH" (default true). */
  requireChecksum?: boolean;
}

/** Parse one NMEA line (with or without CR/LF). Never throws. */
export function parseNmea(line: string, opts: ParseOptions = {}): NmeaResult {
  const f = frame(line, opts.requireChecksum ?? true);
  if (typeof f === 'string') return { ok: false, reason: f };
  const addr = f[0] as string;
  if (addr[0] === 'P' || addr.length !== 5) {
    return { ok: false, reason: 'unsupported', sentence: addr };
  }
  const talker = addr.slice(0, 2);
  const type = addr.slice(2);
  const fields: Fields = { n: f.length, at: (i) => f[i] ?? '' };
  switch (type) {
    case 'GGA':
      return gga(talker, fields);
    case 'RMC':
      return rmc(talker, fields);
    case 'GSA':
      return gsa(talker, fields);
    case 'GSV':
      return gsv(talker, fields);
    case 'GST':
      return gst(talker, fields);
    case 'VTG':
      return vtg(talker, fields);
    case 'ZDA':
      return zda(talker, fields);
    default:
      return { ok: false, reason: 'unsupported', sentence: addr };
  }
}

function gga(talker: string, f: Fields): NmeaResult {
  if (f.n < 15) return { ok: false, reason: 'format' };
  const quality = int(f.at(6));
  if (quality === null || quality < 0 || quality > 9) return { ok: false, reason: 'format' };
  const base = f.at(14).trim();
  return {
    ok: true,
    msg: {
      type: 'GGA',
      talker,
      tod: parseTod(f.at(1)),
      lat: parseLatLon(f.at(2), f.at(3), false),
      lon: parseLatLon(f.at(4), f.at(5), true),
      quality,
      satsUsed: int(f.at(7)),
      hdop: num(f.at(8)),
      altMsl: num(f.at(9)),
      geoidSep: num(f.at(11)),
      ageS: num(f.at(13)),
      baseId: base === '' ? null : base,
    },
  };
}

function rmc(talker: string, f: Fields): NmeaResult {
  if (f.n < 10) return { ok: false, reason: 'format' };
  const knots = num(f.at(7));
  return {
    ok: true,
    msg: {
      type: 'RMC',
      talker,
      tod: parseTod(f.at(1)),
      valid: f.at(2) === 'A',
      lat: parseLatLon(f.at(3), f.at(4), false),
      lon: parseLatLon(f.at(5), f.at(6), true),
      speedMps: knots === null ? null : knots * KNOTS_TO_MPS,
      courseDeg: num(f.at(8)),
      date: ddmmyy(f.at(9)),
      mode: charField(f.at(12)),
    },
  };
}

function gsa(talker: string, f: Fields): NmeaResult {
  if (f.n < 18) return { ok: false, reason: 'format' };
  const prns: number[] = [];
  for (let i = 3; i <= 14; i++) {
    const p = int(f.at(i));
    if (p !== null) prns.push(p);
  }
  return {
    ok: true,
    msg: {
      type: 'GSA',
      talker,
      fixType: int(f.at(2)),
      prns,
      pdop: num(f.at(15)),
      hdop: num(f.at(16)),
      vdop: num(f.at(17)),
      systemId: f.n > 18 ? int(f.at(18)) : null,
    },
  };
}

function gsv(talker: string, f: Fields): NmeaResult {
  const total = int(f.at(1));
  const index = int(f.at(2));
  const inView = int(f.at(3));
  if (total === null || index === null || inView === null || index < 1 || index > total) {
    return { ok: false, reason: 'format' };
  }
  const rest = f.n - 4;
  const signal = rest % 4 === 1 ? f.at(f.n - 1).trim() : null;
  const blocks = Math.floor(rest / 4);
  const sats: GsvSat[] = [];
  for (let b = 0; b < blocks; b++) {
    const o = 4 + b * 4;
    const prn = int(f.at(o));
    if (prn === null) continue;
    sats.push({ prn, elevDeg: num(f.at(o + 1)), azDeg: num(f.at(o + 2)), snr: num(f.at(o + 3)) });
  }
  return {
    ok: true,
    msg: {
      type: 'GSV',
      talker,
      total,
      index,
      inView,
      sats,
      signalId: signal === '' ? null : signal,
    },
  };
}

function gst(talker: string, f: Fields): NmeaResult {
  if (f.n < 9) return { ok: false, reason: 'format' };
  return {
    ok: true,
    msg: {
      type: 'GST',
      talker,
      tod: parseTod(f.at(1)),
      rms: num(f.at(2)),
      semiMajor: num(f.at(3)),
      semiMinor: num(f.at(4)),
      orientDeg: num(f.at(5)),
      sigmaLat: num(f.at(6)),
      sigmaLon: num(f.at(7)),
      sigmaAlt: num(f.at(8)),
    },
  };
}

function vtg(talker: string, f: Fields): NmeaResult {
  if (f.n < 9) return { ok: false, reason: 'format' };
  // NMEA 2.3+: course T, "T", course M, "M", knots, "N", km/h, "K", mode.
  const kmh = num(f.at(7));
  const knots = num(f.at(5));
  return {
    ok: true,
    msg: {
      type: 'VTG',
      talker,
      courseTrue: num(f.at(1)),
      courseMag: num(f.at(3)),
      speedMps: kmh !== null ? kmh / 3.6 : knots !== null ? knots * KNOTS_TO_MPS : null,
      mode: charField(f.at(9)),
    },
  };
}

function zda(talker: string, f: Fields): NmeaResult {
  if (f.n < 5) return { ok: false, reason: 'format' };
  const d = int(f.at(2));
  const m = int(f.at(3));
  const y = int(f.at(4));
  const date =
    d !== null && m !== null && y !== null && d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1980
      ? { y, m, d }
      : null;
  return { ok: true, msg: { type: 'ZDA', talker, tod: parseTod(f.at(1)), date } };
}
