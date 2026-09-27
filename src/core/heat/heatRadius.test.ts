import { HEAT_RADIUS_STOPS, heatRadiusExpression, heatRadiusPx } from './heatRadius';

describe('heatRadiusPx', () => {
  it('hits every stop exactly', () => {
    for (const [z, px] of HEAT_RADIUS_STOPS) expect(heatRadiusPx(z)).toBeCloseTo(px, 10);
  });

  it('clamps outside the stops', () => {
    expect(heatRadiusPx(2)).toBe(3);
    expect(heatRadiusPx(20)).toBe(28);
  });

  it('grows monotonically between stops', () => {
    let prev = 0;
    for (let z = 6; z <= 16; z += 0.25) {
      const r = heatRadiusPx(z);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('builds the same curve as a style expression', () => {
    expect(heatRadiusExpression()).toEqual([
      'interpolate',
      ['exponential', 1.6],
      ['zoom'],
      6,
      3,
      10,
      8,
      13,
      16,
      16,
      28,
    ]);
  });
});
