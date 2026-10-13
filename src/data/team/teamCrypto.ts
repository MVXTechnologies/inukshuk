/**
 * The team protocol's crypto on this device (#589, spec §4.3): the audited
 * noble implementation (`@core/team/nobleCrypto`), fed by the platform CSPRNG
 * through `expo-crypto`'s `getRandomValues` (`SecRandomCopyBytes` on iOS,
 * `SecureRandom` on Android). Never `getRandomBytes` (it may fall back to
 * `Math.random` in development) and never a JS polyfill.
 *
 * Loaded lazily and optionally, like `@data/secureStore`: a binary without
 * the native module (an OTA onto a pre-2.5.0 build) gets `null`, and the
 * team extension reports "needs the app update" instead of crashing — or,
 * worse, generating keys from a weak source.
 */
import { createNobleCrypto } from '@core/team/nobleCrypto';
import type { TeamCrypto } from '@core/team/crypto';
import { requireOptionalNativeModule } from 'expo';

type GetRandomValues = (buffer: Uint8Array) => Uint8Array;

let cached: TeamCrypto | null | undefined;

function loadRandom(): GetRandomValues | null {
  try {
    if (requireOptionalNativeModule('ExpoCrypto') === null) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-crypto') as { getRandomValues?: GetRandomValues };
    return typeof mod.getRandomValues === 'function' ? mod.getRandomValues : null;
  } catch {
    return null;
  }
}

/** This device's team crypto, or null when the binary has no CSPRNG module. */
export function teamCrypto(): TeamCrypto | null {
  if (cached !== undefined) return cached;
  const getRandomValues = loadRandom();
  cached =
    getRandomValues === null
      ? null
      : createNobleCrypto((buffer) => {
          // getRandomValues caps one call at 65 536 bytes (Web Crypto rule).
          // Each chunk is a fresh array (never a subarray view the native side might
          // write from offset 0), then copied in.
          for (let off = 0; off < buffer.length; off += 65_536) {
            const chunk = new Uint8Array(Math.min(65_536, buffer.length - off));
            getRandomValues(chunk);
            buffer.set(chunk, off);
          }
          // Fail closed on a broken source: 16+ zero bytes is never random.
          if (buffer.length >= 16 && buffer.every((b) => b === 0)) {
            throw new Error('CSPRNG returned zeros');
          }
        });
  return cached;
}

/** Test-only: forget the loaded module. */
export function resetTeamCryptoForTests(): void {
  cached = undefined;
}
