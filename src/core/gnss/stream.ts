/**
 * The receiver byte stream → frames: NMEA lines, UBX messages and RTCM 3
 * messages, interleaved in any order and split across arbitrary chunks (a
 * BLE notification is 20–244 bytes; an SPP read is whatever arrived).
 *
 * Resynchronisation rule: a candidate frame that fails (bad checksum,
 * impossible length, a non-printable byte inside an NMEA line) costs ONE
 * byte, and the scan resumes at the next byte — so a real frame that starts
 * inside a corrupt one is never lost. Nothing here throws on input; bad
 * bytes are counted in `stats` and skipped.
 *
 * The buffer never holds more than one maximum-size frame plus the last
 * chunk: a candidate either completes, fails, or is still short of its own
 * declared length.
 */
import { bytesToAscii } from './bytes';
import { parseNmea, type NmeaMessage } from './nmea';
import { crc24q, rtcm3Type, RTCM3_PREAMBLE, type Rtcm3Frame } from './rtcm3';
import {
  decodeUbx,
  ubxChecksum,
  UBX_MAX_PAYLOAD,
  UBX_SYNC1,
  UBX_SYNC2,
  type UbxFrame,
  type UbxMessage,
} from './ubx';

/** Longest NMEA line accepted (NMEA says 82; high-precision receivers exceed it). */
export const NMEA_MAX_LINE = 256;

export type StreamEvent =
  | { kind: 'nmea'; msg: NmeaMessage; line: string }
  | { kind: 'ubx'; frame: UbxFrame; msg: UbxMessage | null }
  | { kind: 'rtcm3'; frame: Rtcm3Frame };

export interface StreamStats {
  bytesIn: number;
  nmea: number;
  /** Well-formed NMEA of a type we don't use (GLL, GNS, proprietary…). */
  nmeaUnsupported: number;
  nmeaBad: number;
  ubx: number;
  ubxBad: number;
  rtcm3: number;
  rtcm3Bad: number;
  /** Bytes that belonged to no valid frame. */
  garbageBytes: number;
}

const DOLLAR = 0x24;
const LF = 0x0a;
const CR = 0x0d;

function emptyStats(): StreamStats {
  return {
    bytesIn: 0,
    nmea: 0,
    nmeaUnsupported: 0,
    nmeaBad: 0,
    ubx: 0,
    ubxBad: 0,
    rtcm3: 0,
    rtcm3Bad: 0,
    garbageBytes: 0,
  };
}

type Step =
  /** Not enough bytes yet to decide. */
  | { t: 'wait' }
  /** Not a frame here: drop `n` bytes as garbage. */
  | { t: 'skip'; n: number }
  /** A frame of `n` bytes (events may be empty for unsupported NMEA). */
  | { t: 'frame'; n: number; ev: StreamEvent | null };

export class GnssDemuxer {
  private buf = new Uint8Array(4096);
  private start = 0;
  private end = 0;
  readonly stats: StreamStats = emptyStats();

  /** Feed bytes; returns every complete frame they finish, in stream order. */
  push(chunk: Uint8Array): StreamEvent[] {
    this.stats.bytesIn += chunk.length;
    this.append(chunk);
    const out: StreamEvent[] = [];
    while (this.start < this.end) {
      const s = this.step();
      if (s.t === 'wait') break;
      if (s.t === 'skip') {
        this.stats.garbageBytes += s.n;
        this.start += s.n;
        continue;
      }
      this.start += s.n;
      if (s.ev) out.push(s.ev);
    }
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
    }
    return out;
  }

  /** Bytes held while waiting for the rest of a frame. */
  get pending(): number {
    return this.end - this.start;
  }

  /** Drop any partial frame (on disconnect); the bytes count as garbage. */
  reset(): void {
    this.stats.garbageBytes += this.end - this.start;
    this.start = 0;
    this.end = 0;
  }

  private append(chunk: Uint8Array): void {
    const len = this.end - this.start;
    if (this.end + chunk.length > this.buf.length) {
      if (len + chunk.length <= this.buf.length && this.start > 0) {
        this.buf.copyWithin(0, this.start, this.end);
      } else {
        const next = new Uint8Array(Math.max(this.buf.length * 2, len + chunk.length));
        next.set(this.buf.subarray(this.start, this.end));
        this.buf = next;
      }
      this.start = 0;
      this.end = len;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }

  private at(i: number): number {
    return this.buf[this.start + i] as number;
  }

  private step(): Step {
    const b0 = this.at(0);
    if (b0 === DOLLAR) return this.nmea();
    if (b0 === UBX_SYNC1) return this.ubx();
    if (b0 === RTCM3_PREAMBLE) return this.rtcm();
    // Fast-forward over a run of bytes that can't start a frame.
    let n = 1;
    const avail = this.end - this.start;
    while (n < avail) {
      const b = this.at(n);
      if (b === DOLLAR || b === UBX_SYNC1 || b === RTCM3_PREAMBLE) break;
      n++;
    }
    return { t: 'skip', n };
  }

  private nmea(): Step {
    const avail = this.end - this.start;
    for (let i = 1; i < avail; i++) {
      if (i > NMEA_MAX_LINE) return { t: 'skip', n: 1 };
      const b = this.at(i);
      if (b === LF) {
        const line = bytesToAscii(this.buf, this.start, this.start + i);
        const r = parseNmea(line);
        if (r.ok) {
          this.stats.nmea++;
          return {
            t: 'frame',
            n: i + 1,
            ev: { kind: 'nmea', msg: r.msg, line: line.replace(/\r$/, '') },
          };
        }
        if (r.reason === 'unsupported') {
          this.stats.nmeaUnsupported++;
          return { t: 'frame', n: i + 1, ev: null };
        }
        this.stats.nmeaBad++;
        // The line is printable text ending in LF: drop it whole.
        this.stats.garbageBytes += i + 1;
        return { t: 'frame', n: i + 1, ev: null };
      }
      // A second '$' before the end of line: this one was truncated.
      if (b === DOLLAR) {
        this.stats.nmeaBad++;
        return { t: 'skip', n: i };
      }
      if (b === CR) continue;
      if (b < 0x20 || b > 0x7e) return { t: 'skip', n: 1 };
    }
    // (a line longer than NMEA_MAX_LINE was refused inside the loop)
    return { t: 'wait' };
  }

  private ubx(): Step {
    const avail = this.end - this.start;
    if (avail < 2) return { t: 'wait' };
    if (this.at(1) !== UBX_SYNC2) return { t: 'skip', n: 1 };
    if (avail < 6) return { t: 'wait' };
    const len = this.at(4) | (this.at(5) << 8);
    if (len > UBX_MAX_PAYLOAD) {
      this.stats.ubxBad++;
      return { t: 'skip', n: 1 };
    }
    const total = len + 8;
    if (avail < total) return { t: 'wait' };
    const [a, b] = ubxChecksum(this.buf, this.start + 2, this.start + 6 + len);
    if (a !== this.at(6 + len) || b !== this.at(7 + len)) {
      this.stats.ubxBad++;
      return { t: 'skip', n: 1 };
    }
    const frame: UbxFrame = {
      cls: this.at(2),
      id: this.at(3),
      payload: this.buf.slice(this.start + 6, this.start + 6 + len),
    };
    this.stats.ubx++;
    return { t: 'frame', n: total, ev: { kind: 'ubx', frame, msg: decodeUbx(frame) } };
  }

  private rtcm(): Step {
    const avail = this.end - this.start;
    if (avail < 3) return { t: 'wait' };
    if ((this.at(1) & 0xfc) !== 0) return { t: 'skip', n: 1 };
    const len = ((this.at(1) & 0x03) << 8) | this.at(2);
    const total = len + 6;
    if (avail < total) return { t: 'wait' };
    const crc = crc24q(this.buf, this.start, this.start + 3 + len);
    const got = (this.at(3 + len) << 16) | (this.at(4 + len) << 8) | this.at(5 + len);
    if (crc !== got) {
      this.stats.rtcm3Bad++;
      return { t: 'skip', n: 1 };
    }
    const raw = this.buf.slice(this.start, this.start + total);
    const payload = raw.subarray(3, 3 + len);
    this.stats.rtcm3++;
    return {
      t: 'frame',
      n: total,
      ev: { kind: 'rtcm3', frame: { type: rtcm3Type(payload), payload, raw } },
    };
  }
}
