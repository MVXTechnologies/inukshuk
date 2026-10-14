import { ORPHAN_CHECKS, orphanCheck } from './orphan';

describe('orphanCheck (QA 2.6.1: the keyboard left behind for a hidden WebView)', () => {
  it('a focused field keeps the keyboard, and resets the count', () => {
    expect(orphanCheck(0, true)).toEqual({ misses: 0, dismiss: false });
    expect(orphanCheck(1, true)).toEqual({ misses: 0, dismiss: false });
  });

  it('dismisses only after consecutive misses (never mid field-to-field hop)', () => {
    expect(ORPHAN_CHECKS).toBe(2);
    const first = orphanCheck(0, false);
    expect(first).toEqual({ misses: 1, dismiss: false });
    expect(orphanCheck(first.misses, false)).toEqual({ misses: 0, dismiss: true });
    // A miss then a focused field: no dismiss, back to zero.
    expect(orphanCheck(orphanCheck(0, false).misses, true)).toEqual({ misses: 0, dismiss: false });
  });
});
