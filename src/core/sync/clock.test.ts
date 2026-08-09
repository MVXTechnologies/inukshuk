import { clampStamp, MAX_FUTURE_SKEW_MS, nextStamp } from './clock';

describe('nextStamp', () => {
  it('uses the wall clock when it is ahead of the last stamp', () => {
    expect(nextStamp(1_000, 500)).toBe(1_000);
  });

  it('bumps just past the last stamp when the clock lags (backwards step)', () => {
    expect(nextStamp(500, 1_000)).toBe(1_001);
  });

  it('advances even when the clock is frozen at the last stamp', () => {
    expect(nextStamp(1_000, 1_000)).toBe(1_001);
  });

  it('defaults lastStamp to 0 (fresh item)', () => {
    expect(nextStamp(1_234)).toBe(1_234);
  });

  it('two successive edits in the same millisecond still order', () => {
    const first = nextStamp(1_000, 0);
    const second = nextStamp(1_000, first);
    expect(second).toBeGreaterThan(first);
  });

  it.each([NaN, Infinity, -Infinity, -5, 0])(
    'degrades junk wall clock %p to lastStamp + 1',
    (now) => {
      expect(nextStamp(now, 42)).toBe(43);
    },
  );

  it('yields 0 only when both inputs are junk', () => {
    expect(nextStamp(NaN, NaN)).toBe(0);
    expect(nextStamp(-1)).toBe(0);
  });
});

describe('clampStamp', () => {
  const now = 1_700_000_000_000;

  it('passes plausible stamps through untouched', () => {
    expect(clampStamp(now - 5_000, now)).toBe(now - 5_000);
    expect(clampStamp(now, now)).toBe(now);
  });

  it('tolerates moderate future skew inside the window', () => {
    const twoMinutesAhead = now + 2 * 60_000;
    expect(clampStamp(twoMinutesAhead, now)).toBe(twoMinutesAhead);
  });

  it('clamps stamps beyond the future-skew ceiling', () => {
    const yearAhead = now + 365 * 24 * 3_600_000;
    expect(clampStamp(yearAhead, now)).toBe(now + MAX_FUTURE_SKEW_MS);
  });

  it('honours a custom tolerance', () => {
    expect(clampStamp(now + 10_000, now, 1_000)).toBe(now + 1_000);
  });

  it.each([NaN, Infinity, -Infinity, -1, 0])('collapses junk stamp %p to 0', (stamp) => {
    expect(clampStamp(stamp, now)).toBe(0);
  });

  it('stays total when now itself is junk', () => {
    expect(clampStamp(5_000, NaN, 1_000)).toBe(1_000);
  });
});
