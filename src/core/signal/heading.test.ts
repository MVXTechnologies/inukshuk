import { normalizeDeg, signedDeltaDeg, unwrapDeg } from './heading';

describe('normalizeDeg', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(370)).toBe(10);
    expect(normalizeDeg(-10)).toBe(350);
    expect(normalizeDeg(-370)).toBe(350);
  });
});

describe('signedDeltaDeg', () => {
  it('returns the shortest signed arc', () => {
    expect(signedDeltaDeg(10, 30)).toBeCloseTo(20, 10);
    expect(signedDeltaDeg(30, 10)).toBeCloseTo(-20, 10);
    expect(signedDeltaDeg(90, 90)).toBe(0);
  });

  it('crosses the 0/360 boundary the short way', () => {
    expect(signedDeltaDeg(350, 10)).toBeCloseTo(20, 10);
    expect(signedDeltaDeg(10, 350)).toBeCloseTo(-20, 10);
    expect(signedDeltaDeg(359.5, 0.5)).toBeCloseTo(1, 10);
    expect(signedDeltaDeg(0.5, 359.5)).toBeCloseTo(-1, 10);
  });

  it('returns +180 for antipodal headings (both directions)', () => {
    expect(signedDeltaDeg(0, 180)).toBe(180);
    expect(signedDeltaDeg(180, 0)).toBe(180);
    expect(signedDeltaDeg(90, 270)).toBe(180);
  });

  it('accepts unnormalized inputs', () => {
    expect(signedDeltaDeg(-10, 370)).toBeCloseTo(20, 10);
    expect(signedDeltaDeg(720, 361)).toBeCloseTo(1, 10);
  });
});

describe('unwrapDeg', () => {
  it('continues past 360 instead of jumping back to 0', () => {
    expect(unwrapDeg(350, 10)).toBeCloseTo(370, 10);
    expect(unwrapDeg(370, 30)).toBeCloseTo(390, 10);
  });

  it('continues below 0 instead of jumping to 350', () => {
    expect(unwrapDeg(10, 350)).toBeCloseTo(-10, 10);
    expect(unwrapDeg(-10, 330)).toBeCloseTo(-30, 10);
  });

  it('is a no-op when the heading equals the previous angle mod 360', () => {
    expect(unwrapDeg(725, 5)).toBeCloseTo(725, 10);
    expect(unwrapDeg(-355, 5)).toBeCloseTo(-355, 10);
  });

  it('a long random walk never jumps more than 180 between steps', () => {
    let continuous = 0;
    let heading = 0;
    for (let i = 0; i < 500; i++) {
      heading = normalizeDeg(heading + Math.sin(i * 0.7) * 170);
      const next = unwrapDeg(continuous, heading);
      expect(Math.abs(next - continuous)).toBeLessThanOrEqual(180);
      expect(normalizeDeg(next)).toBeCloseTo(heading, 8);
      continuous = next;
    }
  });
});
