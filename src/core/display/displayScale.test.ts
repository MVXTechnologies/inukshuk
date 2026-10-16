import {
  DEFAULT_DISPLAY_SCALE,
  DISPLAY_SCALES,
  MIN_TOUCH,
  displayScaleAt,
  displayScaleFactor,
  displayScaleIndex,
  displayScaleLabel,
  effectiveScreenDp,
  hitSlopFor,
  isDisplayScale,
  normalizeDisplayScale,
  scaleFont,
  scaleSheet,
  scaleSize,
  scaleStyle,
  touchSize,
} from './displayScale';

describe('steps', () => {
  it('runs 60 % to 150 % in 10 % steps, default 100 %', () => {
    expect(DISPLAY_SCALES).toEqual([60, 70, 80, 90, 100, 110, 120, 130, 140, 150]);
    expect(DEFAULT_DISPLAY_SCALE).toBe(100);
  });

  it.each([[105], [0], [55], [155], [1], [0.8], ['80'], [null], [undefined], [{}], [NaN]])(
    'normalises junk (%p) to 100 %%',
    (junk) => {
      expect(isDisplayScale(junk)).toBe(false);
      expect(normalizeDisplayScale(junk)).toBe(100);
      expect(displayScaleFactor(junk)).toBe(1);
    },
  );

  it('keeps a real step', () => {
    for (const v of DISPLAY_SCALES) {
      expect(normalizeDisplayScale(v)).toBe(v);
      expect(displayScaleFactor(v)).toBeCloseTo(v / 100);
    }
  });

  it('labels with a space before the percent sign', () => {
    expect(displayScaleLabel(80)).toBe('80 %');
  });

  it('maps slider stops both ways, clamped', () => {
    expect(displayScaleIndex(60)).toBe(0);
    expect(displayScaleIndex(100)).toBe(4);
    expect(displayScaleIndex(150)).toBe(9);
    expect(displayScaleIndex('junk')).toBe(4);
    expect(displayScaleAt(0)).toBe(60);
    expect(displayScaleAt(4)).toBe(100);
    expect(displayScaleAt(3.6)).toBe(100);
    expect(displayScaleAt(-3)).toBe(60);
    expect(displayScaleAt(42)).toBe(150);
    expect(displayScaleAt(NaN)).toBe(60);
    DISPLAY_SCALES.forEach((v, i) => expect(displayScaleAt(i)).toBe(v));
  });
});

describe('scaleSize', () => {
  it('is the identity at 100 %', () => {
    for (const n of [0, 0.5, 12.5, 13, 48, -6, 1000]) expect(scaleSize(n, 1)).toBe(n);
  });

  it('scales and rounds to the half dp', () => {
    expect(scaleSize(48, 0.6)).toBe(29);
    expect(scaleSize(16, 0.6)).toBe(9.5);
    expect(scaleSize(13, 0.7)).toBe(9);
    expect(scaleSize(22, 1.5)).toBe(33);
    expect(scaleSize(12.5, 1.3)).toBe(16.5);
    expect(scaleSize(-6, 0.6)).toBe(-3.5);
  });
});

describe('touch targets never shrink below 48 dp', () => {
  it.each(DISPLAY_SCALES.map((v) => [v]))('at %p %%', (v) => {
    const k = displayScaleFactor(v);
    for (const n of [24, 36, 44, 48, 52, 56]) {
      expect(touchSize(n, k)).toBeGreaterThanOrEqual(MIN_TOUCH);
      const visual = scaleSize(n, k);
      expect(visual + 2 * hitSlopFor(visual)).toBeGreaterThanOrEqual(MIN_TOUCH);
    }
  });

  it('touchSize grows with the scale above 48', () => {
    expect(touchSize(48, 1.5)).toBe(72);
    expect(touchSize(48, 0.6)).toBe(48);
    expect(touchSize(30, 1, 44)).toBe(44);
  });

  it('hitSlopFor is 0 for a box already big enough, and for junk', () => {
    expect(hitSlopFor(48)).toBe(0);
    expect(hitSlopFor(60)).toBe(0);
    expect(hitSlopFor(NaN)).toBe(0);
    expect(hitSlopFor(29)).toBe(10);
    expect(hitSlopFor(36)).toBe(6);
  });
});

describe('scaleStyle', () => {
  it('returns the same object at 100 %', () => {
    const s = { padding: 12 };
    expect(scaleStyle(s, 1)).toBe(s);
  });

  it('scales sizes and leaves everything else alone', () => {
    const s = {
      fontSize: 16,
      lineHeight: 22,
      letterSpacing: 1,
      paddingHorizontal: 16,
      marginTop: -4,
      gap: 8,
      width: 48,
      height: '100%',
      borderRadius: 24,
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
    expect(scaleStyle(s, 0.5)).toEqual({
      fontSize: 8,
      lineHeight: 11,
      letterSpacing: 0.5,
      paddingHorizontal: 8,
      marginTop: -2,
      gap: 4,
      width: 24,
      height: '100%',
      borderRadius: 12,
      borderWidth: 1,
      opacity: 0.8,
      flex: 1,
      zIndex: 5,
      elevation: 4,
      fontWeight: '700',
      color: '#123456',
      shadowOffset: { width: 0, height: 1 },
      top: 5,
    });
  });

  it('keeps a touch-sized minHeight / minWidth at 48 while smaller minimums scale', () => {
    expect(scaleStyle({ minHeight: 48, minWidth: 54 }, 0.6)).toEqual({
      minHeight: 48,
      minWidth: 48,
    });
    expect(scaleStyle({ minHeight: 54 }, 1.5)).toEqual({ minHeight: 81 });
    expect(scaleStyle({ minHeight: 30, minWidth: 19 }, 0.6)).toEqual({
      minHeight: 18,
      minWidth: 11.5,
    });
  });

  it('does not mutate its input', () => {
    const s = { padding: 10 };
    scaleStyle(s, 1.5);
    expect(s).toEqual({ padding: 10 });
  });
});

describe('scaleSheet', () => {
  const sheet = { a: { padding: 10 }, b: { fontSize: 20, color: 'red' } };

  it('is the same sheet at 100 %', () => {
    expect(scaleSheet(sheet, 1)).toBe(sheet);
  });

  it('scales every entry and memoises per factor', () => {
    const small = scaleSheet(sheet, 0.6);
    expect(small).toEqual({ a: { padding: 6 }, b: { fontSize: 12, color: 'red' } });
    expect(scaleSheet(sheet, 0.6)).toBe(small);
    expect(scaleSheet(sheet, 1.5)).not.toBe(small);
    expect(scaleSheet(sheet, 1.5).a).toEqual({ padding: 15 });
  });
});

describe('scaleFont', () => {
  it('scales the MD3 metrics, identity at 100 %', () => {
    const f = { fontFamily: 'X', fontSize: 16, lineHeight: 24, letterSpacing: 0.5 };
    expect(scaleFont(f, 1)).toBe(f);
    expect(scaleFont(f, 1.5)).toEqual({
      fontFamily: 'X',
      fontSize: 24,
      lineHeight: 36,
      letterSpacing: 0.75,
    });
  });
});

describe('effectiveScreenDp', () => {
  it('is the width a 100 % layout gets at another size', () => {
    expect(effectiveScreenDp(360, 1)).toBe(360);
    expect(effectiveScreenDp(360, 1.5)).toBe(240);
    expect(effectiveScreenDp(360, 0.6)).toBe(600);
    expect(effectiveScreenDp(360, 0)).toBe(360);
    expect(effectiveScreenDp(360, NaN)).toBe(360);
  });
});
