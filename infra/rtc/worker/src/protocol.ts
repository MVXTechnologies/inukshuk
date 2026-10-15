/**
 * Room protocol v1 (`wss://<host>/v1/r/<roomId>`), server side. The phone
 * side is `src/core/group/{rdv,roomBlob}.ts`; both are pinned to the same
 * vectors (`src/core/group/rdv.vectors.json`).
 *
 * Text frames, one JSON object each:
 *
 * | Direction | Frame                                   | When                                  |
 * | --------- | --------------------------------------- | ------------------------------------- |
 * | S → C     | `{t:'chal', c, now}`                    | on connect, and after a failed auth   |
 * | C → S     | `{t:'auth', pub, sig}`                  | Ed25519 over label‖host‖roomId‖c      |
 * | S → C     | `{t:'ok', me, peers, now}`              | authenticated; `me` is our handle     |
 * | S → C     | `{t:'join', h}` / `{t:'leave', h}`      | another authenticated socket          |
 * | C → S     | `{t:'m', to, b}`                        | `to` = handle or `'*'`; `b` = blob    |
 * | S → C     | `{t:'m', from, b}`                      | forwarded verbatim                    |
 * | C → S     | `{t:'turn'}`                            | ask for TURN credentials              |
 * | S → C     | `{t:'turn', ice, ttl}` / `{t:'turn', e}`| `e`: off, busy, budget, rate, alone   |
 *
 * `now` is the server's unix time in seconds: phones date their blobs with it
 * (5-minute freshness) and pick the UTC day of the room from it, so a phone
 * with a wrong clock still meets its group. `ping` is answered `pong` by the
 * runtime without waking the object.
 *
 * The server never opens `b`: it checks only that it is base64url of exactly
 * one padding bucket (256 B, 1/4/16 KiB), so even sizes say nothing more.
 */

/** Must equal `RDV_DOMAIN` in src/core/group/rdv.ts. */
export const RDV_DOMAIN = 'inukshuk/rdv/v1/';
export const ROOM_ID_BYTES = 16;
export const CHALLENGE_BYTES = 32;
export const HANDLE_BYTES = 8;
/** Base64url lengths of the blob buckets 256, 1024, 4096, 16384 bytes (roomBlob.ts). */
export const BLOB_TEXT_LENGTHS: readonly number[] = [342, 1366, 5462, 21846];
/** Largest client frame: the largest blob plus the JSON around it. */
export const MAX_FRAME_CHARS = 21846 + 64;

/** Close codes (4000–4999 are the application's). */
export const CLOSE = {
  authFailed: 4001,
  authTimeout: 4002,
  protocol: 4003,
  rate: 4008,
  tooBig: 4009,
  full: 4010,
  disabled: 4503,
} as const;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export function toB64u(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL[b0 >> 2]!;
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)]!;
    if (i + 1 < bytes.length) out += B64URL[((b1 & 15) << 2) | (b2 >> 6)]!;
    if (i + 2 < bytes.length) out += B64URL[b2 & 63]!;
  }
  return out;
}

/**
 * Strict decode of unpadded base64url of exactly `length` bytes (canonical
 * trailing bits), or undefined.
 */
export function fromB64uLen(text: unknown, length: number): Uint8Array | undefined {
  if (typeof text !== 'string' || text.length !== Math.ceil((length * 4) / 3)) return undefined;
  if (!B64URL_RE.test(text)) return undefined;
  const out = new Uint8Array(length);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc << 6) | B64URL.indexOf(text[i]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < length) out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  // Leftover bits must be zero (one text form per byte string).
  if ((acc & ((1 << bits) - 1)) !== 0) return undefined;
  return out;
}

export function isRoomId(value: unknown): value is string {
  return fromB64uLen(value, ROOM_ID_BYTES) !== undefined;
}

export function isHandle(value: unknown): value is string {
  return fromB64uLen(value, HANDLE_BYTES) !== undefined;
}

/** A blob as the server accepts it: base64url text of one bucket size. Not decoded. */
export function isBlobText(value: unknown): value is string {
  return (
    typeof value === 'string' && BLOB_TEXT_LENGTHS.includes(value.length) && B64URL_RE.test(value)
  );
}

export type ClientFrame =
  { t: 'auth'; pub: string; sig: string } | { t: 'm'; to: string; b: string } | { t: 'turn' };

/**
 * Parse one client frame. Strict: unknown types, extra keys and wrong shapes
 * are `undefined` (the socket is then closed). Never throws.
 */
export function parseClientFrame(raw: unknown): ClientFrame | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_FRAME_CHARS) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  switch (o.t) {
    case 'auth':
      return keys === 'pub,sig,t' && typeof o.pub === 'string' && typeof o.sig === 'string'
        ? { t: 'auth', pub: o.pub, sig: o.sig }
        : undefined;
    case 'm':
      return keys === 'b,t,to' && (o.to === '*' || isHandle(o.to)) && isBlobText(o.b)
        ? { t: 'm', to: o.to, b: o.b }
        : undefined;
    case 'turn':
      return keys === 't' ? { t: 'turn' } : undefined;
    default:
      return undefined;
  }
}

/** Seconds since the epoch, from milliseconds. */
export function unixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** A positive integer from a `[vars]` string, else the fallback. */
export function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
