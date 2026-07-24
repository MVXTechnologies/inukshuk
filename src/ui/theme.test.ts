import { contrastRatio } from '@core/color/contrast';
import {
  darkTheme,
  edgeDarkTheme,
  edgeLightTheme,
  lightTheme,
  minimalDarkTheme,
  minimalLightTheme,
} from './theme';

/**
 * Legibility gate. This is an outdoor trail app, so we hold text to AAA (7:1) for
 * body/secondary text and AA (4.5:1) for text on accent/container fills. Catches
 * a regression like the pale secondary text reported in the field.
 */
const AAA = 7;
const AA = 4.5;

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
  ['minimal light', minimalLightTheme],
  ['minimal dark', minimalDarkTheme],
  ['edge light', edgeLightTheme],
  ['edge dark', edgeDarkTheme],
])('%s theme contrast', (_name, theme) => {
  const c = theme.colors;

  it('primary body text meets AAA on its surface', () => {
    expect(contrastRatio(c.onSurface, c.surface)).toBeGreaterThanOrEqual(AAA);
  });

  it('secondary text (onSurfaceVariant) meets AAA on surface and AA on cards', () => {
    expect(contrastRatio(c.onSurfaceVariant, c.surface)).toBeGreaterThanOrEqual(AAA);
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
