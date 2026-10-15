import { estimateWidthDp, fitStripValue, isName, shortUnit, VALUE_SMALL_SP, VALUE_SP } from './fit';

// A 1-space cell on a 411 dp phone: (411 − 24 padding − 3 dividers of 17) / 4.
const ONE_SPACE = 84;

describe('fitStripValue (QA 2.6.0: values are never cut)', () => {
  it('keeps a value that fits whole', () => {
    const v = { glyph: 'speed', value: '3.6', unit: 'km/h' };
    expect(fitStripValue(v, ONE_SPACE)).toEqual({ value: v, valueSp: VALUE_SP, shrinkToFit: true });
  });

  it('drops the tag first when a glyph still names the field ("COG 300°…")', () => {
    const cog = { glyph: 'navigation', tag: 'COG', value: '300°', unit: 'NW' };
    const fit = fitStripValue(cog, ONE_SPACE);
    expect(fit.value.tag).toBeUndefined();
    expect(fit.value.value).toBe('300°');
    expect(fit.value.glyph).toBe('navigation');
  });

  it('"SOG 4.8 kn" fits a 1-space cell without its tag, value and unit whole', () => {
    const sog = { glyph: 'sailing', tag: 'SOG', value: '4.8', unit: 'kn' };
    const fit = fitStripValue(sog, ONE_SPACE);
    expect(fit.value).toEqual({ glyph: 'sailing', value: '4.8', unit: 'kn' });
  });

  it('then a type step, then unit detail, then the glyph', () => {
    const v = { glyph: 'navigation', tag: 'COG', value: '300°', unit: 'NW' };
    const narrow = (w: number) => fitStripValue(v, w);
    const noTag = estimateWidthDp({ glyph: 'navigation', value: '300°', unit: 'NW' }, VALUE_SP);
    expect(narrow(noTag).valueSp).toBe(VALUE_SP);
    expect(narrow(noTag - 1).valueSp).toBe(VALUE_SMALL_SP);
    const small = estimateWidthDp({ glyph: 'navigation', value: '300°' }, VALUE_SMALL_SP);
    expect(narrow(small).value).toEqual({ glyph: 'navigation', value: '300°' });
    expect(narrow(small - 1).value).toEqual({ value: '300°' });
  });

  it('a tag-only field keeps its tag until nothing else is left', () => {
    const eta = { tag: 'ETA', value: '≈9:35 AM' };
    expect(fitStripValue(eta, 95).value.tag).toBe('ETA');
    expect(fitStripValue(eta, 30).value).toEqual({ value: '≈9:35 AM' });
  });

  it('a shorter unit can be enough ("1.24 nmi" → "1.24 NM")', () => {
    const v = { glyph: 'straighten', value: '1.24', unit: 'nmi' };
    const w = estimateWidthDp({ glyph: 'straighten', value: '1.24', unit: 'NM' }, VALUE_SMALL_SP);
    expect(fitStripValue(v, w)).toEqual({
      value: { glyph: 'straighten', value: '1.24', unit: 'NM' },
      valueSp: VALUE_SMALL_SP,
      shrinkToFit: true,
    });
  });

  it('a long name keeps its glyph, takes the type step and ellipsises: never shrunk unreadable', () => {
    const name = { glyph: 'flag', value: 'Kiosque Edwin-Bélanger' };
    expect(fitStripValue(name, 60)).toEqual({
      value: name,
      valueSp: VALUE_SMALL_SP,
      shrinkToFit: false,
    });
    expect(fitStripValue({ glyph: 'flag', value: 'Camp' }, 84)).toEqual({
      value: { glyph: 'flag', value: 'Camp' },
      valueSp: VALUE_SP,
      shrinkToFit: false,
    });
    expect(isName({ value: '—' })).toBe(true);
    expect(isName({ value: '≈9:35 AM' })).toBe(false);
  });

  it('a number too long for anything is left to native shrinking, bare', () => {
    const v = { glyph: 'speed', value: '12345.6', unit: 'km/h' };
    expect(fitStripValue(v, 20)).toEqual({
      value: { value: '12345.6', unit: 'km/h' },
      valueSp: VALUE_SMALL_SP,
      shrinkToFit: true,
    });
  });

  it('a larger font scale fits less', () => {
    const v = { glyph: 'speed', value: '13.6', unit: 'km/h' };
    expect(estimateWidthDp(v, VALUE_SP, 1.3)).toBeGreaterThan(estimateWidthDp(v, VALUE_SP));
  });
});

describe('shortUnit', () => {
  it('drops a compass point after degrees, shortens nmi and the tide trend', () => {
    expect(shortUnit('300°', 'NW')).toBeUndefined();
    expect(shortUnit('1.2', 'nmi')).toBe('NM');
    expect(shortUnit('+3.84', 'm ↑')).toBe('↑');
    expect(shortUnit('+12.60', 'ft ↓')).toBe('↓');
    expect(shortUnit('+3.84', 'm↓')).toBe('↓');
    expect(shortUnit('3.6', 'km/h')).toBe('km/h');
  });
});
