/**
 * A recorded trail, whole, for Share live (2.7.0 #712): every point with its
 * position, elevation and time, and the recording's segments, as one compact
 * text that is split across as many `lpt` part records as it needs (each
 * within the per-op limit) and joined again on arrival.
 *
 * **Exact round trip** of what a GPX holds (`buildGpx` writes coordinates to
 * 7 decimals, elevation to 2, times to the millisecond): latitude and
 * longitude are integers of 1e-7°, elevation of 1 cm, time of 1 ms, each
 * column delta-coded as zig-zag varints in the encoded-polyline alphabet
 * (`?`–`~`, 5 bits per character). A missing elevation or time is its own
 * code, so a point without one comes back without one.
 *
 * Measured on a 20,000-point 1 Hz run (`trackCodec.test.ts`): 8.3 characters
 * per point, so one part of {@link PART_CHARS} carries ~2,300 points. The hard
 * caps are {@link MAX_TRACK_POINTS} points (69 hours at 1 Hz) and
 * {@link MAX_TRACK_PARTS} parts (~290,000 points at that density).
 */

/** Characters of encoded track per `lpt` record (the body then stays under the 20,000-byte op cap). */
export const PART_CHARS = 19_000;
/** Parts one trail may take (measured: ~290,000 points of a 1 Hz run). */
export const MAX_TRACK_PARTS = 128;
/** Points one trail may hold (the encoder refuses more). */
export const MAX_TRACK_POINTS = 250_000;

const VERSION = 'A';

export interface CodecPoint {
  latitude: number;
  longitude: number;
  altitude?: number;
  time: number;
  /** False when the point has no time (GPX without `<time>`). */
  hasTime?: boolean;
}

export interface CodecTrack {
  points: CodecPoint[];
  /** Indices where a new `<trkseg>` starts (0 never listed). */
  segmentStarts: number[];
}

class Writer {
  out: string[] = [];
  uint(v: number): void {
    // Unsigned varint, 5 bits per character, continuation in bit 6.
    let x = v;
    while (x >= 0x20) {
      this.out.push(String.fromCharCode((0x20 | (x % 0x20)) + 63));
      x = Math.floor(x / 0x20);
    }
    this.out.push(String.fromCharCode(x + 63));
  }
  int(v: number): void {
    this.uint(v < 0 ? -v * 2 - 1 : v * 2);
  }
}

class Reader {
  i = 0;
  constructor(private readonly s: string) {}
  get done(): boolean {
    return this.i >= this.s.length;
  }
  uint(): number | undefined {
    let result = 0;
    let mul = 1;
    for (let k = 0; k < 11; k++) {
      if (this.i >= this.s.length) return undefined;
      const b = this.s.charCodeAt(this.i++) - 63;
      if (b < 0 || b > 63) return undefined;
      result += (b & 0x1f) * mul;
      if (b < 0x20) return Number.isSafeInteger(result) ? result : undefined;
      mul *= 0x20;
    }
    return undefined;
  }
  int(): number | undefined {
    const u = this.uint();
    if (u === undefined) return undefined;
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Encode a trail (undefined: no valid points, or more than {@link MAX_TRACK_POINTS}). */
export function encodeTrack(track: CodecTrack): string | undefined {
  const pts = track.points;
  if (pts.length < 1 || pts.length > MAX_TRACK_POINTS) return undefined;
  for (const p of pts)
    if (
      !finite(p.latitude) ||
      !finite(p.longitude) ||
      Math.abs(p.latitude) > 90 ||
      Math.abs(p.longitude) > 180
    )
      return undefined;
  const w = new Writer();
  w.uint(pts.length);
  const segs = track.segmentStarts.filter((s) => Number.isInteger(s) && s > 0 && s < pts.length);
  const uniq = [...new Set(segs)].sort((a, b) => a - b);
  w.uint(uniq.length);
  let prev = 0;
  for (const s of uniq) {
    w.uint(s - prev);
    prev = s;
  }
  const col = (get: (p: CodecPoint) => number) => {
    let last = 0;
    for (const p of pts) {
      const v = get(p);
      w.int(v - last);
      last = v;
    }
  };
  col((p) => Math.round(p.latitude * 1e7));
  col((p) => Math.round(p.longitude * 1e7));
  // Nullable columns: 0 = missing, else zig-zag(delta) + 1.
  const nullable = (get: (p: CodecPoint) => number | undefined) => {
    let last = 0;
    for (const p of pts) {
      const v = get(p);
      if (v === undefined) {
        w.uint(0);
        continue;
      }
      const d = v - last;
      w.uint((d < 0 ? -d * 2 - 1 : d * 2) + 1);
      last = v;
    }
  };
  nullable((p) => (finite(p.altitude) ? Math.round(p.altitude * 100) : undefined));
  nullable((p) => (p.hasTime === false || !finite(p.time) ? undefined : Math.round(p.time)));
  return VERSION + w.out.join('');
}

/** Decode a trail; undefined for anything malformed (never throws). */
export function decodeTrack(s: string): CodecTrack | undefined {
  if (s.length < 2 || s[0] !== VERSION) return undefined;
  const r = new Reader(s.slice(1));
  const n = r.uint();
  if (n === undefined || n < 1 || n > MAX_TRACK_POINTS) return undefined;
  const nSeg = r.uint();
  if (nSeg === undefined || nSeg >= n) return undefined;
  const segmentStarts: number[] = [];
  let at = 0;
  for (let k = 0; k < nSeg; k++) {
    const d = r.uint();
    if (d === undefined || d < 1) return undefined;
    at += d;
    if (at >= n) return undefined;
    segmentStarts.push(at);
  }
  const col = (): number[] | undefined => {
    const out: number[] = [];
    let last = 0;
    for (let k = 0; k < n; k++) {
      const d = r.int();
      if (d === undefined) return undefined;
      last += d;
      out.push(last);
    }
    return out;
  };
  const nullable = (): (number | undefined)[] | undefined => {
    const out: (number | undefined)[] = [];
    let last = 0;
    for (let k = 0; k < n; k++) {
      const u = r.uint();
      if (u === undefined) return undefined;
      if (u === 0) {
        out.push(undefined);
        continue;
      }
      const z = u - 1;
      last += z % 2 === 0 ? z / 2 : -(z + 1) / 2;
      out.push(last);
    }
    return out;
  };
  const lat = col();
  const lon = col();
  const ele = nullable();
  const time = nullable();
  if (lat === undefined || lon === undefined || ele === undefined || time === undefined || !r.done)
    return undefined;
  const points: CodecPoint[] = [];
  for (let k = 0; k < n; k++) {
    const la = lat[k]! / 1e7;
    const lo = lon[k]! / 1e7;
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) return undefined;
    const p: CodecPoint = { latitude: la, longitude: lo, time: time[k] ?? 0 };
    const e = ele[k];
    if (e !== undefined) p.altitude = e / 100;
    if (time[k] === undefined) p.hasTime = false;
    points.push(p);
  }
  return { points, segmentStarts };
}

/** Split an encoded trail into parts of at most {@link PART_CHARS}. */
export function splitParts(s: string, size = PART_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const FNV = 0x811c9dc5;
function fnv(s: string, seed: number): number {
  let h = FNV ^ seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A content revision id for one item's geometry (part records are keyed by it). */
export function trackRevision(itemId: string, encoded: string): string {
  const key = `${itemId}|${encoded}`;
  return `${fnv(key, 0).toString(36)}${fnv(key, 0x5bd1e995).toString(36)}`;
}

/** The record id of part `n` of revision `rev` (short ids: `[A-Za-z0-9_-]`, ≤ 64). */
export const partId = (rev: string, n: number): string => `${rev}_${n.toString(36)}`;
