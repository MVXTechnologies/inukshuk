import { addPublished, decimalsOf, displayNumber } from './published';

describe('addPublished', () => {
  it('is exact (no binary-fraction noise)', () => {
    expect(addPublished('1.541', '-0.846')).toBe('0.695'); // MHHW at The Battery in NAVD88
    expect(addPublished('0.1', '0.2')).toBe('0.3');
    expect(addPublished('9.541', '-3.635')).toBe('5.906'); // NO-47 at Brest: IGN69 levelling
  });

  it('keeps the fewer decimals of its inputs, rounding half away from zero', () => {
    expect(addPublished('7.93', '-3.635')).toBe('4.30'); // 4.295 → 4.30
    expect(addPublished('1.541', '-32.77')).toBe('-31.23'); // -31.229
    expect(addPublished('-0.465', '-32.77')).toBe('-33.24'); // -33.235 → -33.24
    expect(addPublished('0.000', '-0.846')).toBe('-0.846');
    expect(addPublished('173.5', '0.12')).toBe('173.6');
  });

  it('never returns "-0"', () => {
    expect(addPublished('0.846', '-0.846')).toBe('0.000');
    expect(addPublished('-0.004', '0.00')).toBe('0.00'); // -0.004 rounds to zero, unsigned
    expect(addPublished('0.004', '-0.01')).toBe('-0.01'); // -0.006 rounds away from zero
  });

  it('refuses anything that is not a plain number', () => {
    expect(addPublished('1.2e3', '1')).toBeNull();
    expect(addPublished('', '1')).toBeNull();
    expect(addPublished('abc', '1')).toBeNull();
  });

  it('reads a typographic minus and counts decimals', () => {
    expect(addPublished('−1.00', '0.50')).toBe('-0.50');
    expect(decimalsOf('-3.635')).toBe(3);
    expect(decimalsOf('12')).toBe(0);
  });

  it('displays a typographic minus', () => {
    expect(displayNumber('-0.846')).toBe('−0.846');
    expect(displayNumber('0.846')).toBe('0.846');
  });
});
