import { concatBytes, fromHex, toHex, utf8 } from './bytes';
import type { TeamCrypto } from './crypto';
import { createNobleCrypto } from './nobleCrypto';
import { nobleCrypto } from './testing/noble';
import { hchacha20, nodeCrypto } from './testing/nodeCrypto';

const hex = (h: string) => fromHex(h.replace(/\s+/g, ''))!;

/**
 * Both implementations are held to the same RFC vectors: noble (shipped on
 * device) and Node/OpenSSL (the fast test double the other suites use).
 */
describe.each<[string, TeamCrypto]>([
  ['noble', nobleCrypto],
  ['node', nodeCrypto],
])('%s — RFC vectors', (_name, c) => {
  it('Ed25519, RFC 8032 §7.1 test 1', () => {
    const seed = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    const pub = c.ed25519.publicKey(seed);
    expect(toHex(pub)).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const sig = c.ed25519.sign(new Uint8Array(0), seed);
    expect(toHex(sig)).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    expect(c.ed25519.verify(sig, new Uint8Array(0), pub)).toBe(true);
    expect(c.ed25519.verify(sig, new Uint8Array([1]), pub)).toBe(false);
  });

  it('refuses small-order public keys (identity-point forgery)', () => {
    // A = identity, R = identity, S = 0 satisfies [S]B = R + [k]A for every message.
    const identity = hex('0100000000000000000000000000000000000000000000000000000000000000');
    const forged = concatBytes(identity, new Uint8Array(32));
    for (const msg of [utf8('anything'), new Uint8Array(0)]) {
      expect(c.ed25519.verify(forged, msg, identity)).toBe(false);
    }
    // An order-8 torsion point as the key is refused too.
    const torsion = hex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a');
    expect(c.ed25519.verify(forged, utf8('x'), torsion)).toBe(false);
  });

  it('X25519, RFC 7748 §6.1', () => {
    const a = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const b = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
    expect(toHex(c.x25519.publicKey(a))).toBe(
      '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    );
    const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
    expect(toHex(c.x25519.sharedSecret(a, c.x25519.publicKey(b)))).toBe(shared);
    expect(toHex(c.x25519.sharedSecret(b, c.x25519.publicKey(a)))).toBe(shared);
  });

  it('XChaCha20-Poly1305, draft-irtf-cfrg-xchacha-03 §A.3.1', () => {
    const pt = utf8(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const aad = hex('50515253c0c1c2c3c4c5c6c7');
    const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const iv = hex('404142434445464748494a4b4c4d4e4f5051525354555657');
    const sealed = c.aead.seal(key, iv, pt, aad);
    expect(toHex(sealed)).toBe(
      'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
        '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
        '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
        '21f9664c97637da9768812f615c68b13b52e' +
        'c0875924c1c7987947deafd8780acf49',
    );
    expect(toHex(c.aead.open(key, iv, sealed, aad)!)).toBe(toHex(pt));
    const bad = sealed.slice();
    bad[0] = bad[0]! ^ 1;
    expect(c.aead.open(key, iv, bad, aad)).toBeUndefined();
    expect(c.aead.open(key, iv, sealed.subarray(0, 8), aad)).toBeUndefined();
  });

  it('HKDF-SHA256, RFC 5869 test case 1', () => {
    const okm = c.hkdfSha256(
      hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
      hex('000102030405060708090a0b0c'),
      hex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('SHA-256 (FIPS 180-2) and HMAC-SHA256 (RFC 4231 test case 2)', () => {
    expect(toHex(c.sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(toHex(c.hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(c.randomBytes(7)).toHaveLength(7);
  });
});

describe('node test double internals', () => {
  it('HChaCha20, draft-irtf-cfrg-xchacha-03 §2.2.1', () => {
    const key = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const nonce = hex('000000090000004a0000000031415927');
    expect(toHex(hchacha20(key, nonce))).toBe(
      '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc',
    );
  });
});

describe('noble ↔ node interop and strictness', () => {
  it.each<[string, TeamCrypto, TeamCrypto]>([
    ['noble→node', nobleCrypto, nodeCrypto],
    ['node→noble', nodeCrypto, nobleCrypto],
  ])('%s: signatures, ECDH, AEAD, HKDF and HMAC agree', (_n, a, b) => {
    const seed = a.randomBytes(32);
    const msg = utf8('inukshuk');
    const sig = a.ed25519.sign(msg, seed);
    expect(b.ed25519.verify(sig, msg, a.ed25519.publicKey(seed))).toBe(true);
    expect(toHex(b.ed25519.publicKey(seed))).toBe(toHex(a.ed25519.publicKey(seed)));
    const x1 = a.randomBytes(32);
    const x2 = b.randomBytes(32);
    expect(toHex(a.x25519.sharedSecret(x1, b.x25519.publicKey(x2)))).toBe(
      toHex(b.x25519.sharedSecret(x2, a.x25519.publicKey(x1))),
    );
    const key = a.randomBytes(32);
    const nonce = a.randomBytes(24);
    const aad = utf8('aad');
    const sealed = a.aead.seal(key, nonce, msg, aad);
    expect(b.aead.open(key, nonce, sealed, aad)).toEqual(msg);
    expect(b.aead.open(key, nonce, sealed, utf8('other'))).toBeUndefined();
    const ikm = a.randomBytes(32);
    expect(toHex(a.hkdfSha256(ikm, msg, aad, 32))).toBe(toHex(b.hkdfSha256(ikm, msg, aad, 32)));
    expect(toHex(a.hmacSha256(key, msg))).toBe(toHex(b.hmacSha256(key, msg)));
  });

  it.each<[string, TeamCrypto]>([
    ['noble', nobleCrypto],
    ['node', nodeCrypto],
  ])('%s rejects a non-canonical S (S + L): one signature, one encoding', (_n, c) => {
    const seed = c.randomBytes(32);
    const msg = utf8('m');
    const sig = c.ed25519.sign(msg, seed);
    // L = 2^252 + 27742317777372353535851937790883648493, little-endian.
    const L = hex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
    const s = sig.subarray(32);
    const sPlusL = new Uint8Array(32);
    let carry = 0;
    for (let i = 0; i < 32; i++) {
      const v = s[i]! + L[i]! + carry;
      sPlusL[i] = v & 0xff;
      carry = v >> 8;
    }
    const malleated = concatBytes(sig.subarray(0, 32), sPlusL);
    let ok: boolean;
    try {
      ok = c.ed25519.verify(malleated, msg, c.ed25519.publicKey(seed));
    } catch {
      ok = false;
    }
    expect(ok).toBe(false);
  });

  it('noble takes randomness only from the injected CSPRNG', () => {
    const calls: number[] = [];
    const c = createNobleCrypto((buf) => {
      calls.push(buf.length);
      buf.fill(7);
    });
    expect(c.randomBytes(24)).toEqual(new Uint8Array(24).fill(7));
    expect(calls).toEqual([24]);
  });
});
