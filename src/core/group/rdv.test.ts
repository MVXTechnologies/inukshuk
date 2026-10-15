import { createHash, hkdfSync } from 'node:crypto';

import { concatBytes, fromHex, toB64u, toHex, utf8 } from '../team/bytes';
import type { TeamCrypto } from '../team/crypto';
import { nobleCrypto } from '../team/testing/noble';
import { nodeCrypto } from '../team/testing/nodeCrypto';
import { mulberry32 } from '../team/testing/prop';

import {
  authMessage,
  CHALLENGE_BYTES,
  DAY_SECONDS,
  deriveRoom,
  groupRooms,
  inviteRendezvousSecret,
  isRoomId,
  rendezvousSecret,
  roomDays,
  roomIdForPub,
  ROOM_ID_CHARS,
  signAuth,
  u32be,
  utcDay,
  verifyAuth,
  YESTERDAY_GRACE_S,
} from './rdv';
import vectors from './rdv.vectors.json';

const hex = (h: string) => fromHex(h)!;
const V = vectors;
const ctx = { groupId: V.input.groupId, epochKey: hex(V.input.epochKey) };

/**
 * An independent derivation with Node's own HKDF/SHA-256 (OpenSSL), so the
 * pinned vectors are not only "what rdv.ts happened to output".
 */
function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, salt, utf8(info), 32));
}

describe.each<[string, TeamCrypto]>([
  ['noble', nobleCrypto],
  ['node', nodeCrypto],
])('%s: pinned rendezvous vectors (R-CRY-1)', (_name, c) => {
  it('derives rs and ir', () => {
    expect(toHex(rendezvousSecret(c, ctx))).toBe(V.rs);
    expect(toHex(inviteRendezvousSecret(c, V.input.groupId, hex(V.input.inviteSeed)))).toBe(V.ir);
  });

  it.each(V.rooms.map((r) => [r.secret, r.day, r] as const))(
    'derives the %s room of day %d',
    (secret, day, want) => {
      const s = hex(secret === 'rs' ? V.rs : V.ir);
      const room = deriveRoom(c, s, day);
      expect(toHex(room.roomSeed)).toBe(want.roomSeed);
      expect(toHex(room.roomPub)).toBe(want.roomPub);
      expect(room.roomId).toBe(want.roomId);
      expect(toHex(room.roomKey)).toBe(want.roomKey);
      expect(room.day).toBe(day);
    },
  );

  it('signs the pinned auth message (Ed25519 is deterministic)', () => {
    const room = deriveRoom(c, hex(V.rs), V.rooms[0]!.day);
    const chal = hex(V.auth.challenge);
    expect(toHex(authMessage(V.auth.host, room.roomId, chal))).toBe(V.auth.message);
    expect(toHex(signAuth(c, room, V.auth.host, chal))).toBe(V.auth.signature);
    expect(
      verifyAuth(c, V.auth.host, V.auth.roomId, chal, hex(V.auth.roomPub), hex(V.auth.signature)),
    ).toBe(true);
  });
});

describe('vectors match an independent derivation (Node HKDF + SHA-256)', () => {
  it('rs, ir, roomSeed, roomKey and roomId', () => {
    const groupSalt = hex(V.input.groupIdHex);
    expect(toB64u(groupSalt)).toBe(V.input.groupId);
    const rs = hkdf(hex(V.input.epochKey), groupSalt, 'inukshuk/team/v1/rdv');
    const ir = hkdf(hex(V.input.inviteSeed), groupSalt, 'inukshuk/team/v1/rdv-invite');
    expect(toHex(rs)).toBe(V.rs);
    expect(toHex(ir)).toBe(V.ir);
    for (const r of V.rooms) {
      const s = r.secret === 'rs' ? rs : ir;
      const day = u32be(r.day);
      expect(toHex(hkdf(s, day, 'inukshuk/team/v1/rdv-sign'))).toBe(r.roomSeed);
      expect(toHex(hkdf(s, day, 'inukshuk/team/v1/rdv-seal'))).toBe(r.roomKey);
      const digest = createHash('sha256')
        .update(concatBytes(utf8('inukshuk/rdv/v1/room'), hex(r.roomPub)))
        .digest();
      expect(toB64u(new Uint8Array(digest).subarray(0, 16))).toBe(r.roomId);
    }
  });
});

describe('days and rollover', () => {
  it('matches the pinned roomDays table', () => {
    for (const row of V.roomDays) expect(roomDays(row.unixSeconds)).toEqual(row.days);
  });

  it('joins yesterday only in the first 10 minutes after midnight UTC', () => {
    const midnight = 20_000 * DAY_SECONDS;
    expect(roomDays(midnight - 1)).toEqual([19_999]);
    expect(roomDays(midnight)).toEqual([20_000, 19_999]);
    expect(roomDays(midnight + YESTERDAY_GRACE_S - 1)).toEqual([20_000, 19_999]);
    expect(roomDays(midnight + YESTERDAY_GRACE_S)).toEqual([20_000]);
    expect(roomDays(0)).toEqual([0]); // no day -1
    expect(utcDay(midnight + DAY_SECONDS - 1)).toBe(20_000);
  });

  it('gives a different, unlinkable room every day', () => {
    const rs = rendezvousSecret(nobleCrypto, ctx);
    const ids = new Set<string>();
    for (let d = 20_000; d < 20_030; d++) ids.add(deriveRoom(nobleCrypto, rs, d).roomId);
    expect(ids.size).toBe(30);
  });

  it('groupRooms derives today and, near midnight, yesterday', () => {
    const t = V.roomDays[0]!.unixSeconds;
    const rooms = groupRooms(nobleCrypto, ctx, t);
    expect(rooms.map((r) => r.roomId)).toEqual([V.rooms[0]!.roomId, V.rooms[1]!.roomId]);
    expect(groupRooms(nobleCrypto, ctx, t + YESTERDAY_GRACE_S)).toHaveLength(1);
  });
});

describe('R-RDV-1: rooms follow the epoch and reveal no group secret', () => {
  it('a new epoch key gives a new room (a removed member can no longer find it)', () => {
    const day = V.rooms[0]!.day;
    const before = deriveRoom(nobleCrypto, rendezvousSecret(nobleCrypto, ctx), day);
    const rotated = { ...ctx, epochKey: new Uint8Array(32).fill(7) };
    const after = deriveRoom(nobleCrypto, rendezvousSecret(nobleCrypto, rotated), day);
    expect(after.roomId).not.toBe(before.roomId);
    expect(toHex(after.roomKey)).not.toBe(toHex(before.roomKey));
    // The old room's key can't sign for the new room.
    const chal = new Uint8Array(CHALLENGE_BYTES).fill(1);
    const sig = signAuth(nobleCrypto, before, 'h', chal);
    expect(verifyAuth(nobleCrypto, 'h', after.roomId, chal, before.roomPub, sig)).toBe(false);
  });

  it('another group with the same epoch key gets another room', () => {
    const other = { ...ctx, groupId: toB64u(new Uint8Array(16).fill(9)) };
    expect(toHex(rendezvousSecret(nobleCrypto, other))).not.toBe(V.rs);
  });

  it('the invite room differs from the group room', () => {
    expect(V.ir).not.toBe(V.rs);
  });

  it('what the server sees (room id, public key, auth message) never contains the group id or keys', () => {
    const room = deriveRoom(nobleCrypto, hex(V.rs), V.rooms[0]!.day);
    const seen = [
      room.roomId,
      toHex(room.roomPub),
      toHex(authMessage(V.auth.host, room.roomId, hex(V.auth.challenge))),
    ].join('|');
    for (const secret of [V.input.groupId, V.input.groupIdHex, V.input.epochKey, V.rs, V.ir]) {
      expect(seen).not.toContain(secret);
    }
    expect(seen).not.toContain(toHex(room.roomKey));
    expect(seen).not.toContain(toHex(room.roomSeed));
  });
});

describe('R-RDV-2: room entry by signature over challenge and host', () => {
  const c = nobleCrypto;
  const room = deriveRoom(c, hex(V.rs), V.rooms[0]!.day);
  const chal = new Uint8Array(CHALLENGE_BYTES).fill(3);
  const sig = signAuth(c, room, 'rtc.example.org', chal);

  it('accepts the right key, host, room and challenge', () => {
    expect(verifyAuth(c, 'rtc.example.org', room.roomId, chal, room.roomPub, sig)).toBe(true);
  });

  it('refuses another host (no replay across deployments)', () => {
    expect(verifyAuth(c, 'rtc.evil.org', room.roomId, chal, room.roomPub, sig)).toBe(false);
  });

  it('refuses another challenge (no replay across sockets)', () => {
    const other = new Uint8Array(CHALLENGE_BYTES).fill(4);
    expect(verifyAuth(c, 'rtc.example.org', room.roomId, other, room.roomPub, sig)).toBe(false);
  });

  it('refuses a key that does not hash to the room id', () => {
    const otherRoom = deriveRoom(c, hex(V.ir), V.rooms[0]!.day);
    const otherSig = signAuth(c, otherRoom, 'rtc.example.org', chal);
    expect(verifyAuth(c, 'rtc.example.org', room.roomId, chal, otherRoom.roomPub, otherSig)).toBe(
      false,
    );
  });

  it('refuses a small-order key even when the room id is its hash', () => {
    const identity = hex('0100000000000000000000000000000000000000000000000000000000000000');
    const forged = new Uint8Array(64);
    forged[0] = 1;
    const id = roomIdForPub(c, identity);
    expect(verifyAuth(c, 'h', id, chal, identity, forged)).toBe(false);
  });

  it('refuses malformed input without throwing', () => {
    expect(verifyAuth(c, 'h', 'short', chal, room.roomPub, sig)).toBe(false);
    expect(verifyAuth(c, 'h', room.roomId, chal.subarray(1), room.roomPub, sig)).toBe(false);
    expect(verifyAuth(c, 'h', room.roomId, chal, undefined, sig)).toBe(false);
    expect(verifyAuth(c, 'h', room.roomId, chal, room.roomPub, undefined)).toBe(false);
    expect(verifyAuth(c, 'h', room.roomId, chal, room.roomPub.subarray(1), sig)).toBe(false);
  });

  it('fuzz: random keys, signatures and ids never verify and never throw', () => {
    const rand = mulberry32(270);
    const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
    for (let i = 0; i < 300; i++) {
      const pub = bytes(i % 7 === 0 ? 31 : 32);
      const id = i % 2 === 0 ? roomIdForPub(c, pub) : toB64u(bytes(16));
      expect(verifyAuth(c, 'h', id, bytes(32), pub, bytes(64))).toBe(false);
    }
  });
});

describe('shapes and programmer errors', () => {
  it('room ids are 22 base64url characters', () => {
    for (const r of V.rooms) expect(r.roomId).toHaveLength(ROOM_ID_CHARS);
    expect(isRoomId(V.rooms[0]!.roomId)).toBe(true);
    expect(isRoomId('MbsTLokc2O13vZl9l7SEm')).toBe(false);
    expect(isRoomId('MbsTLokc2O13vZl9l7SEm/')).toBe(false);
    expect(isRoomId(42)).toBe(false);
  });

  it('throws on wrong key, seed, group id, day or challenge sizes', () => {
    const c = nobleCrypto;
    expect(() => rendezvousSecret(c, { ...ctx, epochKey: new Uint8Array(31) })).toThrow(TypeError);
    expect(() => rendezvousSecret(c, { ...ctx, groupId: 'nope' })).toThrow(TypeError);
    expect(() => inviteRendezvousSecret(c, V.input.groupId, new Uint8Array(15))).toThrow(TypeError);
    expect(() => deriveRoom(c, new Uint8Array(16), 1)).toThrow(TypeError);
    expect(() => deriveRoom(c, hex(V.rs), -1)).toThrow(RangeError);
    expect(() => deriveRoom(c, hex(V.rs), 1.5)).toThrow(RangeError);
    expect(() => u32be(2 ** 32)).toThrow(RangeError);
    const room = deriveRoom(c, hex(V.rs), 1);
    expect(() => signAuth(c, room, 'h', new Uint8Array(31))).toThrow(TypeError);
  });

  it('u32be is big-endian', () => {
    expect(Array.from(u32be(0x01020304))).toEqual([1, 2, 3, 4]);
    expect(Array.from(u32be(0xffffffff))).toEqual([255, 255, 255, 255]);
  });
});
