import { HOLD_SCALE_MAX, holdScale } from './holdScale';

describe('holdScale (the SOS button swells while held)', () => {
  it('is 1× at rest, the maximum at a complete hold, half-way at mid-hold', () => {
    expect(holdScale(0)).toBe(1);
    expect(holdScale(1)).toBeCloseTo(HOLD_SCALE_MAX, 12);
    expect(holdScale(0.5)).toBeCloseTo(1 + (HOLD_SCALE_MAX - 1) / 2, 12);
    expect(HOLD_SCALE_MAX).toBe(1.35);
  });

  it('eases: slow to start and to finish, never shrinking, never past the maximum', () => {
    let prev = holdScale(0);
    for (let i = 1; i <= 100; i++) {
      const s = holdScale(i / 100);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeLessThanOrEqual(HOLD_SCALE_MAX + 1e-12);
      prev = s;
    }
    // The first and last tenth move less than the middle tenth.
    const step = (a: number, b: number) => holdScale(b) - holdScale(a);
    expect(step(0, 0.1)).toBeLessThan(step(0.45, 0.55));
    expect(step(0.9, 1)).toBeLessThan(step(0.45, 0.55));
  });

  it('a cancelled hold (progress back to 0, or a spring overshooting below it) is 1×', () => {
    expect(holdScale(-0.2)).toBe(1);
    expect(holdScale(1.3)).toBeCloseTo(HOLD_SCALE_MAX, 12);
    expect(holdScale(Number.NaN)).toBe(1);
  });
});
