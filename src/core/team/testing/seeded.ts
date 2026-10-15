/**
 * TEST-ONLY: a {@link TeamCrypto} whose randomness (device keys, team nonces,
 * epoch keys, wraps, AEAD nonces) comes from a seeded PRNG, so a whole team
 * history (op ids, member ids, fold order) replays bit for bit per seed.
 */
import type { TeamCrypto } from '../crypto';
import { nodeCrypto } from './nodeCrypto';
import { mulberry32 } from './prop';

export function seededCrypto(seed: number): TeamCrypto {
  const rnd = mulberry32(seed);
  return {
    ...nodeCrypto,
    randomBytes: (n) => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256)),
  };
}
