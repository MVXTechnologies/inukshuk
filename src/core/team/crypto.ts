import { concatBytes, isAllZero, utf8 } from './bytes';

/**
 * Crypto boundary of the team protocol (#589).
 *
 * `src/core` never ships an implementation: the platform layer provides one
 * (recommended: `@noble/curves` ed25519/x25519 + `@noble/hashes` sha256/hmac/
 * hkdf + `@noble/ciphers` xchacha20poly1305 — pure JS, audited, Hermes-safe).
 * Tests use `testing/nodeCrypto.ts` (Node's OpenSSL + a pure-JS HChaCha20),
 * checked against the RFC test vectors.
 *
 * The interface is synchronous on purpose: the sync state machine verifies a
 * batch of ops inline, and the noble libraries are synchronous.
 *
 * Implementations MAY throw on malformed keys (noble does); the core never
 * calls them directly from hostile paths, only through the `safe*` wrappers
 * below, which turn every failure into `undefined`/`false`.
 */
export interface TeamCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  /** RFC 5869 HKDF-SHA256. */
  hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  ed25519: {
    /** 32-byte seed → 32-byte public key. */
    publicKey(seed: Uint8Array): Uint8Array;
    sign(message: Uint8Array, seed: Uint8Array): Uint8Array;
    /**
     * RFC 8032 verification. Implementations must reject non-canonical `S`
     * (noble: `zip215: false`) so a signature has one valid encoding.
     */
    verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
  };
  x25519: {
    publicKey(secret: Uint8Array): Uint8Array;
    sharedSecret(secret: Uint8Array, publicKey: Uint8Array): Uint8Array;
  };
  /** XChaCha20-Poly1305: 32-byte key, 24-byte nonce, 16-byte tag appended. */
  aead: {
    seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
    /** `undefined` when authentication fails. */
    open(
      key: Uint8Array,
      nonce: Uint8Array,
      ciphertext: Uint8Array,
      aad: Uint8Array,
    ): Uint8Array | undefined;
  };
}

export const KEY_BYTES = 32;
export const SIG_BYTES = 64;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;

/** Domain-separation prefix for every signature, hash and KDF label. */
export const DOMAIN = 'inukshuk/team/v1/';

export function label(name: string): Uint8Array {
  return utf8(DOMAIN + name);
}

export function safeVerify(
  c: TeamCrypto,
  signature: Uint8Array | undefined,
  message: Uint8Array,
  publicKey: Uint8Array | undefined,
): boolean {
  if (signature?.length !== SIG_BYTES || publicKey?.length !== KEY_BYTES) return false;
  try {
    return c.ed25519.verify(signature, message, publicKey) === true;
  } catch {
    return false;
  }
}

/** X25519 that refuses low-order points (an all-zero shared secret). */
export function safeShared(
  c: TeamCrypto,
  secret: Uint8Array,
  publicKey: Uint8Array | undefined,
): Uint8Array | undefined {
  if (publicKey?.length !== KEY_BYTES) return undefined;
  try {
    const shared = c.x25519.sharedSecret(secret, publicKey);
    return shared.length === KEY_BYTES && !isAllZero(shared) ? shared : undefined;
  } catch {
    return undefined;
  }
}

export function safeOpen(
  c: TeamCrypto,
  key: Uint8Array,
  nonce: Uint8Array | undefined,
  ciphertext: Uint8Array | undefined,
  aad: Uint8Array,
): Uint8Array | undefined {
  if (nonce?.length !== NONCE_BYTES || ciphertext === undefined) return undefined;
  if (ciphertext.length < TAG_BYTES) return undefined;
  try {
    return c.aead.open(key, nonce, ciphertext, aad);
  } catch {
    return undefined;
  }
}

/** HKDF with a labelled `info`; `salt` binds the derivation to a team/session. */
export function derive(
  c: TeamCrypto,
  ikm: Uint8Array,
  salt: Uint8Array,
  name: string,
  context: Uint8Array = new Uint8Array(0),
  length = KEY_BYTES,
): Uint8Array {
  return c.hkdfSha256(ikm, salt, concatBytes(label(name), context), length);
}

/** A device's long-term keys. Secrets never leave the device (secure store). */
export interface DeviceKeys {
  /** Ed25519 seed. */
  signSecret: Uint8Array;
  signPublic: Uint8Array;
  /** X25519 secret. */
  boxSecret: Uint8Array;
  boxPublic: Uint8Array;
}

export function generateDeviceKeys(c: TeamCrypto): DeviceKeys {
  const signSecret = c.randomBytes(KEY_BYTES);
  const boxSecret = c.randomBytes(KEY_BYTES);
  return {
    signSecret,
    signPublic: c.ed25519.publicKey(signSecret),
    boxSecret,
    boxPublic: c.x25519.publicKey(boxSecret),
  };
}
