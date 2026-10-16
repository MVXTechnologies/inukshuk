import { concatBytes, fromB64u, isB64uLen, toB64u, toHex, utf8 } from '../team/bytes';
import { KEY_BYTES, NONCE_BYTES, safeOpen, TAG_BYTES, type TeamCrypto } from '../team/crypto';

import { isRoomId, RDV_DOMAIN, u32be } from './rdv';

/**
 * Room blob codec (2.7.0 rendezvous, security review 2026-10 §2.4.2, §2.7,
 * R-RDV-3, R-META-3).
 *
 * Everything a phone sends through a room is one blob, sealed under the day's
 * `roomKey` and padded to a size bucket, so the server forwards bytes it can't
 * read and whose sizes say nothing beyond the bucket:
 *
 * ```
 * blob  = ver(1) ‖ ts u32be(4) ‖ nonce(24) ‖ XChaCha20-Poly1305(roomKey, nonce, plain, aad)
 * plain = u16be(len) ‖ payload ‖ zero padding          (blob length ∈ 256, 1 Ki, 4 Ki, 16 Ki)
 * aad   = "inukshuk/rdv/v1/blob\n" ‖ roomId ‖ u32be(day) ‖ ver ‖ ts ‖ fromHandle
 * ```
 *
 * - `ts` (unix seconds) is clear but authenticated: a blob older than
 *   {@link FRESH_PAST_S} (or more than {@link FRESH_FUTURE_S} ahead) is
 *   dropped before decryption, so a stale replay costs nothing. Phones take
 *   `now` from the server's clock (`chal.now`), not their own.
 * - `fromHandle` is the sender's room handle as the server stamps it on
 *   delivery. Binding it means the server can't re-attribute (splice) a blob
 *   to another socket or room: the AEAD fails.
 * - {@link ReplayWindow} drops a blob seen before inside the freshness window.
 *
 * Decoding is total: hostile bytes give `undefined`, never a throw.
 */

export const ROOM_BLOB_VERSION = 1;
/** Every blob is exactly one of these sizes (bytes). */
export const ROOM_BLOB_BUCKETS: readonly number[] = [256, 1024, 4096, 16384];
/** The largest blob (R-RL-2: the server refuses anything bigger). */
export const ROOM_BLOB_MAX_BYTES = 16384;
/** ver + ts. */
const HEADER_BYTES = 5;
const LEN_BYTES = 2;
const OVERHEAD = HEADER_BYTES + NONCE_BYTES + TAG_BYTES + LEN_BYTES;
/** Largest payload one blob carries. */
export const ROOM_BLOB_MAX_PAYLOAD = ROOM_BLOB_MAX_BYTES - OVERHEAD;
/** Blobs older than this are dropped (seconds). */
export const FRESH_PAST_S = 300;
/** Blobs dated further ahead than this are dropped (seconds). */
export const FRESH_FUTURE_S = 60;
/** A room handle: 8 random bytes, base64url (11 characters), assigned by the server. */
export const HANDLE_BYTES = 8;

export function isHandle(value: unknown): value is string {
  return isB64uLen(value, HANDLE_BYTES);
}

/** The keys of one day's room, from `deriveRoom`. */
export interface RoomBlobContext {
  roomId: string;
  day: number;
  roomKey: Uint8Array;
}

/** The smallest bucket that fits `payloadBytes`, or undefined when none does. */
export function bucketFor(payloadBytes: number): number | undefined {
  return ROOM_BLOB_BUCKETS.find((b) => b - OVERHEAD >= payloadBytes);
}

/** Base64url text lengths of the buckets (what the server checks). */
export const ROOM_BLOB_TEXT_LENGTHS: readonly number[] = ROOM_BLOB_BUCKETS.map((b) =>
  Math.ceil((b * 4) / 3),
);

function aad(ctx: RoomBlobContext, header: Uint8Array, fromHandle: string): Uint8Array {
  return concatBytes(
    utf8(RDV_DOMAIN + 'blob\n'),
    utf8(ctx.roomId),
    u32be(ctx.day),
    header,
    utf8(fromHandle),
  );
}

function header(ts: number): Uint8Array {
  return concatBytes(new Uint8Array([ROOM_BLOB_VERSION]), u32be(ts));
}

function checkContext(ctx: RoomBlobContext): boolean {
  return (
    isRoomId(ctx.roomId) &&
    ctx.roomKey.length === KEY_BYTES &&
    Number.isInteger(ctx.day) &&
    ctx.day >= 0 &&
    ctx.day <= 0xffffffff
  );
}

/**
 * Seal `payload` as a blob from `fromHandle` at `nowSeconds` (server time).
 * Throws on a programmer error: an oversized payload or a bad context.
 */
export function sealRoomBlob(
  c: TeamCrypto,
  ctx: RoomBlobContext,
  fromHandle: string,
  payload: Uint8Array,
  nowSeconds: number,
): Uint8Array {
  if (!checkContext(ctx) || !isHandle(fromHandle)) throw new TypeError('roomBlob: bad context');
  const size = bucketFor(payload.length);
  if (size === undefined) throw new RangeError('roomBlob: payload too large');
  const head = header(Math.floor(nowSeconds));
  const plain = new Uint8Array(size - HEADER_BYTES - NONCE_BYTES - TAG_BYTES);
  plain[0] = payload.length >>> 8;
  plain[1] = payload.length & 255;
  plain.set(payload, LEN_BYTES);
  const nonce = c.randomBytes(NONCE_BYTES);
  const sealed = c.aead.seal(ctx.roomKey, nonce, plain, aad(ctx, head, fromHandle));
  return concatBytes(head, nonce, sealed);
}

/** Header fields of a blob, without opening it (sizes and freshness only). */
export function peekRoomBlob(blob: unknown): { ts: number; nonce: Uint8Array } | undefined {
  if (!(blob instanceof Uint8Array) || !ROOM_BLOB_BUCKETS.includes(blob.length)) return undefined;
  if (blob[0] !== ROOM_BLOB_VERSION) return undefined;
  const ts = ((blob[1]! << 24) | (blob[2]! << 16) | (blob[3]! << 8) | blob[4]!) >>> 0;
  return { ts, nonce: blob.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES) };
}

export function isFresh(ts: number, nowSeconds: number): boolean {
  return ts >= nowSeconds - FRESH_PAST_S && ts <= nowSeconds + FRESH_FUTURE_S;
}

/**
 * Open a blob delivered as from `fromHandle`. `undefined` for anything that
 * is not a fresh, authentic, well-padded blob of this room and day.
 */
export function openRoomBlob(
  c: TeamCrypto,
  ctx: RoomBlobContext,
  fromHandle: unknown,
  blob: unknown,
  nowSeconds: number,
): Uint8Array | undefined {
  if (!checkContext(ctx) || !isHandle(fromHandle)) return undefined;
  const head = peekRoomBlob(blob);
  if (head === undefined || !isFresh(head.ts, nowSeconds)) return undefined;
  const bytes = blob as Uint8Array;
  const plain = safeOpen(
    c,
    ctx.roomKey,
    head.nonce,
    bytes.subarray(HEADER_BYTES + NONCE_BYTES),
    aad(ctx, bytes.subarray(0, HEADER_BYTES), fromHandle),
  );
  if (plain === undefined || plain.length < LEN_BYTES) return undefined;
  const len = (plain[0]! << 8) | plain[1]!;
  if (LEN_BYTES + len > plain.length) return undefined;
  // Padding must be zeros: one plaintext, one blob shape.
  for (let i = LEN_BYTES + len; i < plain.length; i++) if (plain[i] !== 0) return undefined;
  return plain.slice(LEN_BYTES, LEN_BYTES + len);
}

/** {@link sealRoomBlob} as the base64url text the room protocol carries (`b`). */
export function sealRoomBlobText(
  c: TeamCrypto,
  ctx: RoomBlobContext,
  fromHandle: string,
  payload: Uint8Array,
  nowSeconds: number,
): string {
  return toB64u(sealRoomBlob(c, ctx, fromHandle, payload, nowSeconds));
}

/** {@link openRoomBlob} from the room protocol's base64url text. */
export function openRoomBlobText(
  c: TeamCrypto,
  ctx: RoomBlobContext,
  fromHandle: unknown,
  text: unknown,
  nowSeconds: number,
): Uint8Array | undefined {
  if (typeof text !== 'string' || !ROOM_BLOB_TEXT_LENGTHS.includes(text.length)) return undefined;
  return openRoomBlob(c, ctx, fromHandle, fromB64u(text), nowSeconds);
}

/**
 * Drops a blob whose nonce was already accepted inside the freshness window
 * (a relay replaying a recent blob). Bounded: past `maxEntries` the oldest
 * are forgotten, and a forgotten blob is stale soon after anyway.
 */
export class ReplayWindow {
  private readonly seen = new Map<string, number>();

  constructor(private readonly maxEntries = 4096) {}

  /** True the first time a fresh blob is seen; false for a repeat or a stale blob. */
  accept(blob: unknown, nowSeconds: number): boolean {
    const head = peekRoomBlob(blob);
    if (head === undefined || !isFresh(head.ts, nowSeconds)) return false;
    this.expire(nowSeconds);
    const key = toHex(head.nonce);
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, head.ts);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private expire(nowSeconds: number): void {
    for (const [key, ts] of this.seen) {
      if (ts < nowSeconds - FRESH_PAST_S) this.seen.delete(key);
    }
  }
}
