/**
 * TEST-ONLY property-testing helpers. `fast-check` is not in the dependency
 * tree, so this is the minimal seeded equivalent: a deterministic PRNG and
 * generators, run N times per property. A failure prints its seed and case
 * index, so it replays exactly.
 */

/** Mulberry32: tiny, fast, good enough for test-case generation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export const int = (rnd: Rng, lo: number, hi: number): number =>
  lo + Math.floor(rnd() * (hi - lo + 1));

export function pick<T>(rnd: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)]!;
}

export function shuffle<T>(xs: readonly T[], rnd: Rng): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Run `property` on `runs` generated cases; rethrows with the seed/case for replay. */
export function forAll<T>(
  seed: number,
  runs: number,
  generate: (rnd: Rng) => T,
  property: (value: T) => void,
): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    const value = generate(rnd);
    try {
      property(value);
    } catch (e) {
      throw new Error(`property failed (seed ${seed}, case ${i}): ${(e as Error).message}`);
    }
  }
}
