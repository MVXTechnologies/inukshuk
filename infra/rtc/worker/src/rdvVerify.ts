import { fromB64uLen, RDV_DOMAIN, ROOM_ID_BYTES, toB64u } from './protocol';

/**
 * Room entry check (R-RDV-2), with WebCrypto only (R-CRY-1): the socket's
 * public key must hash to the room id it connected to, and must sign
 * `"inukshuk/rdv/v1/auth\n" ‖ host ‖ roomId ‖ challenge`. Same rule as
 * `verifyAuth` in src/core/group/rdv.ts; both pass the shared vectors.
 */

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** `roomId` of a room public key: base64url(SHA-256(label ‖ pub)[0..16]). */
export async function roomIdForPub(subtle: SubtleCrypto, pub: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await subtle.digest('SHA-256', concat(enc.encode(RDV_DOMAIN + 'room'), pub)),
  );
  return toB64u(digest.subarray(0, ROOM_ID_BYTES));
}

export function authMessage(host: string, roomId: string, challenge: Uint8Array): Uint8Array {
  return concat(enc.encode(RDV_DOMAIN + 'auth\n'), enc.encode(host), enc.encode(roomId), challenge);
}

/**
 * y-coordinates (sign bit cleared) of the eight small-order Ed25519 points.
 * A key with one of them verifies trivial signatures for any message, so it
 * is refused outright (as noble's `isSmallOrder` does on the phone).
 */
const SMALL_ORDER_Y: readonly string[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
];

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Whether a 32-byte Ed25519 public key is refused before verification:
 * a non-canonical encoding (y ≥ p) or a small-order point.
 */
export function isWeakKey(pub: Uint8Array): boolean {
  if (pub.length !== 32) return true;
  const y = pub.slice();
  y[31] = y[31]! & 0x7f;
  // y ≥ p = 2^255 - 19 ⇔ bytes 1..30 are 0xff, byte 31 is 0x7f and byte 0 ≥ 0xed.
  let allFF = y[31] === 0x7f;
  for (let i = 1; i < 31 && allFF; i++) allFF = y[i] === 0xff;
  if (allFF && y[0]! >= 0xed) return true;
  return SMALL_ORDER_Y.includes(hex(y));
}

/**
 * True when `pubText`/`sigText` (base64url) admit a socket to `roomId` for
 * `challenge` on `host`. Total: anything malformed is false.
 */
export async function verifyRoomAuth(
  subtle: SubtleCrypto,
  host: string,
  roomId: string,
  challenge: Uint8Array,
  pubText: unknown,
  sigText: unknown,
): Promise<boolean> {
  const pub = fromB64uLen(pubText, 32);
  const sig = fromB64uLen(sigText, 64);
  if (pub === undefined || sig === undefined || isWeakKey(pub)) return false;
  try {
    if ((await roomIdForPub(subtle, pub)) !== roomId) return false;
    const key = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, key, sig, authMessage(host, roomId, challenge));
  } catch {
    return false;
  }
}
