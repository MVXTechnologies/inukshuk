import {
  DEFAULT_DISPLAY_SCALE,
  DISPLAY_SCALES,
  MIN_TEXT_SP,
  MIN_TOUCH,
  displayScaleFactor,
  displayScaleLabel,
  displayScalePercent,
  effectiveScreenDp,
  hitSlopFor,
  isDisplayScale,
  normalizeDisplayScale,
  scaleFont,
  scaleFontSize,
  scaleSheet,
  scaleSize,
  scaleStyle,
  touchSize,
} from './displayScale';

describe('sizes', () => {
  it('is Small 85 %, Default 100 %, Large 115 %', () => {
    expect(DISPLAY_SCALES).toEqual([0.85, 1, 1.15]);
    expect(DEFAULT_DISPLAY_SCALE).toBe(1);
    expect(DISPLAY_SCALES.map(displayScaleLabel)).toEqual(['Small', 'Default', 'Large']);
    expect(DISPLAY_SCALES.map(displayScalePercent)).toEqual(['85 %', '100 %', '115 %']);
  });

  it.each([
    [100], // an older build's percentage
    [85],
    [0.9],
    [1.1],
    [0.8],
    [1.2],
    [0],
    [-1],
    ['0.85'],
    [null],
    [undefined],
    [{}],
    [NaN],
  ])('reads junk or an older value (%p) as 1', (junk) => {
    expect(isDisplayScale(junk)).toBe(false);
    expect(normalizeDisplayScale(junk)).toBe(1);
    expect(displayScaleFactor(junk)).toBe(1);
    expect(displayScaleLabel(junk)).toBe('Default');
  });

  it('keeps a real size, which is its own factor', () => {
    for (const v of DISPLAY_SCALES) {
      expect(normalizeDisplayScale(v)).toBe(v);
      expect(displayScaleFactor(v)).toBe(v);
    }
  });
});

describe('scaleSize', () => {
  it('is the identity at 100 %', () => {
    for (const n of [0, 0.5, 12.5, 13, 48, -6, 1000]) expect(scaleSize(n, 1)).toBe(n);
  });

  it('scales and rounds to the half dp', () => {
    expect(scaleSize(40, 0.85)).toBe(34);
    expect(scaleSize(16, 0.85)).toBe(13.5);
    expect(scaleSize(13, 0.85)).toBe(11);
    expect(scaleSize(-6, 0.85)).toBe(-5);
    expect(scaleSize(22, 1.15)).toBe(25.5);
  });
});

describe('touch targets never shrink below 48 dp', () => {
  it.each(DISPLAY_SCALES.map((v) => [v]))('at %p', (k) => {
    for (const n of [24, 36, 40, 44, 48, 52, 56]) {
      expect(touchSize(n, k)).toBeGreaterThanOrEqual(MIN_TOUCH);
      const visual = scaleSize(n, k);
      expect(visual + 2 * hitSlopFor(visual)).toBeGreaterThanOrEqual(MIN_TOUCH);
    }
  });

  it('touchSize grows with the scale above 48', () => {
    expect(touchSize(48, 1.15)).toBe(55);
    expect(touchSize(48, 0.85)).toBe(48);
    expect(touchSize(30, 1, 44)).toBe(44);
  });

  it('hitSlopFor tops a visual up to 48, and is 0 when it is already there', () => {
    expect(hitSlopFor(48)).toBe(0);
    expect(hitSlopFor(60)).toBe(0);
    expect(hitSlopFor(NaN)).toBe(0);
    expect(hitSlopFor(40)).toBe(4);
    expect(hitSlopFor(34)).toBe(7);
  });
});

describe('scaleStyle', () => {
  it('returns the same object at 100 %', () => {
    const s = { padding: 12 };
    expect(scaleStyle(s, 1)).toBe(s);
  });

  it('scales sizes and leaves everything else alone', () => {
    const s = {
      fontSize: 20,
      lineHeight: 26,
      letterSpacing: 1,
      paddingHorizontal: 16,
      marginTop: -4,
      gap: 8,
      width: 56,
      height: '100%',
      borderRadius: 12,
      borderWidth: 1,
      opacity: 0.8,
      flex: 1,
      zIndex: 5,
      elevation: 4,
      fontWeight: '700',
      color: '#123456',
      shadowOffset: { width: 0, height: 2 },
      top: 10,
    };
    expect(scaleStyle(s, 1.15)).toEqual({
      fontSize: 23,
      lineHeight: 30,
      letterSpacing: 1.15,
      paddingHorizontal: 18.5,
      marginTop: -4.5,
      gap: 9,
      width: 64.5,
      height: '100%',
      borderRadius: 14,
      borderWidth: 1,
      opacity: 0.8,
      flex: 1,
      zIndex: 5,
      elevation: 4,
      fontWeight: '700',
      color: '#123456',
      shadowOffset: { width: 0, height: 2.5 },
      top: 11.5,
    });
  });

  it('keeps touch sizes at 48 at Small while other sizes shrink', () => {
    // A tap row and the app's 48 dp touch box (target.min), drawn round.
    expect(scaleStyle({ minHeight: 48, minWidth: 54 }, 0.85)).toEqual({
      minHeight: 48,
      minWidth: 48,
    });
    expect(scaleStyle({ width: 48, height: 48, borderRadius: 24 }, 0.85)).toEqual({
      width: 48,
      height: 48,
      borderRadius: 24,
    });
    // Not touch sizes: an avatar, a thumbnail, a short chip.
    expect(scaleStyle({ width: 36, height: 56, minHeight: 30 }, 0.85)).toEqual({
      width: 30.5,
      height: 47.5,
      minHeight: 25.5,
    });
    // They grow at Large like everything else.
    expect(scaleStyle({ width: 48, minHeight: 48 }, 1.15)).toEqual({ width: 55, minHeight: 55 });
  });

  it('does not mutate its input', () => {
    const s = { padding: 10 };
    scaleStyle(s, 1.15);
    expect(s).toEqual({ padding: 10 });
  });
});

describe('the 10 sp text floor', () => {
  it('leaves every 12 sp-and-up caption alone at Small', () => {
    expect(MIN_TEXT_SP).toBe(10);
    expect(scaleFontSize(12, 0.85)).toBe(10);
    expect(scaleFontSize(13, 0.85)).toBe(11);
    expect(scaleFontSize(16, 0.85)).toBe(13.5);
  });

  it('holds up the few sub-12 labels at Small', () => {
    expect(scaleFontSize(11, 0.85)).toBe(10);
    expect(scaleFontSize(11.5, 0.85)).toBe(10);
  });

  it('text designed under the floor keeps its own size and still grows at Large', () => {
    expect(scaleFontSize(10, 0.85)).toBe(10);
    expect(scaleFontSize(9.5, 0.85)).toBe(9.5);
    expect(scaleFontSize(10, 1.15)).toBe(11.5);
  });

  it('a held-up size keeps its line height ratio', () => {
    expect(scaleStyle({ fontSize: 11, lineHeight: 14 }, 0.85)).toEqual({
      fontSize: 10,
      lineHeight: 12.5,
    });
  });
});

describe('scaleSheet', () => {
  const sheet = { a: { padding: 10 }, b: { fontSize: 20, color: 'red' } };

  it('is the same sheet at 100 %', () => {
    expect(scaleSheet(sheet, 1)).toBe(sheet);
  });

  it('scales every entry and memoises per factor', () => {
    const small = scaleSheet(sheet, 0.85);
    expect(small).toEqual({ a: { padding: 8.5 }, b: { fontSize: 17, color: 'red' } });
    expect(scaleSheet(sheet, 0.85)).toBe(small);
    expect(scaleSheet(sheet, 1.15)).not.toBe(small);
    expect(scaleSheet(sheet, 1.15).a).toEqual({ padding: 11.5 });
  });
});

describe('scaleFont', () => {
  it('scales the MD3 metrics, identity at 100 %', () => {
    const f = { fontFamily: 'X', fontSize: 16, lineHeight: 24, letterSpacing: 0.5 };
    expect(scaleFont(f, 1)).toBe(f);
    const large = scaleFont(f, 1.15);
    expect(large).toMatchObject({ fontFamily: 'X', fontSize: 18.5, lineHeight: 28 });
    expect(large.letterSpacing).toBeCloseTo(0.575, 1);
  });
});

describe('effectiveScreenDp', () => {
  it('is the width a 100 % layout gets at another size', () => {
    expect(effectiveScreenDp(360, 1)).toBe(360);
    expect(effectiveScreenDp(360, 1.15)).toBeCloseTo(313.04, 2);
    expect(effectiveScreenDp(360, 0.85)).toBeCloseTo(423.53, 2);
    expect(effectiveScreenDp(360, 0)).toBe(360);
    expect(effectiveScreenDp(360, NaN)).toBe(360);
  });
});
