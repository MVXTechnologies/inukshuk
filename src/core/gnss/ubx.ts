/**
 * u-blox UBX protocol: framing (Fletcher-8 checksum), the four navigation
 * messages DIY kits are read with (NAV-PVT, NAV-HPPOSLLH, NAV-SAT,
 * NAV-STATUS) and the CFG-VALSET builder for their minimal setup.
 *
 * Offsets, scales and configuration keys are from the u-blox F9 HPG
 * interface description (UBX-22008968) and cross-checked against pyubx2's
 * configuration database (BSD-3-Clause) in `ubx.test.ts`.
 *
 * Frame: 0xB5 0x62, class, id, length (U2 LE), payload, CK_A, CK_B — the
 * checksum runs over class … payload.
 */
import { LeReader, LeWriter } from './bytes';

export const UBX_SYNC1 = 0xb5;
export const UBX_SYNC2 = 0x62;

/** Largest payload we accept from a receiver (NAV-SAT with 255 SVs is 3,068 bytes). */
export const UBX_MAX_PAYLOAD = 4096;

export const UBX = {
  NAV_STATUS: [0x01, 0x03],
  NAV_PVT: [0x01, 0x07],
  NAV_HPPOSLLH: [0x01, 0x14],
  NAV_SAT: [0x01, 0x35],
  ACK_ACK: [0x05, 0x01],
  ACK_NAK: [0x05, 0x00],
  CFG_VALSET: [0x06, 0x8a],
} as const;

/** 8-bit Fletcher over `bytes[start, end)`. */
export function ubxChecksum(bytes: Uint8Array, start = 0, end = bytes.length): [number, number] {
  let a = 0;
  let b = 0;
  for (let i = start; i < end; i++) {
    a = (a + (bytes[i] as number)) & 0xff;
    b = (b + a) & 0xff;
  }
  return [a, b];
}

/** A complete UBX frame for (class, id, payload). */
export function encodeUbx(
  cls: number,
  id: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const out = new Uint8Array(payload.length + 8);
  out[0] = UBX_SYNC1;
  out[1] = UBX_SYNC2;
  out[2] = cls;
  out[3] = id;
  out[4] = payload.length & 0xff;
  out[5] = (payload.length >> 8) & 0xff;
  out.set(payload, 6);
  const [a, b] = ubxChecksum(out, 2, 6 + payload.length);
  out[6 + payload.length] = a;
  out[7 + payload.length] = b;
  return out;
}

/** A framed UBX message, checksum verified by the demuxer. */
export interface UbxFrame {
  cls: number;
  id: number;
  payload: Uint8Array;
}

// ---- NAV messages --------------------------------------------------------------------

/** UBX-NAV-PVT fixType. */
export type UbxFixType = 0 | 1 | 2 | 3 | 4 | 5;
/** carrSoln: 0 none, 1 float, 2 fixed. */
export type CarrSoln = 0 | 1 | 2;

export interface NavPvt {
  kind: 'NAV-PVT';
  iTOW: number;
  /** UTC ms since epoch when validDate && validTime, else null. */
  utcMs: number | null;
  validDate: boolean;
  validTime: boolean;
  fullyResolved: boolean;
  fixType: UbxFixType;
  gnssFixOk: boolean;
  diffSoln: boolean;
  carrSoln: CarrSoln;
  numSV: number;
  lon: number;
  lat: number;
  /** Height above ellipsoid, metres. */
  height: number;
  hMSL: number;
  /** 1σ horizontal / vertical accuracy estimates, metres. */
  hAcc: number;
  vAcc: number;
  velN: number;
  velE: number;
  velD: number;
  /** Ground speed, m/s. */
  gSpeed: number;
  /** Heading of motion, degrees. */
  headMot: number;
  pDOP: number;
  invalidLlh: boolean;
  /**
   * Age of the most recent differential correction as the interval u-blox
   * reports ([min, max] seconds), or null when not available.
   */
  correctionAgeS: [number, number] | null;
}

/** NAV-PVT flags3.lastCorrectionAge buckets (interface description table). */
const CORR_AGE: readonly ([number, number] | null)[] = [
  null,
  [0, 1],
  [1, 2],
  [2, 5],
  [5, 10],
  [10, 15],
  [15, 20],
  [20, 30],
  [30, 45],
  [45, 60],
  [60, 90],
  [90, 120],
  [120, Infinity],
];

export function decodeNavPvt(p: Uint8Array): NavPvt | null {
  if (p.length < 92) return null;
  const r = new LeReader(p);
  const valid = r.u1(11);
  const flags = r.u1(21);
  const flags3 = r.u2(78);
  const validDate = (valid & 1) !== 0;
  const validTime = (valid & 2) !== 0;
  const fixType = r.u1(20);
  if (fixType > 5) return null;
  const carr = (flags >> 6) & 3;
  let utcMs: number | null = null;
  if (validDate && validTime) {
    const t = Date.UTC(r.u2(4), r.u1(6) - 1, r.u1(7), r.u1(8), r.u1(9), r.u1(10));
    // nano is a signed correction to the whole-second fields.
    utcMs = t + r.i4(16) / 1e6;
  }
  return {
    kind: 'NAV-PVT',
    iTOW: r.u4(0),
    utcMs,
    validDate,
    validTime,
    fullyResolved: (valid & 4) !== 0,
    fixType: fixType as UbxFixType,
    gnssFixOk: (flags & 1) !== 0,
    diffSoln: (flags & 2) !== 0,
    carrSoln: (carr === 3 ? 0 : carr) as CarrSoln,
    numSV: r.u1(23),
    lon: r.i4(24) * 1e-7,
    lat: r.i4(28) * 1e-7,
    height: r.i4(32) / 1000,
    hMSL: r.i4(36) / 1000,
    hAcc: r.u4(40) / 1000,
    vAcc: r.u4(44) / 1000,
    velN: r.i4(48) / 1000,
    velE: r.i4(52) / 1000,
    velD: r.i4(56) / 1000,
    gSpeed: r.i4(60) / 1000,
    headMot: r.i4(64) * 1e-5,
    pDOP: r.u2(76) * 0.01,
    invalidLlh: (flags3 & 1) !== 0,
    correctionAgeS: CORR_AGE[(flags3 >> 1) & 0x0f] ?? null,
  };
}

export interface NavHpposllh {
  kind: 'NAV-HPPOSLLH';
  iTOW: number;
  invalidLlh: boolean;
  /** Full-precision degrees (standard + high-precision part). */
  lon: number;
  lat: number;
  /** Metres, to 0.1 mm. */
  height: number;
  hMSL: number;
  hAcc: number;
  vAcc: number;
}

export function decodeNavHpposllh(p: Uint8Array): NavHpposllh | null {
  if (p.length < 36) return null;
  const r = new LeReader(p);
  return {
    kind: 'NAV-HPPOSLLH',
    iTOW: r.u4(4),
    invalidLlh: (r.u1(3) & 1) !== 0,
    lon: r.i4(8) * 1e-7 + r.i1(24) * 1e-9,
    lat: r.i4(12) * 1e-7 + r.i1(25) * 1e-9,
    height: r.i4(16) / 1000 + r.i1(26) / 10000,
    hMSL: r.i4(20) / 1000 + r.i1(27) / 10000,
    hAcc: r.u4(28) / 10000,
    vAcc: r.u4(32) / 10000,
  };
}

/** UBX gnssId values. */
export const GNSS_ID: Record<number, string> = {
  0: 'gps',
  1: 'sbas',
  2: 'galileo',
  3: 'beidou',
  4: 'imes',
  5: 'qzss',
  6: 'glonass',
  7: 'navic',
};

export interface NavSatSv {
  gnss: string;
  svId: number;
  /** C/N0, dBHz. */
  cno: number;
  elevDeg: number;
  azDeg: number;
  used: boolean;
  qualityInd: number;
  /** Health: 0 unknown, 1 healthy, 2 unhealthy. */
  health: number;
  diffCorr: boolean;
}

export interface NavSat {
  kind: 'NAV-SAT';
  iTOW: number;
  svs: NavSatSv[];
}

export function decodeNavSat(p: Uint8Array): NavSat | null {
  if (p.length < 8) return null;
  const r = new LeReader(p);
  const n = r.u1(5);
  if (p.length < 8 + 12 * n) return null;
  const svs: NavSatSv[] = [];
  for (let i = 0; i < n; i++) {
    const o = 8 + 12 * i;
    const flags = r.u4(o + 8);
    svs.push({
      gnss: GNSS_ID[r.u1(o)] ?? 'other',
      svId: r.u1(o + 1),
      cno: r.u1(o + 2),
      elevDeg: r.i1(o + 3),
      azDeg: r.i2(o + 4),
      used: (flags & 0x08) !== 0,
      qualityInd: flags & 0x07,
      health: (flags >> 4) & 0x03,
      diffCorr: (flags & 0x40) !== 0,
    });
  }
  return { kind: 'NAV-SAT', iTOW: r.u4(0), svs };
}

export interface NavStatus {
  kind: 'NAV-STATUS';
  iTOW: number;
  gpsFix: number;
  gpsFixOk: boolean;
  diffSoln: boolean;
  diffCorr: boolean;
  carrSolnValid: boolean;
  carrSoln: CarrSoln;
  /** Time to first fix, ms. */
  ttff: number;
  /** Milliseconds since startup / reset. */
  msss: number;
}

export function decodeNavStatus(p: Uint8Array): NavStatus | null {
  if (p.length < 16) return null;
  const r = new LeReader(p);
  const flags = r.u1(5);
  const fixStat = r.u1(6);
  const flags2 = r.u1(7);
  const carr = (flags2 >> 6) & 3;
  return {
    kind: 'NAV-STATUS',
    iTOW: r.u4(0),
    gpsFix: r.u1(4),
    gpsFixOk: (flags & 1) !== 0,
    diffSoln: (flags & 2) !== 0,
    diffCorr: (fixStat & 1) !== 0,
    carrSolnValid: (fixStat & 2) !== 0,
    carrSoln: (carr === 3 ? 0 : carr) as CarrSoln,
    ttff: r.u4(8),
    msss: r.u4(12),
  };
}

export interface UbxAck {
  kind: 'ACK-ACK' | 'ACK-NAK';
  cls: number;
  id: number;
}

export type UbxMessage = NavPvt | NavHpposllh | NavSat | NavStatus | UbxAck;

/** Decode the messages we use; null for any other (or a malformed) frame. */
export function decodeUbx(f: UbxFrame): UbxMessage | null {
  if (f.cls === 0x01) {
    switch (f.id) {
      case 0x07:
        return decodeNavPvt(f.payload);
      case 0x14:
        return decodeNavHpposllh(f.payload);
      case 0x35:
        return decodeNavSat(f.payload);
      case 0x03:
        return decodeNavStatus(f.payload);
      default:
        return null;
    }
  }
  if (f.cls === 0x05 && (f.id === 0x00 || f.id === 0x01) && f.payload.length >= 2) {
    return {
      kind: f.id === 0x01 ? 'ACK-ACK' : 'ACK-NAK',
      cls: f.payload[0] as number,
      id: f.payload[1] as number,
    };
  }
  return null;
}

// ---- configuration (CFG-VALSET) -----------------------------------------------------------

/** CFG-VALSET layers bit mask. */
export const LAYER = { RAM: 1, BBR: 2, FLASH: 4 } as const;

/** Receiver port a configuration applies to. */
export type UbxPort = 'I2C' | 'UART1' | 'UART2' | 'USB' | 'SPI';

const PORT_OFFSET: Record<UbxPort, number> = { I2C: 0, UART1: 1, UART2: 2, USB: 3, SPI: 4 };

/** CFG-MSGOUT key of the I2C variant of each message; the other ports follow at +1…+4. */
const MSGOUT_I2C = {
  UBX_NAV_PVT: 0x20910006,
  UBX_NAV_HPPOSLLH: 0x20910033,
  UBX_NAV_SAT: 0x20910015,
  UBX_NAV_STATUS: 0x2091001a,
  NMEA_GGA: 0x209100ba,
  NMEA_GLL: 0x209100c9,
  NMEA_GSA: 0x209100bf,
  NMEA_GST: 0x209100d3,
  NMEA_GSV: 0x209100c4,
  NMEA_RMC: 0x209100ab,
  NMEA_VTG: 0x209100b0,
  NMEA_ZDA: 0x209100d8,
} as const;

export type MsgOut = keyof typeof MSGOUT_I2C;

/** CFG-MSGOUT-<msg>_<port> key id. */
export function msgOutKey(msg: MsgOut, port: UbxPort): number {
  return MSGOUT_I2C[msg] + PORT_OFFSET[port];
}

/** Port protocol switches: CFG-<port>INPROT-* / OUTPROT-* (no I2C/SPI: kits use UART/USB). */
const PROT_KEYS: Record<'UART1' | 'UART2' | 'USB', { in: number; out: number }> = {
  UART1: { in: 0x10730000, out: 0x10740000 },
  UART2: { in: 0x10750000, out: 0x10760000 },
  USB: { in: 0x10770000, out: 0x10780000 },
};
const PROT_BIT = { UBX: 1, NMEA: 2, RTCM3X: 4 } as const;

export function protKey(
  port: 'UART1' | 'UART2' | 'USB',
  dir: 'in' | 'out',
  prot: keyof typeof PROT_BIT,
): number {
  return PROT_KEYS[port][dir] + PROT_BIT[prot];
}

export const CFG_RATE_MEAS = 0x30210001;
export const CFG_NMEA_HIGHPREC = 0x10930006;

/** Value size from the key id's bits 28–30 (1 = one bit, stored in one byte). */
export function keySize(key: number): 1 | 2 | 4 | 8 {
  const s = (key >>> 28) & 0x7;
  if (s === 1 || s === 2) return 1;
  if (s === 3) return 2;
  if (s === 4) return 4;
  if (s === 5) return 8;
  throw new RangeError(`CFG key 0x${key.toString(16)} has no valid size`);
}

export type CfgValue = number | boolean;

/** UBX-CFG-VALSET payload + frame (version 0, no transaction). At most 64 items per message. */
export function cfgValset(
  items: readonly (readonly [number, CfgValue])[],
  layers: number = LAYER.RAM | LAYER.BBR,
): Uint8Array {
  if (items.length === 0 || items.length > 64)
    throw new RangeError('CFG-VALSET takes 1 to 64 key/value pairs');
  const w = new LeWriter().u1(0).u1(layers).u2(0);
  for (const [key, value] of items) {
    const size = keySize(key);
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    if (!Number.isInteger(v) || v < 0)
      throw new RangeError('CFG values must be non-negative integers');
    w.u4(key);
    if (size === 1) w.u1(v);
    else if (size === 2) w.u2(v);
    else if (size === 4) w.u4(v);
    else w.u8(v);
  }
  return encodeUbx(UBX.CFG_VALSET[0], UBX.CFG_VALSET[1], w.bytes());
}

export interface KitSetup {
  /** The port the phone link (BLE/SPP bridge) is wired to. */
  port: 'UART1' | 'UART2' | 'USB';
  /** Navigation rate, Hz (1–10; 10 Hz is the F9P's RTK limit with these messages). */
  rateHz?: number;
  /** Also emit NMEA (GGA/RMC/GST/GSA) — needed for NTRIP GGA upload and older apps. */
  nmea?: boolean;
  /** Emit NAV-SAT (sky view) once every N epochs; 0 = off. Default 5. */
  satEvery?: number;
  /** Where to store: RAM only (session) or RAM + BBR (survives power cycles). Default both. */
  layers?: number;
}

/**
 * The minimal configuration a DIY u-blox kit (ZED-F9P behind an ESP32
 * BLE/SPP bridge) needs: RTCM3 in, UBX NAV-PVT + HPPOSLLH + STATUS out,
 * optional NMEA with high-precision mode, the measurement rate. Returns the
 * CFG-VALSET frames to write, in order; each one is acknowledged by ACK-ACK.
 */
export function minimalKitConfig(s: KitSetup): Uint8Array[] {
  const rateHz = Math.min(10, Math.max(1, Math.round(s.rateHz ?? 1)));
  const nmea = s.nmea ?? true;
  const satEvery = Math.max(0, Math.min(255, Math.round(s.satEvery ?? 5)));
  const layers = s.layers ?? LAYER.RAM | LAYER.BBR;
  const p = s.port;
  const items: [number, CfgValue][] = [
    [protKey(p, 'in', 'RTCM3X'), true],
    [protKey(p, 'in', 'UBX'), true],
    [protKey(p, 'out', 'UBX'), true],
    [protKey(p, 'out', 'NMEA'), nmea],
    [CFG_RATE_MEAS, Math.round(1000 / rateHz)],
    [msgOutKey('UBX_NAV_PVT', p), 1],
    [msgOutKey('UBX_NAV_HPPOSLLH', p), 1],
    [msgOutKey('UBX_NAV_STATUS', p), 1],
    [msgOutKey('UBX_NAV_SAT', p), satEvery],
    [CFG_NMEA_HIGHPREC, nmea],
    [msgOutKey('NMEA_GGA', p), nmea ? 1 : 0],
    [msgOutKey('NMEA_RMC', p), nmea ? 1 : 0],
    [msgOutKey('NMEA_GST', p), nmea ? 1 : 0],
    [msgOutKey('NMEA_GSA', p), nmea ? 1 : 0],
    // GSV is verbose (up to ~20 sentences an epoch) and NAV-SAT carries the sky view.
    [msgOutKey('NMEA_GSV', p), 0],
    [msgOutKey('NMEA_GLL', p), 0],
    [msgOutKey('NMEA_VTG', p), 0],
  ];
  return [cfgValset(items, layers)];
}
