import { factText, FUN_FACT_MAX_CHARS, FUN_FACTS, nextFactIndex } from './funFacts';

describe('fun facts', () => {
  it('has the owner’s two plus six more, in EN and FR', () => {
    expect(FUN_FACTS).toHaveLength(8);
    expect(FUN_FACTS[0]?.en).toContain('Donationausaurus');
    expect(FUN_FACTS[1]?.en).toBe(
      'If every user donated a coffee, the app would be paid for the whole year — today!',
    );
  });

  it.each(FUN_FACTS.map((f, i) => [i, f] as const))(
    '#%p fits the bubble in both languages',
    (_i, f) => {
      expect(f.en.length).toBeLessThanOrEqual(FUN_FACT_MAX_CHARS);
      expect(f.fr.length).toBeLessThanOrEqual(FUN_FACT_MAX_CHARS);
      expect(f.en.trim()).not.toBe('');
      expect(f.fr.trim()).not.toBe('');
      // No money amounts in the playful copy (owner rule: no public amounts).
      expect(`${f.en} ${f.fr}`).not.toMatch(/\$|€|\d/);
    },
  );

  it('picks in the reader’s language', () => {
    expect(factText(0, 'fr-CA')).toBe(FUN_FACTS[0]?.fr);
    expect(factText(0, 'en-US')).toBe(FUN_FACTS[0]?.en);
    expect(factText(0, null)).toBe(FUN_FACTS[0]?.en);
    expect(factText(99, 'en')).toBe(FUN_FACTS[0]?.en);
  });
});

describe('nextFactIndex', () => {
  it('never repeats the fact just shown', () => {
    for (let last = 0; last < FUN_FACTS.length; last++) {
      for (const r of [0, 0.2, 0.5, 0.8, 0.9999]) {
        const next = nextFactIndex(last, () => r);
        expect(next).not.toBe(last);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(FUN_FACTS.length);
      }
    }
  });

  it('reaches every other fact', () => {
    const seen = new Set<number>();
    for (let k = 0; k < FUN_FACTS.length - 1; k++) {
      seen.add(nextFactIndex(0, () => k / (FUN_FACTS.length - 1)));
    }
    expect(seen.size).toBe(FUN_FACTS.length - 1);
    expect(seen.has(0)).toBe(false);
  });

  it('starts anywhere when nothing was shown yet (or the last index is junk)', () => {
    expect(nextFactIndex(null, () => 0)).toBe(0);
    expect(nextFactIndex(null, () => 0.9999)).toBe(FUN_FACTS.length - 1);
    expect(nextFactIndex(42, () => 0)).toBe(0);
  });
});
