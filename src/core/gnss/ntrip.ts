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
  reason: string,
): NtripStatus {
  if (protocol === 'SOURCETABLE') return code === 200 ? 'sourcetable' : 'error';
  if (protocol === 'ICY') return code === 200 ? 'streaming' : 'error';
  // v1 casters (BKG, SNIP, receivers acting as casters) may refuse in plain words.
  if (protocol === 'ERROR') return /password|auth/i.test(reason) ? 'unauthorized' : 'error';
  if (code === 200) {
    const ct = (headers['content-type'] ?? '').toLowerCase();
    return ct.includes('sourcetable') ? 'sourcetable' : 'streaming';
  }
  if (code === 401) return 'unauthorized';
  if (code === 404) return 'not-found';
  return 'error';
}

/**
 * The status line. Casters answer in their own dialect whatever the request
 * said: a Leica GR30 answers an Ntrip/2.0 request with the v1
 * `SOURCETABLE 200 OK` (no HTTP status line), many v1 casters send
 * `ICY 200 OK` to an HTTP/1.1 request. So a reply is never matched against
 * the request's version.
 */
const STATUS = /^(ICY|SOURCETABLE|HTTP\/1\.[01])[ \t]+(\d{3})(?:[ \t]+(.*))?$/i;
/** "ERROR - Bad Password", "ERROR - Mount Point Taken or Invalid" (v1). */
const V1_ERROR = /^ERROR\b[ \t-]*(.*)$/i;
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
/** A header line; the colon may have no space after it (GR30: `Content-Length:89`). */
const HEADER_LINE = new RegExp(`^${TOKEN}[ \\t]*:`);
/** An incomplete line that may still become a header. */
const HEADER_START = new RegExp(`^(${TOKEN}[ \\t]*(:[^\\n]*)?|\\r)$`);

/** Longest line taken for a header after `ICY 200 OK` before calling it data. */
const ICY_HEADER_LINE_MAX = 512;

function addHeader(headers: Record<string, string>, line: string): void {
  const c = line.indexOf(':');
  headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
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
  /** After `ICY 200 OK`: what may still be header lines / a blank line before the data. */
  private icyPreamble: Uint8Array | null = null;

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

  /**
   * v1 data starts right after `ICY 200 OK`, but some casters first send a
   * blank line, or header lines and a blank line. RTCM 3 starts with 0xD3,
   * never text, so header-shaped lines are taken as headers and anything
   * else is data. Returns the data, or null while a line is incomplete.
   */
  private icy(pending: Uint8Array, bytes: Uint8Array): Uint8Array | null {
    let buf = concatBytes([pending, bytes]);
    const headers = (this.head as NtripHead).headers;
    for (;;) {
      let eol = -1;
      let text = true;
      for (let i = 0; i < buf.length && i <= ICY_HEADER_LINE_MAX; i++) {
        const c = buf[i] as number;
        if (c === 0x0a) {
          eol = i;
          break;
        }
        if (c !== 0x0d && c !== 0x09 && (c < 0x20 || c > 0x7e)) {
          text = false;
          break;
        }
      }
      if (!text || (eol < 0 && buf.length > ICY_HEADER_LINE_MAX)) break;
      if (eol < 0) {
        if (buf.length > 0 && !HEADER_START.test(bytesToAscii(buf))) break;
        this.icyPreamble = buf;
        return null;
      }
      const line = bytesToAscii(buf, 0, eol).replace(/\r$/, '');
      if (line === '') {
        buf = buf.subarray(eol + 1);
        break; // the blank line ends the preamble
      }
      if (!HEADER_LINE.test(line)) break;
      addHeader(headers, line);
      buf = buf.subarray(eol + 1);
    }
    this.icyPreamble = null;
    return buf;
  }

  private body(bytes: Uint8Array): NtripChunk {
    let data = bytes;
    if (this.icyPreamble !== null) {
      const d = this.icy(this.icyPreamble, bytes);
      if (d === null) return { data: new Uint8Array(0), done: false };
      data = d;
    }
    let done = false;
    if (this.chunked) {
      data = this.chunked.push(data);
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
    // Stray line breaks before the status line are tolerated.
    const lead = text.length - text.replace(/^[\r\n]+/, '').length;
    const firstEol = text.indexOf('\n', lead);
    if (firstEol < 0) {
      // Not even a status line yet; an obviously non-text start is a bad response.
      return /[^\x09\x0a\x0d\x20-\x7e]/.test(text) ? this.bad() : null;
    }
    const status = text.slice(lead, firstEol).trim();
    const m = STATUS.exec(status);
    const err = m ? null : V1_ERROR.exec(status);
    if (m === null && err === null) return this.bad();
    const protocol = m ? (m[1] as string).toUpperCase() : 'ERROR';
    const code = m ? Number(m[2]) : null;
    const reason = (m ? m[3] : err?.[1]) ?? '';
    const headers: Record<string, string> = {};
    if (protocol === 'ICY' || protocol === 'ERROR') {
      const st = classify(protocol, code, headers, reason);
      if (st === 'streaming') this.icyPreamble = new Uint8Array(0);
      return {
        head: { status: st, protocol, code, headers, chunked: false },
        bodyAt: firstEol + 1,
      };
    }
    // Header lines until a blank line, or until the first line that is not a
    // header (a v1 sourcetable may go straight from its status line to STR;…).
    let at = firstEol + 1;
    let bodyAt = -1;
    for (;;) {
      const eol = text.indexOf('\n', at);
      if (eol < 0) {
        // An incomplete line that cannot become a header already is the body.
        if (HEADER_START.test(text.slice(at)) || at === text.length) return null;
        bodyAt = at;
        break;
      }
      const line = text.slice(at, eol).replace(/\r$/, '');
      if (line === '') {
        bodyAt = eol + 1;
        break;
      }
      if (!HEADER_LINE.test(line)) {
        bodyAt = at;
        break;
      }
      addHeader(headers, line);
      at = eol + 1;
    }
    const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
    return {
      head: { status: classify(protocol, code, headers, reason), protocol, code, headers, chunked },
      bodyAt,
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

/**
 * The user's "send my position" switch decides, not the sourcetable's nmea
 * flag: casters leave it empty (a Leica GR30 lists `;;` for nmea), and some
 * single-base casters wait for a GGA anyway — QField sends one whenever its
 * "send position" switch is on. The flag only drives the editor's hint.
 */
export interface GgaPolicyInput {
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
  { send: true } | { send: false; reason: 'no-consent' | 'no-position' | 'not-due' };

/** Whether to upload a GGA now. Never without the user's consent. */
export function ggaDecision(p: GgaPolicyInput): GgaDecision {
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
  // 6 decimals of minutes ≈ 2 mm: finer than any VRS needs, and short enough
  // for the 82-character NMEA limit (strict casters drop longer sentences).
  let ms = m.toFixed(6);
  if (ms.startsWith('60')) {
    d += 1;
    m = 0;
    ms = m.toFixed(6);
  }
  return `${String(d).padStart(degDigits, '0')}${ms.padStart(9, '0')},${v < 0 ? neg : pos}`;
}

/** NMEA 0183: at most 82 characters, `$` and the closing CR LF included. */
export const NMEA_MAX_LENGTH = 82;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * A GGA sentence for NTRIP upload, built from a fix when the receiver gives
 * no GGA of its own (UBX-only kits). Height goes out as ellipsoidal (geoid
 * separation 0), which is what VRS software uses anyway. Always within
 * `NMEA_MAX_LENGTH`.
 */
export function buildGga(g: GgaInput): string {
  const t = new Date(g.timeMs);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  // Truncated, never rounded up to "60.00".
  const cs = Math.floor(t.getUTCMilliseconds() / 10);
  const ss = `${String(t.getUTCSeconds()).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  const fields = [
    'GPGGA',
    `${hh}${mm}${ss}`,
    dm(g.lat, 2, 'N', 'S'),
    dm(g.lon, 3, 'E', 'W'),
    String(clamp(Math.round(g.quality), 0, 9)),
    g.satsUsed === null ? '' : String(clamp(Math.round(g.satsUsed), 0, 99)).padStart(2, '0'),
    g.hdop === null ? '' : clamp(g.hdop, 0, 99.9).toFixed(1),
    g.hEll === null ? '' : clamp(g.hEll, -9999.9, 99999.9).toFixed(1),
    'M',
    '0.0',
    'M',
    g.ageS === null ? '' : clamp(g.ageS, 0, 99.9).toFixed(1),
    '',
  ];
  return formatNmea(fields.join(','));
}
