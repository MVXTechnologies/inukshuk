/**
 * Shared vectors (src/core/group/rdv.vectors.json): the Worker's WebCrypto
 * code must agree with the phone's noble code on room ids and auth
 * signatures (R-CRY-1, security review §6.3). The derivations are also redone
 * here with WebCrypto HKDF and Ed25519 (PKCS#8 import), independently of both.
 */
import { ed25519 } from '@noble/curves/ed25519.js';

import { isSmallOrderKey } from '../../../../src/core/team/nobleCrypto';
import { authMessage, isWeakKey, roomIdForPub, verifyRoomAuth } from '../src/rdvVerify';
import { BLOB_TEXT_LENGTHS, isBlobText, isRoomId, toB64u } from '../src/protocol';
import { ROOM_BLOB_TEXT_LENGTHS } from '../../../../src/core/group/roomBlob';
import { RDV_DOMAIN as CORE_DOMAIN } from '../../../../src/core/group/rdv';
import { RDV_DOMAIN } from '../src/protocol';
import { fromHexStr as hex, subtle, vectors as V } from './harness';

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
      key,
      256,
    ),
  );
}

async function ed25519Pub(seed: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array([...hex('302e020100300506032b657004220420'), ...seed]);
  const key = await subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await subtle.exportKey('jwk', key);
  return new Uint8Array(Buffer.from(jwk.x!, 'base64url'));
}

const u32 = (n: number) =>
  new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

describe('Worker and phone agree (shared vectors)', () => {
  it('same label domain and blob sizes', () => {
    expect(RDV_DOMAIN).toBe(CORE_DOMAIN);
    expect(BLOB_TEXT_LENGTHS).toEqual(ROOM_BLOB_TEXT_LENGTHS);
    expect(isBlobText(V.blob.blobB64u)).toBe(true);
  });

  it.each(V.rooms.map((r) => [r.secret, r.day, r] as const))(
    'WebCrypto recomputes the %s room id of day %d',
    async (_s, _d, r) => {
      expect(await roomIdForPub(subtle, hex(r.roomPub))).toBe(r.roomId);
      expect(isRoomId(r.roomId)).toBe(true);
    },
  );

  it('the auth message is byte-identical', () => {
    expect(toHex(authMessage(V.auth.host, V.auth.roomId, hex(V.auth.challenge)))).toBe(
      V.auth.message,
    );
  });

  it('WebCrypto verifies the phone’s pinned signature, and nothing else', async () => {
    const pub = toB64u(hex(V.auth.roomPub));
    const sig = toB64u(hex(V.auth.signature));
    const chal = hex(V.auth.challenge);
    expect(await verifyRoomAuth(subtle, V.auth.host, V.auth.roomId, chal, pub, sig)).toBe(true);
    expect(await verifyRoomAuth(subtle, 'other.host', V.auth.roomId, chal, pub, sig)).toBe(false);
    expect(await verifyRoomAuth(subtle, V.auth.host, V.rooms[1]!.roomId, chal, pub, sig)).toBe(
      false,
    );
    const chal2 = chal.slice();
    chal2[0] ^= 1;
    expect(await verifyRoomAuth(subtle, V.auth.host, V.auth.roomId, chal2, pub, sig)).toBe(false);
    const sig2 = hex(V.auth.signature);
    sig2[63] ^= 0x10;
    expect(await verifyRoomAuth(subtle, V.auth.host, V.auth.roomId, chal, pub, toB64u(sig2))).toBe(
      false,
    );
    expect(await verifyRoomAuth(subtle, V.auth.host, V.auth.roomId, chal, 'x', sig)).toBe(false);
    expect(await verifyRoomAuth(subtle, V.auth.host, V.auth.roomId, chal, pub, 42)).toBe(false);
  });

  it('refuses a non-canonical S (s + L) that plain math would accept', async () => {
    const L = (1n << 252n) + 27742317777372353535851937790883648493n;
    const sig = hex(V.auth.signature);
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]!);
    s += L;
    if (s < 1n << 256n) {
      for (let i = 0; i < 32; i++) sig[32 + i] = Number((s >> BigInt(8 * i)) & 255n);
      expect(
        await verifyRoomAuth(
          subtle,
          V.auth.host,
          V.auth.roomId,
          hex(V.auth.challenge),
          toB64u(hex(V.auth.roomPub)),
          toB64u(sig),
        ),
      ).toBe(false);
    }
  });
});

describe('independent WebCrypto derivation of the vectors', () => {
  it('rs, ir, roomSeed, roomPub, roomKey', async () => {
    const salt = hex(V.input.groupIdHex);
    const rs = await hkdf(hex(V.input.epochKey), salt, 'inukshuk/team/v1/rdv');
    const ir = await hkdf(hex(V.input.inviteSeed), salt, 'inukshuk/team/v1/rdv-invite');
    expect(toHex(rs)).toBe(V.rs);
    expect(toHex(ir)).toBe(V.ir);
    for (const r of V.rooms) {
      const s = r.secret === 'rs' ? rs : ir;
      const seed = await hkdf(s, u32(r.day), 'inukshuk/team/v1/rdv-sign');
      expect(toHex(seed)).toBe(r.roomSeed);
      expect(toHex(await ed25519Pub(seed))).toBe(r.roomPub);
      expect(toHex(await hkdf(s, u32(r.day), 'inukshuk/team/v1/rdv-seal'))).toBe(r.roomKey);
    }
  });
});

describe('isWeakKey matches noble’s small-order rule', () => {
  const P = ed25519.Point;
  const torsion = P.fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a');

  it('refuses all 8 small-order points, with either sign bit', () => {
    let acc = P.ZERO;
    for (let k = 0; k < 8; k++) {
      const b = acc.toBytes();
      expect(isSmallOrderKey(b)).toBe(true);
      expect(isWeakKey(b)).toBe(true);
      const flipped = b.slice();
      flipped[31] ^= 0x80;
      expect(isWeakKey(flipped)).toBe(true);
      acc = acc.add(torsion);
    }
  });

  it('refuses non-canonical encodings (y ≥ p)', () => {
    for (let low = 0xed; low <= 0xff; low++) {
      const b = new Uint8Array(32).fill(0xff);
      b[0] = low;
      b[31] = 0x7f;
      expect(isWeakKey(b)).toBe(true);
      b[31] = 0xff;
      expect(isWeakKey(b)).toBe(true);
    }
    expect(isWeakKey(new Uint8Array(31))).toBe(true);
  });

  it('accepts ordinary keys (the vectors’ and random ones)', () => {
    for (const r of V.rooms) expect(isWeakKey(hex(r.roomPub))).toBe(false);
    for (let i = 1; i < 50; i++) {
      const pub = ed25519.getPublicKey(new Uint8Array(32).fill(i));
      expect(isWeakKey(pub)).toBe(isSmallOrderKey(pub));
      expect(isWeakKey(pub)).toBe(false);
    }
  });
});
