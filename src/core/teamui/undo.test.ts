import {
  countdown,
  countdownDone,
  countdownFraction,
  countdownLeft,
  countdownSeconds,
  holdProgress,
  holdTicks,
  SOS_HOLD_MS,
  UNDO_MS,
} from './undo';

const T = 1_000_000;

describe('hold to send', () => {
  it('fills over 2 s, clamped, with a tick per whole second', () => {
    expect(SOS_HOLD_MS).toBe(2000);
    expect(holdProgress(T, T - 50)).toBe(0);
    expect(holdProgress(T, T)).toBe(0);
    expect(holdProgress(T, T + 500)).toBe(0.25);
    expect(holdProgress(T, T + 2000)).toBe(1);
    expect(holdProgress(T, T + 9000)).toBe(1);
    expect(holdProgress(T, T, 0)).toBe(1);
    expect([0, 999, 1000, 1999, 2000].map((d) => holdTicks(T, T + d))).toEqual([0, 0, 1, 1, 2]);
  });
});

describe('undo countdown', () => {
  it('counts 5 → 1, then done; the ring empties', () => {
    const c = countdown(T);
    expect(c.durationMs).toBe(UNDO_MS);
    expect([0, 1, 1000, 4001, 4999].map((d) => countdownSeconds(c, T + d))).toEqual([
      5, 5, 4, 1, 1,
    ]);
    expect(countdownDone(c, T + 4999)).toBe(false);
    expect(countdownDone(c, T + 5000)).toBe(true);
    expect(countdownSeconds(c, T + 7000)).toBe(0);
    expect(countdownLeft(c, T + 7000)).toBe(0);
    expect(countdownFraction(c, T + 2500)).toBe(0.5);
    expect(countdownFraction(countdown(T, 0), T)).toBe(0);
  });
});
