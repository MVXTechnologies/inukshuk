import { fromHex, toHex, utf8 } from '../bytes';
import { hchacha20, nodeCrypto as c } from './nodeCrypto';

const hex = (h: string) => fromHex(h.replace(/\s+/g, ''))!;

/** The test double must match the standards the noble implementation is held to. */
describe('nodeCrypto test double — RFC vectors', () => {
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

  it('HChaCha20, draft-irtf-cfrg-xchacha-03 §2.2.1', () => {
    const key = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const nonce = hex('000000090000004a0000000031415927');
    expect(toHex(hchacha20(key, nonce))).toBe(
      '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc',
    );
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

  it('SHA-256 and HMAC', () => {
    expect(toHex(c.sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(c.hmacSha256(utf8('k'), utf8('m'))).toHaveLength(32);
    expect(c.randomBytes(7)).toHaveLength(7);
  });
});
