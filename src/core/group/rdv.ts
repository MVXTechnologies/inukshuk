import { concatBytes, fromB64uLen, isB64uLen, toB64u, utf8 } from '../team/bytes';
import { derive, KEY_BYTES, safeVerify, SIG_BYTES, type TeamCrypto } from '../team/crypto';
import { TEAM_ID_BYTES } from '../team/ids';
import { INVITE_SEED_BYTES } from '../team/invite';

/**
 * Rendezvous (L0) room derivations for internet sync (2.7.0, #705).
 *
 * The server (`infra/rtc/worker`, a Durable Object per room) forwards opaque
 * blobs between sockets that proved they hold a room's signing key. It never
 * learns the group id, member ids or any key: a room is named by a hash of a
 * public key that only the group's members can derive, and that key changes
 * every UTC day and with every epoch (security review 2026-10 §2.4.1):
 *
 * ```
 * rs       = HKDF(epochKey, salt=groupId, "inukshuk/team/v1/rdv")         per epoch
 * ir       = HKDF(inviteSeed, salt=groupId, "inukshuk/team/v1/rdv-invite") per invite
 * d        = floor(unixSeconds / 86400)                                  UTC day
 * roomSeed = HKDF(rs, salt=u32be(d), "inukshuk/team/v1/rdv-sign")        Ed25519 seed
 * roomPub  = Ed25519.pub(roomSeed)
 * roomId   = base64url(SHA-256("inukshuk/rdv/v1/room" ‖ roomPub)[0..16])
 * roomKey  = HKDF(rs, salt=u32be(d), "inukshuk/team/v1/rdv-seal")        XChaCha20-Poly1305
 * ```
 *
 * Room entry signs `"inukshuk/rdv/v1/auth\n" ‖ host ‖ roomId ‖ challenge`
 * with `roomSeed`: the server's fresh challenge stops replay, the host stops a
 * signature from being reused against another deployment.
 *
 * The pinned vectors in `rdv.vectors.json` are checked here (noble) AND by the
 * Worker's own WebCrypto code (`infra/rtc/worker/test`), so phone and server
 * can never drift apart silently.
 */

/** Label prefix of every value the room server sees or checks (R-CRY-1). */
export const RDV_DOMAIN = 'inukshuk/rdv/v1/';
/** Bytes of SHA-256 kept for a room id (128 bits). */
export const ROOM_ID_BYTES = 16;
/** Characters of a room id (unpadded base64url of 16 bytes). */
export const ROOM_ID_CHARS = 22;
/** Bytes of the server's auth challenge. */
export const CHALLENGE_BYTES = 32;
/** Seconds in a UTC day (the room rotation period). */
export const DAY_SECONDS = 86_400;
/** After midnight UTC, clients also join yesterday's room for this long. */
export const YESTERDAY_GRACE_S = 600;

/** What a group needs to have a room: its id and its current epoch key. */
export interface GroupKeyContext {
  /** The group (team) id, base64url of 16 bytes. */
  groupId: string;
  /** The current epoch key (32 bytes). */
  epochKey: Uint8Array;
}

/** One day's room of one rendezvous secret. */
export interface Room {
  day: number;
  /** Ed25519 seed that signs the room's auth challenges. Secret. */
  roomSeed: Uint8Array;
  roomPub: Uint8Array;
  /** What the server sees: `/v1/r/<roomId>`. */
  roomId: string;
  /** XChaCha20-Poly1305 key of the room's blobs (`roomBlob.ts`). Secret. */
  roomKey: Uint8Array;
}

function groupSalt(groupId: string): Uint8Array {
  const salt = fromB64uLen(groupId, TEAM_ID_BYTES);
  if (salt === undefined) throw new TypeError('rdv: groupId must be base64url of 16 bytes');
  return salt;
}

export function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('rdv: not a u32');
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

/** `rs`: the group's rendezvous secret for its current epoch. */
export function rendezvousSecret(c: TeamCrypto, ctx: GroupKeyContext): Uint8Array {
  if (ctx.epochKey.length !== KEY_BYTES) throw new TypeError('rdv: epochKey must be 32 bytes');
  return derive(c, ctx.epochKey, groupSalt(ctx.groupId), 'rdv');
}

/**
 * `ir`: an invite's rendezvous secret, from the invite seed (the joiner has
 * no epoch key yet). Members learn it from the admin-owned `irdv` record.
 */
export function inviteRendezvousSecret(
  c: TeamCrypto,
  groupId: string,
  inviteSeed: Uint8Array,
): Uint8Array {
  if (inviteSeed.length !== INVITE_SEED_BYTES) throw new TypeError('rdv: invite seed length');
  return derive(c, inviteSeed, groupSalt(groupId), 'rdv-invite');
}

/** UTC day number of a unix time in seconds. */
export function utcDay(unixSeconds: number): number {
  return Math.floor(unixSeconds / DAY_SECONDS);
}

/**
 * The days whose rooms a client should be in at `unixSeconds`: today, plus
 * yesterday during the first {@link YESTERDAY_GRACE_S} seconds after
 * midnight UTC (so a peer whose clock is a little behind still meets us).
 */
export function roomDays(unixSeconds: number): number[] {
  const today = utcDay(unixSeconds);
  const sinceMidnight = unixSeconds - today * DAY_SECONDS;
  return sinceMidnight < YESTERDAY_GRACE_S && today > 0 ? [today, today - 1] : [today];
}

/** `roomId` of a room public key (what the server recomputes to admit a socket). */
export function roomIdForPub(c: TeamCrypto, roomPub: Uint8Array): string {
  const digest = c.sha256(concatBytes(utf8(RDV_DOMAIN + 'room'), roomPub));
  return toB64u(digest.subarray(0, ROOM_ID_BYTES));
}

export function isRoomId(value: unknown): value is string {
  return isB64uLen(value, ROOM_ID_BYTES);
}

/** One day's room of a rendezvous secret (`rs` or `ir`). */
export function deriveRoom(c: TeamCrypto, rs: Uint8Array, day: number): Room {
  if (rs.length !== KEY_BYTES) throw new TypeError('rdv: secret must be 32 bytes');
  const salt = u32be(day);
  const roomSeed = derive(c, rs, salt, 'rdv-sign');
  const roomPub = c.ed25519.publicKey(roomSeed);
  return {
    day,
    roomSeed,
    roomPub,
    roomId: roomIdForPub(c, roomPub),
    roomKey: derive(c, rs, salt, 'rdv-seal'),
  };
}

/** The rooms a group's members meet in at `unixSeconds` (today, maybe yesterday). */
export function groupRooms(c: TeamCrypto, ctx: GroupKeyContext, unixSeconds: number): Room[] {
  const rs = rendezvousSecret(c, ctx);
  return roomDays(unixSeconds).map((d) => deriveRoom(c, rs, d));
}

/** The bytes a socket signs to enter `roomId` on `host`. */
export function authMessage(host: string, roomId: string, challenge: Uint8Array): Uint8Array {
  return concatBytes(utf8(RDV_DOMAIN + 'auth\n'), utf8(host), utf8(roomId), challenge);
}

/** The room-entry signature over the server's challenge. */
export function signAuth(
  c: TeamCrypto,
  room: Room,
  host: string,
  challenge: Uint8Array,
): Uint8Array {
  if (challenge.length !== CHALLENGE_BYTES) throw new TypeError('rdv: challenge length');
  return c.ed25519.sign(authMessage(host, room.roomId, challenge), room.roomSeed);
}

/**
 * The server-side check, for tests and the simulator (the Worker implements
 * the same rule with WebCrypto): the key hashes to the room id and signs the
 * challenge. Total: hostile input is `false`, never a throw.
 */
export function verifyAuth(
  c: TeamCrypto,
  host: string,
  roomId: string,
  challenge: Uint8Array,
  roomPub: Uint8Array | undefined,
  signature: Uint8Array | undefined,
): boolean {
  if (!isRoomId(roomId) || challenge.length !== CHALLENGE_BYTES) return false;
  if (roomPub?.length !== KEY_BYTES || signature?.length !== SIG_BYTES) return false;
  if (roomIdForPub(c, roomPub) !== roomId) return false;
  return safeVerify(c, signature, authMessage(host, roomId, challenge), roomPub);
}
