import { contrastRatio } from '@core/color/contrast';
import { isPurple } from '@core/color/hsl';
import { darkTheme, lightTheme, nightTheme, resolveTheme, sunlightTheme } from './theme';

/**
 * Legibility gate. This is an outdoor trail app, so we hold text to AAA (7:1) for
 * body/secondary text and AA (4.5:1) for text on accent/container fills. Catches
 * a regression like the pale secondary text reported in the field.
 */
const AAA = 7;
const AA = 4.5;

describe.each([
  ['light', lightTheme],
  ['stone night', darkTheme],
  ['sunlight', sunlightTheme],
  ['night red', nightTheme],
])('%s theme', (name, theme) => {
  const c = theme.colors;
  // Night red cannot reach AAA: pure red on pure black is only 5.25:1, and a
  // brighter red needs green or blue, which night vision rules out. It is held
  // to AA, the most red-on-black allows.
  const BODY = name === 'night red' ? AA : AAA;

  // The purple leak: Paper's MD3 defaults tint elevation, outlines, inverse
  // and disabled colours lavender. Every slot is now set from tokens.
  it('has no purple in any colour slot', () => {
    const slots = Object.entries(c).flatMap(([k, v]) =>
      typeof v === 'string' ? [[k, v]] : Object.entries(v).map(([l, w]) => [`${k}.${l}`, w]),
    );
    expect(slots.filter(([, v]) => isPurple(v as string))).toEqual([]);
  });

  it('uses Atkinson Hyperlegible Next for every text variant', () => {
    for (const variant of Object.values(theme.fonts)) {
      expect(variant.fontFamily).toMatch(/Atkinson ?Hyperlegible ?Next/);
    }
  });

  it('primary body text meets AAA on its surface (AA for night red)', () => {
    expect(contrastRatio(c.onSurface, c.surface)).toBeGreaterThanOrEqual(BODY);
  });

  it('secondary text (onSurfaceVariant) meets AAA on surface and AA on cards', () => {
    expect(contrastRatio(c.onSurfaceVariant, c.surface)).toBeGreaterThanOrEqual(BODY);
    expect(contrastRatio(c.onSurfaceVariant, c.surfaceVariant)).toBeGreaterThanOrEqual(AA);
  });

  it('text on accent and container fills meets AA', () => {
    expect(contrastRatio(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(c.onSecondary, c.secondary)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(c.onTertiary, c.tertiary)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(c.onPrimaryContainer, c.primaryContainer)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(c.onSecondaryContainer, c.secondaryContainer)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(c.onTertiaryContainer, c.tertiaryContainer)).toBeGreaterThanOrEqual(AA);
  });
});

describe('resolveTheme', () => {
  it('picks the theme for the colour scheme', () => {
    expect(resolveTheme('light')).toBe(lightTheme);
    expect(resolveTheme('dark')).toBe(darkTheme);
  });

  it('lets Sunlight and Night red override the system scheme', () => {
    expect(resolveTheme('dark', 'sunlight')).toBe(sunlightTheme);
    expect(resolveTheme('light', 'night')).toBe(nightTheme);
    expect(resolveTheme('dark', 'normal')).toBe(darkTheme);
  });
});
