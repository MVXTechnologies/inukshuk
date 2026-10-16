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

// ---- a fake NTRIP caster ---------------------------------------------------------------------

/**
 * The single stream a Leica GR30 acting as caster lists (its public
 * sourcetable, 2026-10-16): mixed-case name, empty carrier / lat / lon /
 * nmea / solution fields, Basic auth.
 */
export const GR30_STR = 'STR;Quebec_RTCM3x;MRNF;RTCM 3.x MSM4;;;GPS_GLO_GAL_BDS;;;;;;;;;B;;;none';

/**
 * How a fake caster answers.
 * - `gr30`: a Leica GR30 receiver acting as caster. It answers EVERY request,
 *   Ntrip/2.0 included, in v1: `SOURCETABLE 200 OK` with `Content-Length:89`
 *   (no space after the colon), `ICY 200 OK` before the stream, and its
 *   sourcetable for an unknown mountpoint.
 * - `gr30-icy-headers`: the same, with header lines and a blank line after
 *   `ICY 200 OK` (other receiver casters do this).
 * - `v2`: a strict NTRIP 2.0 caster: HTTP/1.1 replies, chunked transfer.
 */
export type CasterDialect = 'gr30' | 'gr30-icy-headers' | 'v2';

export interface FakeCasterOptions {
  dialect: CasterDialect;
  mountpoint: string;
  user: string;
  pass: string;
  /** STR lines (default: the GR30's). */
  str?: readonly string[];
  /** Send no reply to a stream request until a GGA has come in (some VRS casters). */
  waitForGga?: boolean;
}

function concatAscii(a: string, b: Uint8Array, c: string): Uint8Array {
  const x = asciiToBytes(a);
  const z = asciiToBytes(c);
  const out = new Uint8Array(x.length + b.length + z.length);
  out.set(x, 0);
  out.set(b, x.length);
  out.set(z, x.length + b.length);
  return out;
}

/**
 * A caster as a pure byte machine: `receive(request bytes)` returns what it
 * sends back; `data(rtcm)` frames correction bytes in its dialect. Like the
 * real GR30 it never looks at the request's NTRIP version.
 */
export class FakeCaster {
  /** GGA sentences the client uploaded, in order. */
  readonly ggas: string[] = [];
  /** The parsed request (null until its header block is complete). */
  request: { line: string; headers: Record<string, string> } | null = null;
  streaming = false;
  private buf = '';
  private replied = false;

  constructor(private readonly o: FakeCasterOptions) {}

  get server(): string {
    return this.o.dialect === 'v2' ? 'Fake NTRIP 2 Caster/2.0' : 'GR30 4.83.342/1.0';
  }

  sourcetableBody(): string {
    const str = this.o.str ?? [GR30_STR];
    return `${str.join('\r\n')}\r\nENDSOURCETABLE\r\n`;
  }

  receive(bytes: Uint8Array): Uint8Array {
    this.buf += String.fromCharCode(...bytes);
    if (this.request === null) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return new Uint8Array(0);
      const lines = this.buf.slice(0, end).split('\r\n');
      this.buf = this.buf.slice(end + 4);
      const headers: Record<string, string> = {};
      for (const l of lines.slice(1)) {
        const c = l.indexOf(':');
        headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
      }
      this.request = { line: lines[0] ?? '', headers };
    }
    this.takeGgas();
    if (this.replied) return new Uint8Array(0);
    const mount = /^GET \/(\S*) HTTP\/1\.[01]$/.exec(this.request.line)?.[1];
    if (mount === undefined) return this.reply(this.status(400, 'Bad Request'));
    if (mount === '') return this.reply(this.sourcetable());
    if (mount !== this.o.mountpoint) {
      // v1 casters answer an unknown mountpoint with their sourcetable.
      return this.reply(
        this.o.dialect === 'v2' ? this.status(404, 'Not Found') : this.sourcetable(),
      );
    }
    const auth = this.request.headers.authorization ?? '';
    const expected = Buffer.from(`${this.o.user}:${this.o.pass}`).toString('base64');
    if (auth !== `Basic ${expected}`) return this.reply(this.status(401, 'Unauthorized'));
    if (this.o.waitForGga && this.ggas.length === 0 && !this.request.headers['ntrip-gga'])
      return new Uint8Array(0);
    this.streaming = true;
    if (this.o.dialect === 'v2')
      return this.reply(
        'HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\nServer: Fake NTRIP 2 Caster/2.0\r\n' +
          'Content-Type: gnss/data\r\nTransfer-Encoding: chunked\r\nCache-Control: no-store\r\n\r\n',
      );
    if (this.o.dialect === 'gr30-icy-headers')
      return this.reply(
        `ICY 200 OK\r\nServer: ${this.server}\r\nDate: Fri, 16 Oct 2026 12:00:00 GMT\r\n\r\n`,
      );
    return this.reply('ICY 200 OK\r\n');
  }

  /** Correction bytes as this caster puts them on the wire. */
  data(rtcm: Uint8Array): Uint8Array {
    if (this.o.dialect !== 'v2') return rtcm;
    return concatAscii(`${rtcm.length.toString(16)}\r\n`, rtcm, '\r\n');
  }

  private takeGgas(): void {
    for (let eol = this.buf.indexOf('\n'); eol >= 0; eol = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, eol).replace(/\r$/, '');
      this.buf = this.buf.slice(eol + 1);
      if (line.startsWith('$')) this.ggas.push(line);
    }
  }

  private sourcetable(): string {
    const body = this.sourcetableBody();
    if (this.o.dialect === 'v2') {
      return (
        'HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\nServer: Fake NTRIP 2 Caster/2.0\r\n' +
        'Content-Type: gnss/sourcetable\r\nTransfer-Encoding: chunked\r\n\r\n' +
        `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`
      );
    }
    return (
      `SOURCETABLE 200 OK\r\nServer: ${this.server}\r\nContent-Type: text/plain\r\n` +
      `Content-Length:${body.length}\r\n\r\n${body}`
    );
  }

  private status(code: number, text: string): string {
    const v2 = this.o.dialect === 'v2';
    const proto = v2 ? 'HTTP/1.1' : 'HTTP/1.0';
    const ntrip = v2 ? 'Ntrip-Version: Ntrip/2.0\r\n' : '';
    const auth = code === 401 ? `WWW-Authenticate:Basic realm="/${this.o.mountpoint}"\r\n` : '';
    return `${proto} ${code} ${text}\r\n${ntrip}Server: ${this.server}\r\n${auth}Content-Length:0\r\n\r\n`;
  }

  private reply(s: string): Uint8Array {
    this.replied = true;
    return asciiToBytes(s);
  }
}
