import { scrubRatio } from './scrub';

describe('scrubRatio', () => {
  it('maps a finger inside the plot to its fraction of the length', () => {
    expect(scrubRatio(0, 0, 200)).toBe(0);
    expect(scrubRatio(50, 0, 200)).toBe(0.25);
    expect(scrubRatio(200, 0, 200)).toBe(1);
  });

  it('measures from the plot start (a left gutter is not part of the axis)', () => {
    expect(scrubRatio(38, 38, 100)).toBe(0);
    expect(scrubRatio(88, 38, 100)).toBe(0.5);
  });

  it('pins a finger dragged past either end instead of extrapolating', () => {
    expect(scrubRatio(-40, 0, 200)).toBe(0);
    expect(scrubRatio(10, 38, 100)).toBe(0);
    expect(scrubRatio(900, 0, 200)).toBe(1);
  });

  it('has no answer before the plot is laid out or for a non-finite touch', () => {
    expect(scrubRatio(10, 0, 0)).toBeNull();
    expect(scrubRatio(10, 0, -5)).toBeNull();
    expect(scrubRatio(Number.NaN, 0, 200)).toBeNull();
    expect(scrubRatio(10, Number.POSITIVE_INFINITY, 200)).toBeNull();
    expect(scrubRatio(10, 0, Number.NaN)).toBeNull();
  });
});
