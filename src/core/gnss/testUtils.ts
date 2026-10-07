/**
 * Test-only helpers for src/core/gnss: fixture loading, a seeded PRNG for
 * fuzzing, and synthetic streams (checksums always computed, never typed).
 * Excluded from coverage (jest.config.js).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { asciiToBytes, LeWriter } from './bytes';
import type { GnssFix } from './fix';
import type { FixKind } from './quality';
import { encodeUbx } from './ubx';

const FIX = join(__dirname, 'fixtures');

/** A fixture capture with its leading "# …" comment header removed (gpsd logs). */
export function loadCapture(rel: string): Uint8Array {
  const b = new Uint8Array(readFileSync(join(FIX, rel)));
  let i = 0;
  while (b[i] === 0x23) {
    while (i < b.length && b[i] !== 0x0a) i++;
    i++;
  }
  return b.subarray(i);
}

export function loadText(rel: string): string {
  return readFileSync(join(FIX, rel), 'latin1');
}

/** mulberry32: deterministic random numbers for reproducible fuzzing. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split bytes into random chunks of 1…max bytes. */
export function randomChunks(b: Uint8Array, rnd: () => number, max = 64): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < b.length) {
    const n = 1 + Math.floor(rnd() * max);
    out.push(b.subarray(i, i + n));
    i += n;
  }
  return out;
}

/** Copy with `n` random bytes overwritten with random values. */
export function corrupt(b: Uint8Array, rnd: () => number, n: number): Uint8Array {
  const out = b.slice();
  for (let k = 0; k < n; k++) out[Math.floor(rnd() * out.length)] = Math.floor(rnd() * 256);
  return out;
}

export { nmeaEpoch, quebecRtkSession, type SynthEpoch } from './sim';

export const bytes = asciiToBytes;

/** A NAV-PVT payload (92 bytes) from readable fields. */
export function navPvtPayload(p: {
  iTOW?: number;
  date?: [number, number, number, number, number, number];
  valid?: number;
  nano?: number;
  fixType?: number;
  flags?: number;
  numSV?: number;
  lat?: number;
  lon?: number;
  height?: number;
  hMSL?: number;
  hAcc?: number;
  vAcc?: number;
  pDOP?: number;
  flags3?: number;
}): Uint8Array {
  const [y, mo, d, h, mi, s] = p.date ?? [2026, 10, 1, 12, 0, 0];
  const w = new LeWriter()
    .u4(p.iTOW ?? 1000)
    .u2(y)
    .u1(mo)
    .u1(d)
    .u1(h)
    .u1(mi)
    .u1(s)
    .u1(p.valid ?? 0x07)
    .u4(25)
    .u4((p.nano ?? 0) >>> 0)
    .u1(p.fixType ?? 3)
    .u1(p.flags ?? 0x01)
    .u1(0xea)
    .u1(p.numSV ?? 20)
    .u4(Math.round((p.lon ?? -71.217) * 1e7) >>> 0)
    .u4(Math.round((p.lat ?? 46.803) * 1e7) >>> 0)
    .u4(Math.round((p.height ?? 60) * 1000) >>> 0)
    .u4(Math.round((p.hMSL ?? 91.5) * 1000) >>> 0)
    .u4(Math.round((p.hAcc ?? 1.5) * 1000))
    .u4(Math.round((p.vAcc ?? 2.0) * 1000))
    .u4(0)
    .u4(0)
    .u4(0)
    .u4(100)
    .u4(4500000)
    .u4(200)
    .u4(100000)
    .u2(Math.round((p.pDOP ?? 1.2) * 100))
    .u2(p.flags3 ?? 0)
    .u4(0)
    .u4(0)
    .u2(0)
    .u2(0);
  return w.bytes();
}

export function navPvtFrame(p: Parameters<typeof navPvtPayload>[0]): Uint8Array {
  return encodeUbx(0x01, 0x07, navPvtPayload(p));
}

/** A complete fix (RTK fixed at Québec City by default) for UI-model tests. */
export function fixOf(kind: FixKind, over: Partial<GnssFix> = {}): GnssFix {
  return {
    timeMs: 1_800_000_000_000,
    lat: 46.8,
    lon: -71.2,
    hEll: 20,
    hMsl: 51,
    geoidSep: -31,
    kind,
    sigmaLat: null,
    sigmaLon: null,
    sigmaV: null,
    accuracy: { h95: 0.014, v95: 0.026, basis: 'receiver' },
    hdop: 0.8,
    pdop: 1.2,
    vdop: 1,
    satsUsed: 14,
    satsInView: 28,
    correctionAgeS: 1,
    baseId: '0007',
    correctionsInput: null,
    speedMps: 1.2,
    courseDeg: 45,
    protocol: 'nmea',
    ...over,
  };
}
