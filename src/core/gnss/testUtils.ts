/**
 * Test-only helpers for src/core/gnss: fixture loading, a seeded PRNG for
 * fuzzing, and synthetic streams (checksums always computed, never typed).
 * Excluded from coverage (jest.config.js).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { asciiToBytes, LeWriter } from './bytes';
import { formatNmea } from './nmea';
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

function dm(v: number, degDigits: number): string {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  return `${String(d).padStart(degDigits, '0')}${m.toFixed(7).padStart(10, '0')}`;
}

function hms(tod: number): string {
  const h = Math.floor(tod / 3600);
  const m = Math.floor((tod % 3600) / 60);
  const s = tod % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}${s.toFixed(2).padStart(5, '0')}`;
}

export interface SynthEpoch {
  tod: number;
  lat: number;
  lon: number;
  quality: number;
  sigma: number;
  ageS: number | null;
  date?: string;
}

/** GGA + RMC + GST for one epoch, as a high-precision u-blox would emit them. */
export function nmeaEpoch(e: SynthEpoch): string {
  const lat = `${dm(e.lat, 2)},${e.lat < 0 ? 'S' : 'N'}`;
  const lon = `${dm(e.lon, 3)},${e.lon < 0 ? 'W' : 'E'}`;
  const t = hms(e.tod);
  const mode =
    e.quality === 4
      ? 'R'
      : e.quality === 5
        ? 'F'
        : e.quality === 2
          ? 'D'
          : e.quality === 0
            ? 'N'
            : 'A';
  const gga = formatNmea(
    `GNGGA,${t},${lat},${lon},${e.quality},14,0.8,52.123,M,-31.456,M,${e.ageS === null ? '' : e.ageS.toFixed(1)},${e.ageS === null ? '' : '0007'}`,
  );
  const rmc = formatNmea(
    `GNRMC,${t},${e.quality === 0 ? 'V' : 'A'},${lat},${lon},0.10,45.0,${e.date ?? '011026'},,,${mode},V`,
  );
  const gst = formatNmea(
    `GNGST,${t},0.5,${e.sigma.toFixed(3)},${e.sigma.toFixed(3)},0.0,${e.sigma.toFixed(3)},${e.sigma.toFixed(3)},${(e.sigma * 1.6).toFixed(3)}`,
  );
  return gga + rmc + gst;
}

/**
 * A scripted RTK session along the Plains of Abraham (Québec City), 1 Hz:
 * autonomous → float (σ 0.2 m) → fixed (σ 0.015 m) → corrections age out
 * (RTK still claimed, age climbs past 60 s) → float → autonomous.
 */
export function quebecRtkSession(): { text: string; epochs: SynthEpoch[] } {
  const epochs: SynthEpoch[] = [];
  const start = 12 * 3600;
  for (let i = 0; i < 150; i++) {
    const lat = 46.803 + i * 0.000004;
    const lon = -71.217 + i * 0.000006;
    let quality = 1;
    let sigma = 2.5;
    let ageS: number | null = null;
    if (i >= 10 && i < 30) {
      quality = 5;
      sigma = 0.2;
      ageS = 1;
    } else if (i >= 30 && i < 80) {
      quality = 4;
      sigma = 0.015;
      ageS = 1;
    } else if (i >= 80 && i < 140) {
      // corrections stopped at i = 80: the receiver keeps "fixed" while the age grows.
      quality = i < 125 ? 4 : 5;
      sigma = i < 125 ? 0.02 : 0.3;
      ageS = i - 79;
    }
    epochs.push({ tod: start + i, lat, lon, quality, sigma, ageS });
  }
  return { text: epochs.map(nmeaEpoch).join(''), epochs };
}

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
