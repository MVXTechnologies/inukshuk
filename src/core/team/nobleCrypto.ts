import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import type { TeamCrypto } from './crypto';

/**
 * The device {@link TeamCrypto}: `@noble/curves` (Ed25519, X25519),
 * `@noble/hashes` (SHA-256, HMAC, HKDF) and `@noble/ciphers`
 * (XChaCha20-Poly1305). They are pure JS, audited and run on Hermes. Versions
 * are pinned exactly in package.json.
 *
 * **Randomness is injected, never global.** Hermes has no
 * `crypto.getRandomValues`, and Expo SDK 56's runtime does not install one.
 * noble's own `randomBytes` would throw there (fail closed), and a JS
 * polyfill (e.g. `Math.random`) would be catastrophic. So the caller passes
 * the platform CSPRNG, and every place the protocol needs randomness (keys,
 * nonces, invite seeds, ephemeral keys) goes through it. On device, that is
 * `expo-crypto`'s `getRandomValues` (native `SecRandomCopyBytes` /
 * `SecureRandom`). That binding lives outside `src/core` and is added together
 * with the mesh module's store release. See docs/design/team-protocol.md
 * §4.3. Tests pass Node's `crypto.randomFillSync`.
 *
 * Signatures are verified strictly (RFC 8032, `zip215: false`), so a signature
 * has one valid encoding. The protocol's content-addressing relies on that.
 */
export function createNobleCrypto(fillRandom: (buffer: Uint8Array) => void): TeamCrypto {
  return {
    randomBytes(length) {
      const out = new Uint8Array(length);
      fillRandom(out);
      return out;
    },
    sha256: (data) => sha256(data),
    hmacSha256: (key, data) => hmac(sha256, key, data),
    hkdfSha256: (ikm, salt, info, length) => hkdf(sha256, ikm, salt, info, length),
    ed25519: {
      publicKey: (seed) => ed25519.getPublicKey(seed),
      sign: (message, seed) => ed25519.sign(message, seed),
      verify: (signature, message, publicKey) =>
        ed25519.verify(signature, message, publicKey, { zip215: false }),
    },
    x25519: {
      publicKey: (secret) => x25519.getPublicKey(secret),
      sharedSecret: (secret, publicKey) => x25519.getSharedSecret(secret, publicKey),
    },
    aead: {
      seal: (key, nonce, plaintext, aad) => xchacha20poly1305(key, nonce, aad).encrypt(plaintext),
      open(key, nonce, ciphertext, aad) {
        try {
          return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
        } catch {
          return undefined; // authentication failure
        }
      },
    },
  };
}
