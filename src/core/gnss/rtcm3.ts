/**
 * RTCM 3 framing (CRC-24Q) and the few messages the app reads itself.
 *
 * Corrections are a byte pipe from the caster to the receiver: we frame them
 * to count, classify and validate what flows, and never decode observations.
 * The only content read here:
 * - 1005 / 1006: the reference station's ECEF position (and antenna height),
 *   for "distance to base" and a sanity check of the mountpoint;
 * - 1021 / 1022: the network's declared source → target datum and its
 *   Helmert / Molodensky-Badekas parameters;
 * - 1023 / 1025: the system identification number tying a residual grid or
 *   projection to that 1021/1022.
 * Datum messages are hints shown to the user, never applied (GNSS.md §3.1).
 *
 * Field layouts: RTCM 10403.3 (DF002…DF169). Frame: 0xD3, 6 reserved bits,
 * 10-bit length, payload, CRC-24Q over header + payload.
 */
import { liteEngine } from '../convert/lite';
import { BitReader } from './bytes';

export const RTCM3_PREAMBLE = 0xd3;
export const RTCM3_MAX_PAYLOAD = 1023;

const CRC24Q_POLY = 0x1864cfb;
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 16;
    for (let j = 0; j < 8; j++) {
      c <<= 1;
      if (c & 0x1000000) c ^= CRC24Q_POLY;
    }
    t[i] = c & 0xffffff;
  }
  return t;
})();

/** CRC-24Q over `bytes[start, end)`. */
export function crc24q(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc =
      ((crc << 8) & 0xffffff) ^ (CRC_TABLE[((crc >> 16) ^ (bytes[i] as number)) & 0xff] as number);
  }
  return crc;
}

/** Frame a payload (header + CRC). Throws on a payload over 1023 bytes (caller bug). */
export function encodeRtcm3(payload: Uint8Array): Uint8Array {
  if (payload.length > RTCM3_MAX_PAYLOAD) throw new RangeError('RTCM 3 payload over 1023 bytes');
  const out = new Uint8Array(payload.length + 6);
  out[0] = RTCM3_PREAMBLE;
  out[1] = (payload.length >> 8) & 0x03;
  out[2] = payload.length & 0xff;
  out.set(payload, 3);
  const crc = crc24q(out, 0, 3 + payload.length);
  out[3 + payload.length] = (crc >> 16) & 0xff;
  out[4 + payload.length] = (crc >> 8) & 0xff;
  out[5 + payload.length] = crc & 0xff;
  return out;
}

/** A framed RTCM 3 message, CRC verified by the demuxer. */
export interface Rtcm3Frame {
  /** DF002 message number (0 when the payload is too short to hold one). */
  type: number;
  payload: Uint8Array;
  /** The whole frame, forwarded byte-for-byte to the receiver. */
  raw: Uint8Array;
}

export function rtcm3Type(payload: Uint8Array): number {
  if (payload.length < 2) return 0;
  return ((payload[0] as number) << 4) | ((payload[1] as number) >> 4);
}

/** What a message type is for (statistics and the "corrections" panel). */
export type Rtcm3Class =
  | 'observations'
  | 'msm'
  | 'station'
  | 'antenna'
  | 'ephemeris'
  | 'network'
  | 'datum'
  | 'ssr'
  | 'text'
  | 'biases'
  | 'proprietary'
  | 'other';

export function rtcm3Class(type: number): Rtcm3Class {
  if ((type >= 1001 && type <= 1004) || (type >= 1009 && type <= 1012)) return 'observations';
  if (type >= 1071 && type <= 1137) return 'msm';
  if (type === 1005 || type === 1006 || type === 1032) return 'station';
  if (type === 1007 || type === 1008 || type === 1033) return 'antenna';
  if ((type >= 1019 && type <= 1020) || (type >= 1041 && type <= 1046)) return 'ephemeris';
  if (
    (type >= 1013 && type <= 1018) ||
    (type >= 1030 && type <= 1031) ||
    (type >= 1034 && type <= 1039)
  )
    return 'network';
  if (type >= 1021 && type <= 1027) return 'datum';
  if ((type >= 1057 && type <= 1068) || (type >= 1240 && type <= 1263)) return 'ssr';
  if (type === 1029) return 'text';
  if (type === 1230) return 'biases';
  if (type >= 4001 && type <= 4095) return 'proprietary';
  return 'other';
}

/** 1005/1006: antenna reference point, ECEF metres. */
export interface StationArp {
  type: 1005 | 1006;
  stationId: number;
  /** DF021, "ITRF realization year" (0 = not given). */
  itrfYear: number;
  gps: boolean;
  glonass: boolean;
  galileo: boolean;
  referenceStation: boolean;
  x: number;
  y: number;
  z: number;
  /** 1006 only: antenna height above the marker, metres. */
  antennaHeight?: number;
}

function guarded<T>(f: () => T): T | null {
  try {
    return f();
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

export function decodeStationArp(payload: Uint8Array): StationArp | null {
  return guarded(() => {
    const r = new BitReader(payload);
    const type = r.u(12);
    if (type !== 1005 && type !== 1006) return null;
    const stationId = r.u(12);
    const itrfYear = r.u(6);
    const gps = r.u(1) === 1;
    const glonass = r.u(1) === 1;
    const galileo = r.u(1) === 1;
    const referenceStation = r.u(1) === 1;
    const x = r.s(38) * 1e-4;
    r.skip(2); // DF142 single receiver oscillator, DF001 reserved
    const y = r.s(38) * 1e-4;
    r.skip(2); // DF364 quarter cycle indicator
    const z = r.s(38) * 1e-4;
    const out: StationArp = {
      type,
      stationId,
      itrfYear,
      gps,
      glonass,
      galileo,
      referenceStation,
      x,
      y,
      z,
    };
    if (type === 1006) out.antennaHeight = r.u(16) * 1e-4;
    return out;
  });
}

/** 1021 (Helmert / Abridged Molodenski) and 1022 (Molodenski-Badekas) transformation parameters. */
export interface DatumTransform {
  type: 1021 | 1022;
  sourceName: string;
  targetName: string;
  /** DF147, ties 1023–1027 messages to this transformation. */
  systemId: number;
  /** DF148 bit field: which of 1023–1027 the service also sends. */
  utilizedMessages: number;
  plateNumber: number;
  /** DF150 computation indicator (0 = standard 7-parameter, strict…). */
  computation: number;
  /** DF151 height indicator. */
  heightIndicator: number;
  /** Area of validity: origin + extensions, degrees. */
  area: { lat: number; lon: number; dLat: number; dLon: number };
  /** Translations, metres; rotations, arc-seconds; scale, ppm. */
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
  ds: number;
  /** 1022: the rotation point, ECEF metres. */
  rotationPoint?: { x: number; y: number; z: number };
  /** Source / target ellipsoid semi-axes, metres. */
  source: { a: number; b: number };
  target: { a: number; b: number };
  /** DF214 / DF215 quality indicators (0 = unknown). */
  horizontalQuality: number;
  verticalQuality: number;
}

function text(r: BitReader, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(r.u(8));
  return s;
}

/** Signed field of `n` bits in units of 2 arc-seconds → degrees. */
const twoArcSecDeg = (v: number): number => (v * 2) / 3600;

export function decodeDatumTransform(payload: Uint8Array): DatumTransform | null {
  return guarded(() => {
    const r = new BitReader(payload);
    const type = r.u(12);
    if (type !== 1021 && type !== 1022) return null;
    const sourceName = text(r, r.u(5));
    const targetName = text(r, r.u(5));
    const systemId = r.u(8);
    const utilizedMessages = r.u(10);
    const plateNumber = r.u(5);
    const computation = r.u(4);
    const heightIndicator = r.u(2);
    const area = {
      lat: twoArcSecDeg(r.s(19)),
      lon: twoArcSecDeg(r.s(20)),
      dLat: twoArcSecDeg(r.u(14)),
      dLon: twoArcSecDeg(r.u(14)),
    };
    const dx = r.s(23) * 0.001;
    const dy = r.s(23) * 0.001;
    const dz = r.s(23) * 0.001;
    const rx = r.s(32) * 0.00002;
    const ry = r.s(32) * 0.00002;
    const rz = r.s(32) * 0.00002;
    const ds = r.s(25) * 0.00001;
    let rotationPoint: DatumTransform['rotationPoint'];
    if (type === 1022) {
      rotationPoint = { x: r.s(35) * 0.001, y: r.s(35) * 0.001, z: r.s(35) * 0.001 };
    }
    const source = { a: 6370000 + r.u(24) * 0.001, b: 6350000 + r.u(25) * 0.001 };
    const target = { a: 6370000 + r.u(24) * 0.001, b: 6350000 + r.u(25) * 0.001 };
    const horizontalQuality = r.u(3);
    const verticalQuality = r.u(3);
    const out: DatumTransform = {
      type,
      sourceName,
      targetName,
      systemId,
      utilizedMessages,
      plateNumber,
      computation,
      heightIndicator,
      area,
      dx,
      dy,
      dz,
      rx,
      ry,
      rz,
      ds,
      source,
      target,
      horizontalQuality,
      verticalQuality,
    };
    if (rotationPoint) out.rotationPoint = rotationPoint;
    return out;
  });
}

/** 1023 (residuals, ellipsoidal grid), 1024 (residuals, plane grid), 1025–1027 (projections): just the system id. */
export interface DatumCompanion {
  type: 1023 | 1024 | 1025 | 1026 | 1027;
  systemId: number;
  /** 1025–1027: DF170 projection type. */
  projectionType?: number;
}

export function decodeDatumCompanion(payload: Uint8Array): DatumCompanion | null {
  return guarded(() => {
    const r = new BitReader(payload);
    const type = r.u(12);
    if (type < 1023 || type > 1027) return null;
    const systemId = r.u(8);
    const out: DatumCompanion = { type: type as DatumCompanion['type'], systemId };
    if (type >= 1025) out.projectionType = r.u(6);
    return out;
  });
}

const ECEF_TO_GEO =
  '+proj=pipeline +step +inv +proj=cart +ellps=GRS80 +step +proj=unitconvert +xy_in=rad +xy_out=deg';

/**
 * A station's ECEF position → geographic (GRS80), through the Convert
 * engine's own geocentric step (EPSG method 9602) — for "distance to base".
 */
export function stationLatLon(arp: StationArp): { lat: number; lon: number; h: number } | null {
  const r = liteEngine.transform({ pipeline: ECEF_TO_GEO, coords: [arp.x, arp.y, arp.z], dim: 3 });
  if (!r.ok) return null;
  return { lon: Number(r.coords[0]), lat: Number(r.coords[1]), h: Number(r.coords[2]) };
}
