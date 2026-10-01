import { estimateDurationS, formatEstimate, paceProfileFor } from './timeEstimate';

describe('estimateDurationS (Naismith)', () => {
  it('hiking: 4.5 km/h plus 10 min per 100 m of climb', () => {
    // 9 km flat = 2 h; 600 m up = 60 min.
    expect(estimateDurationS(9000, 0, 'hike')).toBe(2 * 3600);
    expect(estimateDurationS(9000, 600, 'hike')).toBe(3 * 3600);
  });

  it('no, unknown or navigation category estimates as a hike', () => {
    const hike = estimateDurationS(6900, 610, 'hike');
    expect(estimateDurationS(6900, 610)).toBe(hike);
    expect(estimateDurationS(6900, 610, null)).toBe(hike);
    expect(estimateDurationS(6900, 610, 'navigation')).toBe(hike);
    expect(estimateDurationS(6900, 610, 'custom-id')).toBe(hike);
  });

  it('faster activities take less time over the same route', () => {
    const hike = estimateDurationS(10_000, 300, 'hike');
    expect(estimateDurationS(10_000, 300, 'run')).toBeLessThan(hike);
    expect(estimateDurationS(10_000, 300, 'bike')).toBeLessThan(
      estimateDurationS(10_000, 300, 'run'),
    );
    expect(estimateDurationS(10_000, 300, 'snowshoe')).toBeGreaterThan(hike);
  });

  it('junk inputs read as zero', () => {
    expect(estimateDurationS(Number.NaN, -5)).toBe(0);
    expect(estimateDurationS(-100, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('paceProfileFor returns the hiking profile by default', () => {
    expect(paceProfileFor(undefined)).toEqual({ flatKmh: 4.5, climbMinPer100m: 10 });
    expect(paceProfileFor('bike').flatKmh).toBe(16);
  });
});

describe('formatEstimate', () => {
  it('minutes under an hour', () => {
    expect(formatEstimate(45 * 60)).toBe('45 min');
    expect(formatEstimate(20)).toBe('1 min');
    expect(formatEstimate(0)).toBe('0 min');
  });

  it('"2 h 40" past an hour, rounded to five minutes', () => {
    expect(formatEstimate(2 * 3600 + 38 * 60)).toBe('2 h 40');
    expect(formatEstimate(2 * 3600 + 5 * 60)).toBe('2 h 05');
    expect(formatEstimate(3 * 3600 + 60)).toBe('3 h');
  });

  it('junk is zero', () => {
    expect(formatEstimate(Number.NaN)).toBe('0 min');
  });
});
