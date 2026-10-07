/**
 * NTRIP client protocol, transport-agnostic: the request bytes to write, a
 * streaming parser for what the caster answers (v1 "ICY 200 OK", v2 HTTP/1.1
 * with chunked transfer, "SOURCETABLE 200 OK"), and the GGA upload policy.
 *
 * The native side owns the socket (TCP or TLS) and pumps bytes both ways;
 * it calls `buildNtripRequest` once, feeds every received chunk to
 * `NtripResponseParser.push`, and forwards the returned `data` (RTCM, chunk
 * framing removed) to the receiver. Nothing here touches the network.
 *
 * NTRIP 2.0 = RTCM 10410.1; NTRIP 1.0 = RTCM 10410.0 (HTTP/1.0-like, not
 * valid HTTP, so `fetch` can't speak it).
 */
import { asciiToBytes, base64, bytesToAscii, concatBytes, utf8Bytes } from './bytes';
import { formatNmea } from './nmea';

export interface NtripEndpoint {
  host: string;
  port: number;
  /** Mountpoint without the leading "/"; '' asks for the sourcetable. */
  mountpoint: string;
  version: 1 | 2;
  username?: string;
  password?: string;
}

export const NTRIP_USER_AGENT = 'NTRIP Inukshuk/1.0';

/** Thrown by the request builder only (caller input, never caster bytes). */
export class NtripConfigError extends Error {}

const SAFE_MOUNT = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]*$/;
const SAFE_HOST = /^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/;

/**
 * The request to write after connecting. `gga` (v2 only) puts the rover's
 * position in the `Ntrip-GGA` header so a VRS caster can start at once.
 */
export function buildNtripRequest(
  ep: NtripEndpoint,
  opts: { userAgent?: string; gga?: string } = {},
): Uint8Array {
  if (!SAFE_HOST.test(ep.host)) throw new NtripConfigError('Invalid caster host');
  if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535)
    throw new NtripConfigError('Invalid caster port');
  if (!SAFE_MOUNT.test(ep.mountpoint)) throw new NtripConfigError('Invalid mountpoint name');
  const user = ep.username ?? '';
  const pass = ep.password ?? '';
  if (/[\r\n]/.test(user + pass)) throw new NtripConfigError('Credentials contain a line break');
  if (user.includes(':')) throw new NtripConfigError('The user name cannot contain ":"');
  const ua = opts.userAgent ?? NTRIP_USER_AGENT;
  if (/[\r\n]/.test(ua)) throw new NtripConfigError('Invalid user agent');
  const lines: string[] = [];
  if (ep.version === 2) {
    lines.push(`GET /${ep.mountpoint} HTTP/1.1`);
    lines.push(`Host: ${ep.host}${ep.port === 80 ? '' : `:${ep.port}`}`);
    lines.push('Ntrip-Version: Ntrip/2.0');
  } else {
    lines.push(`GET /${ep.mountpoint} HTTP/1.0`);
  }
  lines.push(`User-Agent: ${ua}`);
  if (user !== '' || pass !== '') {
    lines.push(`Authorization: Basic ${base64(utf8Bytes(`${user}:${pass}`))}`);
  }
  if (ep.version === 2 && opts.gga) {
    const g = opts.gga.trim();
    if (!/^\$[\x20-\x7e]+$/.test(g)) throw new NtripConfigError('Invalid GGA sentence');
    lines.push(`Ntrip-GGA: ${g}`);
  }
  lines.push('Accept: */*');
  lines.push('Connection: close');
  return asciiToBytes(`${lines.join('\r\n')}\r\n\r\n`);
}

// ---- response ---------------------------------------------------------------------------

export type NtripStatus =
  /** Waiting for the status line / headers. */
  | 'pending'
  /** Correction data follows (ICY 200 OK, or HTTP 200 gnss/data). */
  | 'streaming'
  /** The caster sent its sourcetable (asked for, or the mountpoint does not exist on v1). */
  | 'sourcetable'
  | 'unauthorized'
  | 'not-found'
  | 'error'
  /** Not an NTRIP / HTTP answer at all. */
  | 'bad-response';

export interface NtripHead {
  status: NtripStatus;
  /** "ICY", "HTTP/1.1", "SOURCETABLE"… */
  protocol: string;
  code: number | null;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  chunked: boolean;
}

export interface NtripChunk {
  /** Payload bytes (RTCM, or sourcetable text), chunk framing removed. */
  data: Uint8Array;
  /** The caster ended the body (chunked terminator, ENDSOURCETABLE). */
  done: boolean;
}

/** Longest header block we wait for before calling it a bad response. */
export const NTRIP_MAX_HEADER = 8192;

/** De-frames HTTP/1.1 chunked transfer coding, incrementally. */
export class ChunkedDecoder {
  private state: 'size' | 'data' | 'data-crlf' | 'trailer' | 'done' | 'error' = 'size';
  private line = '';
  private left = 0;

  get done(): boolean {
    return this.state === 'done';
  }
  get failed(): boolean {
    return this.state === 'error';
  }

  push(bytes: Uint8Array): Uint8Array {
    const out: Uint8Array[] = [];
    let i = 0;
    while (i < bytes.length && this.state !== 'done' && this.state !== 'error') {
      if (this.state === 'data') {
        const n = Math.min(this.left, bytes.length - i);
        out.push(bytes.subarray(i, i + n));
        i += n;
        this.left -= n;
        if (this.left === 0) this.state = 'data-crlf';
        continue;
      }
      const c = bytes[i++] as number;
      if (c === 0x0a) {
        const line = this.line.replace(/\r$/, '');
        this.line = '';
        if (this.state === 'size') {
          const m = /^([0-9A-Fa-f]{1,8})(;.*)?$/.exec(line.trim());
          if (!m) {
            this.state = 'error';
            break;
          }
          this.left = parseInt(m[1] as string, 16);
          this.state = this.left === 0 ? 'trailer' : 'data';
        } else if (this.state === 'data-crlf') {
          if (line !== '') {
            this.state = 'error';
            break;
          }
          this.state = 'size';
        } else if (line === '') {
          this.state = 'done';
        }
        continue;
      }
      this.line += String.fromCharCode(c);
      if (this.line.length > 1024) this.state = 'error';
    }
    return concatBytes(out);
  }
}

function classify(
  protocol: string,
  code: number | null,
  headers: Record<string, string>,
): NtripStatus {
  if (protocol === 'SOURCETABLE') return code === 200 ? 'sourcetable' : 'error';
  if (protocol === 'ICY') return code === 200 ? 'streaming' : 'error';
  if (code === 200) {
    const ct = (headers['content-type'] ?? '').toLowerCase();
    return ct.includes('sourcetable') ? 'sourcetable' : 'streaming';
  }
  if (code === 401) return 'unauthorized';
  if (code === 404) return 'not-found';
  return 'error';
}

/**
 * Feed the caster's bytes as they arrive. `push` returns the payload bytes
 * each call completes; `head` holds the decoded status once the headers are in.
 */
export class NtripResponseParser {
  head: NtripHead | null = null;
  private pre: Uint8Array = new Uint8Array(0);
  private chunked: ChunkedDecoder | null = null;
  private sourcetableTail = '';
  private ended = false;
  private stripBlank = false;

  push(bytes: Uint8Array): NtripChunk {
    if (this.ended) return { data: new Uint8Array(0), done: true };
    if (this.head === null) {
      this.pre = concatBytes([this.pre, bytes]);
      const parsed = this.parseHead();
      if (parsed === null) {
        if (this.pre.length > NTRIP_MAX_HEADER) {
          this.head = {
            status: 'bad-response',
            protocol: '',
            code: null,
            headers: {},
            chunked: false,
          };
          this.ended = true;
          return { data: new Uint8Array(0), done: true };
        }
        return { data: new Uint8Array(0), done: false };
      }
      this.head = parsed.head;
      const rest = this.pre.subarray(parsed.bodyAt);
      this.pre = new Uint8Array(0);
      if (parsed.head.status === 'bad-response') {
        this.ended = true;
        return { data: new Uint8Array(0), done: true };
      }
      if (parsed.head.chunked) this.chunked = new ChunkedDecoder();
      return this.body(rest);
    }
    return this.body(bytes);
  }

  private body(bytes: Uint8Array): NtripChunk {
    let data = bytes;
    while (this.stripBlank && data.length > 0) {
      const c = data[0] as number;
      if (c === 0x0d) data = data.subarray(1);
      else {
        if (c === 0x0a) data = data.subarray(1);
        this.stripBlank = false;
      }
    }
    let done = false;
    if (this.chunked) {
      data = this.chunked.push(bytes);
      done = this.chunked.done || this.chunked.failed;
    }
    if (this.head?.status === 'sourcetable' && !done) {
      const tail = this.sourcetableTail + bytesToAscii(data);
      if (/ENDSOURCETABLE\s*$/.test(tail) || tail.includes('ENDSOURCETABLE\r\n')) done = true;
      this.sourcetableTail = tail.slice(-32);
    }
    if (done) this.ended = true;
    return { data, done };
  }

  private parseHead(): { head: NtripHead; bodyAt: number } | null {
    const text = bytesToAscii(this.pre, 0, Math.min(this.pre.length, NTRIP_MAX_HEADER + 4));
    const firstEol = text.indexOf('\n');
    if (firstEol < 0) {
      // Not even a status line yet; an obviously non-text start is a bad response.
      return /[^\x09\x0a\x0d\x20-\x7e]/.test(text) ? this.bad() : null;
    }
    const status = text.slice(0, firstEol).replace(/\r$/, '');
    const m = /^(ICY|SOURCETABLE|HTTP\/1\.[01]) (\d{3})(?: (.*))?$/.exec(status);
    if (!m) return this.bad();
    const protocol = m[1] as string;
    const code = Number(m[2]);
    if (protocol === 'ICY') {
      // v1 data starts right after the status line; some casters add a blank line first.
      this.stripBlank = true;
      return {
        head: { status: classify(protocol, code, {}), protocol, code, headers: {}, chunked: false },
        bodyAt: firstEol + 1,
      };
    }
    const end = text.indexOf('\r\n\r\n');
    const endLf = text.indexOf('\n\n');
    const stop = end >= 0 ? end + 4 : endLf >= 0 ? endLf + 2 : -1;
    if (stop < 0) return null;
    const headers: Record<string, string> = {};
    for (const raw of text.slice(firstEol + 1, stop).split('\n')) {
      const l = raw.replace(/\r$/, '');
      const c = l.indexOf(':');
      if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
    }
    const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
    return {
      head: { status: classify(protocol, code, headers), protocol, code, headers, chunked },
      bodyAt: stop,
    };
  }

  private bad(): { head: NtripHead; bodyAt: number } {
    return {
      head: { status: 'bad-response', protocol: '', code: null, headers: {}, chunked: false },
      bodyAt: this.pre.length,
    };
  }
}

// ---- GGA upload --------------------------------------------------------------------------

/** Default GGA upload interval, seconds (VRS casters want one every 5–30 s). */
export const GGA_INTERVAL_S = 10;
export const GGA_MIN_INTERVAL_S = 5;

export interface GgaPolicyInput {
  /** The mountpoint's sourcetable "nmea" flag (1 = the caster needs our position). */
  nmeaRequired: boolean;
  /** The user allowed sending their position to this caster (privacy disclosure). */
  consent: boolean;
  /** When the last GGA went out, ms, or null if never. */
  lastSentMs: number | null;
  nowMs: number;
  intervalS?: number;
  /** A position to send exists (a fix of any kind). */
  havePosition: boolean;
}

export type GgaDecision =
  | { send: true }
  | { send: false; reason: 'not-required' | 'no-consent' | 'no-position' | 'not-due' };

/** Whether to upload a GGA now. Never sends a position the caster doesn't need. */
export function ggaDecision(p: GgaPolicyInput): GgaDecision {
  if (!p.nmeaRequired) return { send: false, reason: 'not-required' };
  if (!p.consent) return { send: false, reason: 'no-consent' };
  if (!p.havePosition) return { send: false, reason: 'no-position' };
  const every = Math.max(GGA_MIN_INTERVAL_S, p.intervalS ?? GGA_INTERVAL_S) * 1000;
  if (p.lastSentMs !== null && p.nowMs - p.lastSentMs < every)
    return { send: false, reason: 'not-due' };
  return { send: true };
}

export interface GgaInput {
  /** UTC ms. */
  timeMs: number;
  lat: number;
  lon: number;
  /** Ellipsoidal height, metres (GGA wants MSL + separation; we send h with N = 0). */
  hEll: number | null;
  /** GGA quality indicator to report. */
  quality: number;
  satsUsed: number | null;
  hdop: number | null;
  ageS: number | null;
}

function dm(v: number, degDigits: number, pos: string, neg: string): string {
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = (a - d) * 60;
  // 8 decimals of minutes ≈ 0.02 mm: no rounding seen by a VRS.
  let ms = m.toFixed(8);
  if (ms.startsWith('60')) {
    d += 1;
    m = 0;
    ms = m.toFixed(8);
  }
  return `${String(d).padStart(degDigits, '0')}${ms.padStart(11, '0')},${v < 0 ? neg : pos}`;
}

/**
 * A GGA sentence for NTRIP upload, built from a fix when the receiver gives
 * no GGA of its own (UBX-only kits). Height goes out as ellipsoidal (geoid
 * separation 0), which is what VRS software uses anyway.
 */
export function buildGga(g: GgaInput): string {
  const t = new Date(g.timeMs);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  const ss = (t.getUTCSeconds() + t.getUTCMilliseconds() / 1000).toFixed(2).padStart(5, '0');
  const fields = [
    'GPGGA',
    `${hh}${mm}${ss}`,
    dm(g.lat, 2, 'N', 'S'),
    dm(g.lon, 3, 'E', 'W'),
    String(g.quality),
    g.satsUsed === null ? '' : String(g.satsUsed).padStart(2, '0'),
    g.hdop === null ? '' : g.hdop.toFixed(1),
    g.hEll === null ? '' : g.hEll.toFixed(3),
    'M',
    '0.000',
    'M',
    g.ageS === null ? '' : g.ageS.toFixed(1),
    '',
  ];
  return formatNmea(fields.join(','));
}
