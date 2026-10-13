import {
  ALTITUDE_MIN_SCALE,
  ALTITUDE_SEPARATOR,
  altitudeFits,
  chipAltitudeText,
  chipChromeDp,
  estimateChipTextDp,
} from './coordinatesChip';

describe('chipAltitudeText', () => {
  it('marks DEM ground elevation as approximate, GPS altitude as read', () => {
    expect(chipAltitudeText(412.4, 'metric', 'dem')).toBe('≈412 m');
    expect(chipAltitudeText(412.6, 'metric', 'gps')).toBe('413 m');
  });

  it('follows the unit setting, rounded to the foot', () => {
    expect(chipAltitudeText(412, 'imperial', 'dem')).toBe('≈1352 ft');
    expect(chipAltitudeText(-3.2, 'metric', 'gps')).toBe('-3 m');
  });
});

describe('estimateChipTextDp', () => {
  it('weighs digits wide and punctuation narrow', () => {
    expect(estimateChipTextDp('0000')).toBeCloseTo(4 * 7.4, 6);
    expect(estimateChipTextDp('., ')).toBeCloseTo(3 * 3.8, 6);
    expect(estimateChipTextDp('m')).toBeGreaterThan(estimateChipTextDp('0'));
    expect(estimateChipTextDp('ft')).toBeLessThan(estimateChipTextDp('00'));
  });

  it('the following mark costs its icon and gap', () => {
    expect(chipChromeDp(true) - chipChromeDp(false)).toBe(20);
  });
});

describe('altitudeFits', () => {
  const dd = '46.81394, -71.20761';
  const compact = '46.8139, -71.2076';
  const alt = '≈412 m';
  const need = (c: string, following = false) =>
    estimateChipTextDp(`${c}${ALTITUDE_SEPARATOR}${alt}`) * ALTITUDE_MIN_SCALE +
    chipChromeDp(following);

  it('allows the text a slight shrink, inside the Text’s own 0.85 floor', () => {
    expect(ALTITUDE_MIN_SCALE).toBeGreaterThan(0.85);
    expect(ALTITUDE_MIN_SCALE).toBeLessThan(1);
  });

  it('fits exactly at its estimate, not one dp less', () => {
    expect(altitudeFits(need(dd), dd, alt, false)).toBe(true);
    expect(altitudeFits(need(dd) - 1, dd, alt, false)).toBe(false);
  });

  it('needs more room while following (the "you" mark)', () => {
    expect(altitudeFits(need(dd), dd, alt, true)).toBe(false);
    expect(altitudeFits(need(dd, true), dd, alt, true)).toBe(true);
  });

  it('390 dp without a tip button: DD and its altitude fit beside a typical scale bar', () => {
    // 390 − 32 gutters − (24 ⓘ + 6 + 94 scale) − 6 gap = 228 dp of row.
    expect(altitudeFits(228, dd, alt, false)).toBe(true);
  });

  it('360 dp with the tip button up: the altitude drops, the coordinates stay', () => {
    // 360 − 32 − (24 + 6 + 94) − 6 − (36 tip + 6) = 156 dp of row.
    expect(altitudeFits(156, compact, alt, false)).toBe(false);
  });

  it('360 dp without the tip button: the compact coordinates keep their altitude', () => {
    // 360 − 32 − (24 + 6 + 94) − 6 = 198 dp of row.
    expect(altitudeFits(198, compact, alt, false)).toBe(true);
  });
});
