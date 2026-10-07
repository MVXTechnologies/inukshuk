/**
 * TEST-ONLY {@link TeamCrypto} backed by Node's built-in OpenSSL (Ed25519,
 * X25519, SHA-256, HMAC, HKDF, ChaCha20-Poly1305). XChaCha20-Poly1305 is the
 * standard construction (draft-irtf-cfrg-xchacha §2.3): HChaCha20 subkey from
 * the first 16 nonce bytes (pure JS below), then IETF ChaCha20-Poly1305 with
 * nonce `0x00000000 ‖ nonce[16..24]`. Pinned to the RFC vectors in
 * `nodeCrypto.test.ts`.
 *
 * Never imported by app code (Hermes has no `node:crypto`); the device
 * implementation is the noble one recommended in `crypto.ts`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

import type { TeamCrypto } from '../crypto';
import { isSmallOrderKey } from '../nobleCrypto';

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const u8 = (b: Buffer | ArrayBuffer): Uint8Array =>
  b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.length);

function edPriv(seed: Uint8Array) {
  return createPrivateKey({
    key: Buffer.concat([ED_PKCS8, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}
function rawPublic(key: ReturnType<typeof createPublicKey>): Uint8Array {
  const der = key.export({ format: 'der', type: 'spki' });
  return u8(der.subarray(der.length - 32));
}
function xPriv(secret: Uint8Array) {
  return createPrivateKey({
    key: Buffer.concat([X_PKCS8, Buffer.from(secret)]),
    format: 'der',
    type: 'pkcs8',
  });
}

const rotl = (v: number, n: number) => ((v << n) | (v >>> (32 - n))) >>> 0;

/** HChaCha20 (draft-irtf-cfrg-xchacha §2.2): 32-byte key + 16-byte nonce → 32-byte subkey. */
export function hchacha20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  const kv = new DataView(key.buffer, key.byteOffset, 32);
  const nv = new DataView(nonce16.buffer, nonce16.byteOffset, 16);
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = kv.getUint32(i * 4, true);
  for (let i = 0; i < 4; i++) s[12 + i] = nv.getUint32(i * 4, true);
  const qr = (a: number, b: number, c: number, d: number) => {
    s[a] = (s[a]! + s[b]!) >>> 0;
    s[d] = rotl(s[d]! ^ s[a]!, 16);
    s[c] = (s[c]! + s[d]!) >>> 0;
    s[b] = rotl(s[b]! ^ s[c]!, 12);
    s[a] = (s[a]! + s[b]!) >>> 0;
    s[d] = rotl(s[d]! ^ s[a]!, 8);
    s[c] = (s[c]! + s[d]!) >>> 0;
    s[b] = rotl(s[b]! ^ s[c]!, 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12);
    qr(1, 5, 9, 13);
    qr(2, 6, 10, 14);
    qr(3, 7, 11, 15);
    qr(0, 5, 10, 15);
    qr(1, 6, 11, 12);
    qr(2, 7, 8, 13);
    qr(3, 4, 9, 14);
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => ov.setUint32(i * 4, s[w]!, true));
  return out;
}

function xNonce(key: Uint8Array, nonce: Uint8Array): { sub: Buffer; iv: Buffer } {
  if (key.length !== 32 || nonce.length !== 24) throw new Error('bad xchacha key/nonce');
  const sub = Buffer.from(hchacha20(key, nonce.subarray(0, 16)));
  const iv = Buffer.concat([Buffer.alloc(4), Buffer.from(nonce.subarray(16, 24))]);
  return { sub, iv };
}

export const nodeCrypto: TeamCrypto = {
  randomBytes: (n) => u8(randomBytes(n)),
  sha256: (d) => u8(createHash('sha256').update(d).digest()),
  hmacSha256: (k, d) => u8(createHmac('sha256', k).update(d).digest()),
  hkdfSha256: (ikm, salt, info, length) => u8(hkdfSync('sha256', ikm, salt, info, length)),
  ed25519: {
    publicKey: (seed) => rawPublic(createPublicKey(edPriv(seed))),
    sign: (msg, seed) => u8(sign(null, msg, edPriv(seed))),
    // OpenSSL accepts small-order keys; the protocol requires refusing them.
    verify: (sig, msg, pub) =>
      !isSmallOrderKey(pub) &&
      verify(
        null,
        msg,
        createPublicKey({
          key: Buffer.concat([ED_SPKI, Buffer.from(pub)]),
          format: 'der',
          type: 'spki',
        }),
        sig,
      ),
  },
  x25519: {
    publicKey: (secret) => rawPublic(createPublicKey(xPriv(secret))),
    sharedSecret: (secret, pub) =>
      u8(
        diffieHellman({
          privateKey: xPriv(secret),
          publicKey: createPublicKey({
            key: Buffer.concat([X_SPKI, Buffer.from(pub)]),
            format: 'der',
            type: 'spki',
          }),
        }),
      ),
  },
  aead: {
    seal(key, nonce, plaintext, aad) {
      const { sub, iv } = xNonce(key, nonce);
      const c = createCipheriv('chacha20-poly1305', sub, iv, { authTagLength: 16 });
      c.setAAD(aad, { plaintextLength: plaintext.length });
      const body = Buffer.concat([c.update(plaintext), c.final()]);
      return u8(Buffer.concat([body, c.getAuthTag()]));
    },
    open(key, nonce, ciphertext, aad) {
      if (ciphertext.length < 16) return undefined;
      const { sub, iv } = xNonce(key, nonce);
      const d = createDecipheriv('chacha20-poly1305', sub, iv, { authTagLength: 16 });
      const body = ciphertext.subarray(0, ciphertext.length - 16);
      d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      d.setAAD(aad, { plaintextLength: body.length });
      try {
        return u8(Buffer.concat([d.update(body), d.final()]));
      } catch {
        return undefined;
      }
    },
  },
};
