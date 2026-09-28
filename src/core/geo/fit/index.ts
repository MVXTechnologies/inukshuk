import type { TrackPoint } from '@core/models';

/**
 * Minimal FIT (Garmin Flexible and Interoperable data Transfer) activity
 * decoder — pure TypeScript, no platform dependencies, no SDK.
 *
 * It walks the record stream of one or more chained FIT files and extracts
 * only what a trail library needs:
 *
 * - `record` (global 20): timestamp, position, (enhanced) altitude, heart
 *   rate, speed. Records without a position are skipped.
 * - `session` (18) / `sport` (12): sport + sub-sport and start time.
 * - `event` (21): timer stop → the next positioned record opens a new segment
 *   (a pause is a segment boundary, see `@core/geo/track/segments`).
 * - `file_id` (0): creation time, as a start-time fallback.
 *
 * Handled edge cases: 12- and 14-byte headers, little- and big-endian
 * definition messages, compressed-timestamp record headers, developer data
 * fields (their sizes come from the definition message, so they are skipped
 * without needing `field_description`), invalid-value sentinels per base type,
 * array/odd-sized fields (skipped by size), and chained files. CRCs are not
 * verified — a bad CRC with a well-formed stream still decodes.
 *
 * Every read is bounds-checked and every loop advances by at least one byte,
 * so hostile input ends in a {@link FitDecodeError}, never a hang.
 */

/** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
export const FIT_EPOCH_OFFSET_S = 631065600;

const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

export type FitDecodeErrorCode =
  'not-fit' | 'truncated' | 'undefined-local-message' | 'bad-definition';

export class FitDecodeError extends Error {
  readonly code: FitDecodeErrorCode;
  constructor(code: FitDecodeErrorCode, message: string) {
    super(`FIT: ${message}`);
    this.name = 'FitDecodeError';
    this.code = code;
  }
}

export interface FitActivity {
  points: TrackPoint[];
  /** Indices into `points` where a timer stop/start pause begins a new segment. */
  segmentStarts: number[];
  /** Normalized sport key, e.g. `running`, `trail_running`, `cycling`, `hiking`. */
  sport?: string;
  /** Epoch ms of the session start (or file creation), if present. */
  startTime?: number;
}

/** Does `bytes` carry a FIT header (".FIT" signature at offset 8)? */
export function looksLikeFit(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    (bytes[0] === 12 || bytes[0] === 14) &&
    bytes[8] === 0x2e && // .
    bytes[9] === 0x46 && // F
    bytes[10] === 0x49 && // I
    bytes[11] === 0x54 // T
  );
}

interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}

interface MessageDef {
  global: number;
  littleEndian: boolean;
  fields: FieldDef[];
  /** Total bytes of developer fields appended to each data message. */
  devBytes: number;
  /** Total bytes of one data message's payload (fields + dev fields). */
  size: number;
}

// Global message numbers we care about.
const MSG_FILE_ID = 0;
const MSG_SPORT = 12;
const MSG_SESSION = 18;
const MSG_RECORD = 20;
const MSG_EVENT = 21;

const FIELD_TIMESTAMP = 253;

/**
 * FIT `sport` enum → normalized key. Only values with an obvious meaning for
 * a trail library are named; others fall back to `sport_<n>`.
 */
const SPORT_NAMES: Record<number, string> = {
  0: 'generic',
  1: 'running',
  2: 'cycling',
  5: 'swimming',
  10: 'training',
  11: 'walking',
  12: 'cross_country_skiing',
  13: 'alpine_skiing',
  14: 'snowboarding',
  15: 'rowing',
  16: 'mountaineering',
  17: 'hiking',
  19: 'paddling',
  21: 'e_biking',
  30: 'inline_skating',
  31: 'rock_climbing',
  35: 'snowshoeing',
  37: 'stand_up_paddleboarding',
  41: 'kayaking',
};

/** FIT `sub_sport` values that refine the sport key. */
const SUB_SPORT_TRAIL = 3;
const SUB_SPORT_MOUNTAIN = 8;
const SUB_SPORT_BACKCOUNTRY = 37;

function sportKey(sport: number | undefined, subSport: number | undefined): string | undefined {
  if (sport === undefined) return undefined;
  if (sport === 1 && subSport === SUB_SPORT_TRAIL) return 'trail_running';
  if (sport === 2 && subSport === SUB_SPORT_MOUNTAIN) return 'mountain_biking';
  if (sport === 12 && subSport === SUB_SPORT_BACKCOUNTRY) return 'backcountry_skiing';
  return SPORT_NAMES[sport] ?? `sport_${sport}`;
}

/** Byte width of each base type (by its low 5-bit number). */
const BASE_TYPE_SIZE: Record<number, number> = {
  0x00: 1, // enum
  0x01: 1, // sint8
  0x02: 1, // uint8
  0x03: 2, // sint16
  0x04: 2, // uint16
  0x05: 4, // sint32
  0x06: 4, // uint32
  0x07: 1, // string
  0x08: 4, // float32
  0x09: 8, // float64
  0x0a: 1, // uint8z
  0x0b: 2, // uint16z
  0x0c: 4, // uint32z
  0x0d: 1, // byte
  0x0e: 8, // sint64
  0x0f: 8, // uint64
  0x10: 8, // uint64z
};

/**
 * Read one scalar field value, or undefined for the base type's invalid
 * sentinel, non-numeric types (string/byte), 64-bit integers (never needed
 * here) and fields whose size doesn't match their type (arrays).
 */
function readScalar(
  view: DataView,
  offset: number,
  field: FieldDef,
  littleEndian: boolean,
): number | undefined {
  const type = field.baseType & 0x1f;
  const width = BASE_TYPE_SIZE[type];
  if (width === undefined || field.size !== width) return undefined;
  let v: number;
  switch (type) {
    case 0x00: // enum
    case 0x02: // uint8
      v = view.getUint8(offset);
      return v === 0xff ? undefined : v;
    case 0x01:
      v = view.getInt8(offset);
      return v === 0x7f ? undefined : v;
    case 0x0a:
      v = view.getUint8(offset);
      return v === 0 ? undefined : v;
    case 0x03:
      v = view.getInt16(offset, littleEndian);
      return v === 0x7fff ? undefined : v;
    case 0x04:
      v = view.getUint16(offset, littleEndian);
      return v === 0xffff ? undefined : v;
    case 0x0b:
      v = view.getUint16(offset, littleEndian);
      return v === 0 ? undefined : v;
    case 0x05:
      v = view.getInt32(offset, littleEndian);
      return v === 0x7fffffff ? undefined : v;
    case 0x06:
      v = view.getUint32(offset, littleEndian);
      return v === 0xffffffff ? undefined : v;
    case 0x0c:
      v = view.getUint32(offset, littleEndian);
      return v === 0 ? undefined : v;
    case 0x08: {
      if (view.getUint32(offset, littleEndian) === 0xffffffff) return undefined;
      v = view.getFloat32(offset, littleEndian);
      return Number.isFinite(v) ? v : undefined;
    }
    case 0x09: {
      v = view.getFloat64(offset, littleEndian);
      return Number.isFinite(v) ? v : undefined;
    }
    default:
      return undefined;
  }
}

const fitSecondsToMs = (s: number): number => (s + FIT_EPOCH_OFFSET_S) * 1000;

// FIT timer event (event field 0 == 0) types that stop the clock.
const EVENT_TIMER = 0;
const STOP_EVENT_TYPES = new Set([1, 4, 8, 9]); // stop, stop_all, stop_disable, stop_disable_all

/**
 * Decode a FIT activity (one file or several concatenated). Throws a
 * {@link FitDecodeError} for anything that isn't a well-formed FIT stream.
 */
export function decodeFit(bytes: Uint8Array): FitActivity {
  if (!looksLikeFit(bytes)) throw new FitDecodeError('not-fit', 'missing .FIT header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const points: TrackPoint[] = [];
  const segmentStarts: number[] = [];
  let sport: number | undefined;
  let subSport: number | undefined;
  let fallbackSport: number | undefined;
  let fallbackSubSport: number | undefined;
  let sessionStart: number | undefined;
  let fileCreated: number | undefined;
  let pendingBreak = false;

  let pos = 0;
  while (pos < bytes.length) {
    // --- one FIT file (header + records + CRC) ---
    if (!looksLikeFit(bytes.subarray(pos))) {
      break; // trailing padding/garbage after a complete file (the first one was checked)
    }
    const headerSize = view.getUint8(pos);
    if (pos + headerSize > bytes.length) throw new FitDecodeError('truncated', 'short header');
    const declared = view.getUint32(pos + 4, true);
    const start = pos + headerSize;
    // A zero data size marks a file whose writer never finalized it: read to the end.
    const end = declared === 0 ? bytes.length : start + declared;
    if (end > bytes.length) throw new FitDecodeError('truncated', 'data shorter than header says');

    const defs = new Map<number, MessageDef>();
    let lastTimestamp: number | undefined;
    pos = start;
    while (pos < end) {
      const header = view.getUint8(pos);
      pos += 1;
      const compressed = (header & 0x80) !== 0;
      let local: number;
      let timeOffset: number | undefined;
      if (compressed) {
        local = (header >> 5) & 0x03;
        timeOffset = header & 0x1f;
      } else {
        local = header & 0x0f;
        if ((header & 0x40) !== 0) {
          pos = readDefinition(view, pos, end, local, (header & 0x20) !== 0, defs);
          continue;
        }
      }
      const def = defs.get(local);
      if (!def) {
        throw new FitDecodeError('undefined-local-message', `local message ${local} undefined`);
      }
      if (pos + def.size > end) throw new FitDecodeError('truncated', 'data message cut off');

      // Decode the handful of fields we use.
      const values = new Map<number, number>();
      let off = pos;
      for (const f of def.fields) {
        const v = readScalar(view, off, f, def.littleEndian);
        if (v !== undefined) values.set(f.num, v);
        off += f.size;
      }
      pos += def.size; // skips developer fields too

      let timestamp = values.get(FIELD_TIMESTAMP);
      if (timestamp !== undefined) {
        lastTimestamp = timestamp;
      } else if (timeOffset !== undefined && lastTimestamp !== undefined) {
        timestamp = (lastTimestamp & ~0x1f) + timeOffset;
        if (timeOffset < (lastTimestamp & 0x1f)) timestamp += 0x20;
        // Unsigned: & can go negative for values ≥ 2^31.
        timestamp >>>= 0;
        lastTimestamp = timestamp;
      }

      switch (def.global) {
        case MSG_RECORD: {
          const lat = values.get(0);
          const lon = values.get(1);
          if (lat === undefined || lon === undefined) break;
          const latitude = lat * SEMICIRCLE_TO_DEG;
          const longitude = lon * SEMICIRCLE_TO_DEG;
          if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) break;
          const point: TrackPoint =
            timestamp !== undefined
              ? { latitude, longitude, time: fitSecondsToMs(timestamp), hasTime: true }
              : { latitude, longitude, time: 0, hasTime: false };
          const rawAlt = values.get(78) ?? values.get(2);
          if (rawAlt !== undefined) point.altitude = rawAlt / 5 - 500;
          const hr = values.get(3);
          if (hr !== undefined && hr > 0) point.heartRateBpm = hr;
          const rawSpeed = values.get(73) ?? values.get(6);
          if (rawSpeed !== undefined) point.speed = rawSpeed / 1000;
          if (pendingBreak && points.length > 0) segmentStarts.push(points.length);
          pendingBreak = false;
          points.push(point);
          break;
        }
        case MSG_EVENT: {
          if (values.get(0) === EVENT_TIMER && STOP_EVENT_TYPES.has(values.get(1) ?? -1)) {
            pendingBreak = true;
          }
          break;
        }
        case MSG_SESSION: {
          if (sport === undefined && values.has(5)) {
            sport = values.get(5);
            subSport = values.get(6);
          }
          const st = values.get(2);
          if (sessionStart === undefined && st !== undefined) sessionStart = fitSecondsToMs(st);
          break;
        }
        case MSG_SPORT: {
          if (fallbackSport === undefined && values.has(0)) {
            fallbackSport = values.get(0);
            fallbackSubSport = values.get(1);
          }
          break;
        }
        case MSG_FILE_ID: {
          const created = values.get(4);
          if (fileCreated === undefined && created !== undefined) {
            fileCreated = fitSecondsToMs(created);
          }
          break;
        }
        default:
          break;
      }
    }
    // Skip the 2-byte file CRC (absent/short at EOF is tolerated).
    pos = Math.min(bytes.length, end + 2);
  }

  const activity: FitActivity = { points, segmentStarts };
  const key =
    sport !== undefined ? sportKey(sport, subSport) : sportKey(fallbackSport, fallbackSubSport);
  if (key !== undefined) activity.sport = key;
  const startTime = sessionStart ?? fileCreated;
  if (startTime !== undefined) activity.startTime = startTime;
  return activity;
}

/** Parse a definition message at `pos` (just past its header); returns the new position. */
function readDefinition(
  view: DataView,
  pos: number,
  end: number,
  local: number,
  hasDevFields: boolean,
  defs: Map<number, MessageDef>,
): number {
  if (pos + 5 > end) throw new FitDecodeError('truncated', 'definition cut off');
  const arch = view.getUint8(pos + 1);
  if (arch > 1) throw new FitDecodeError('bad-definition', `unknown architecture ${arch}`);
  const littleEndian = arch === 0;
  const global = view.getUint16(pos + 2, littleEndian);
  const count = view.getUint8(pos + 4);
  pos += 5;
  if (pos + count * 3 > end) throw new FitDecodeError('truncated', 'field definitions cut off');
  const fields: FieldDef[] = [];
  let size = 0;
  for (let i = 0; i < count; i++) {
    const f = {
      num: view.getUint8(pos),
      size: view.getUint8(pos + 1),
      baseType: view.getUint8(pos + 2),
    };
    fields.push(f);
    size += f.size;
    pos += 3;
  }
  let devBytes = 0;
  if (hasDevFields) {
    if (pos + 1 > end) throw new FitDecodeError('truncated', 'developer fields cut off');
    const devCount = view.getUint8(pos);
    pos += 1;
    if (pos + devCount * 3 > end) throw new FitDecodeError('truncated', 'developer fields cut off');
    for (let i = 0; i < devCount; i++) {
      devBytes += view.getUint8(pos + 1);
      pos += 3;
    }
  }
  defs.set(local, { global, littleEndian, fields, devBytes, size: size + devBytes });
  return pos;
}
