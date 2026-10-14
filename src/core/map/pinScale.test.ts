import {
  DEFAULT_PIN_SCALE,
  PIN_SCALES,
  isPinScale,
  normalizePinScale,
  pinScaleFactor,
  pinScaleLabel,
} from './pinScale';

describe('pin size setting (#686)', () => {
  it('offers 75, 100, 125 and 150 %, 100 by default', () => {
    expect(PIN_SCALES).toEqual([75, 100, 125, 150]);
    expect(DEFAULT_PIN_SCALE).toBe(100);
  });

  it('keeps every step', () => {
    for (const s of PIN_SCALES) {
      expect(isPinScale(s)).toBe(true);
      expect(normalizePinScale(s)).toBe(s);
    }
  });

  it.each([undefined, null, 0, -100, 110, 1.25, '125', NaN, Infinity, {}, [125], true])(
    'normalises junk (%p) to 100 %%',
    (junk) => {
      expect(isPinScale(junk)).toBe(false);
      expect(normalizePinScale(junk)).toBe(100);
      expect(pinScaleFactor(junk)).toBe(1);
    },
  );

  it('turns a step into its multiplier and its label', () => {
    expect(PIN_SCALES.map(pinScaleFactor)).toEqual([0.75, 1, 1.25, 1.5]);
    expect(pinScaleLabel(125)).toBe('125 %');
  });
});
