import { downsample, sparklinePoints } from './sparkline';

describe('downsample', () => {
  it('keeps a short series as is', () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('keeps the first and last value and caps the length', () => {
    const series = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsample(series, 50);
    expect(out).toHaveLength(50);
    expect(out[0]).toBe(0);
    expect(out[49]).toBe(999);
  });

  it('refuses a cap below two by returning the series', () => {
    expect(downsample([5, 6, 7], 1)).toEqual([5, 6, 7]);
  });
});

describe('sparklinePoints', () => {
  it('maps min to the bottom and max to the top', () => {
    expect(sparklinePoints([414, 682], 100, 20)).toBe('0,20 100,0');
  });

  it('draws a flat series through the middle', () => {
    expect(sparklinePoints([500, 500, 500], 10, 20)).toBe('0,10 5,10 10,10');
  });

  it('draws nothing for fewer than two finite values', () => {
    expect(sparklinePoints([], 10, 10)).toBe('');
    expect(sparklinePoints([3], 10, 10)).toBe('');
    expect(sparklinePoints([NaN, 3], 10, 10)).toBe('');
  });

  it('skips non-finite altitudes', () => {
    expect(sparklinePoints([100, NaN, 200], 10, 10)).toBe('0,10 10,0');
  });

  it('caps the number of vertices', () => {
    const series = Array.from({ length: 5000 }, (_, i) => Math.sin(i / 50));
    expect(sparklinePoints(series, 300, 40, 120).split(' ')).toHaveLength(120);
  });
});
