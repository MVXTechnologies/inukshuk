import type { TeamCrypto } from '../../team/crypto';

/**
 * Seeded randomness for the deterministic simulator (design §8.1). Every
 * random choice — workload, network adversity, and the crypto's own random
 * bytes — comes from one seed, so a failing seed replays byte for byte.
 */
export type Rng = () => number;

/** Mulberry32: tiny, fast, good enough for simulation. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (rnd: Rng, lo: number, hi: number): number =>
  lo + Math.floor(rnd() * (hi - lo + 1));

export function choose<T>(rnd: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)]!;
}

export const chance = (rnd: Rng, p: number): boolean => rnd() < p;

/**
 * `base` with its random bytes drawn from `rnd`: keys, nonces and ids become
 * a function of the seed. Simulation only — never a real phone's CSPRNG.
 */
export function seededCrypto(base: TeamCrypto, rnd: Rng): TeamCrypto {
  return {
    ...base,
    randomBytes(length: number): Uint8Array {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = Math.floor(rnd() * 256);
      return out;
    },
  };
}
