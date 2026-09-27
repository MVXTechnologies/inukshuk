import type { StoneBasemapScheme } from '@core/map/stoneStyle';
import { palette, schemeTokens, type SchemeTokens } from '@ui/tokens';

/**
 * Maps the app's Stone & Paper tokens onto the vector base map's palette
 * (`@core/map/stoneStyle`). Every colour is an existing token — no new hex —
 * picked to match the topo board (`docs/design/ui-revamp/boards/blobs/`,
 * light `Main.html`, dark `After-Map-Dark.html`):
 *
 * - land: paper (light) / the stone-night surface, the board's #1B2126;
 * - woods: sage (light) / sageDeep (night), washed by the style;
 * - water and shore: river; water labels: the info blue (#8CC4F0 on night);
 * - roads: white-paper ribbon in an outline casing (light), a stone ribbon
 *   in a near-black casing (night);
 * - trails: graniteDeep (light, the board's exact path colour) / the night
 *   secondary ink;
 * - contours: ochre, the closest token to the board's brown isolines.
 */
export function stoneSchemeFromTokens(tokens: SchemeTokens, dark: boolean): StoneBasemapScheme {
  const land = dark ? tokens.surface : tokens.background;
  return {
    dark,
    land,
    landAlt: tokens.surfaceVariant,
    vegetation: dark ? palette.sageDeep : palette.sage,
    water: palette.river,
    waterLine: palette.river,
    waterInk: tokens.data.info,
    roadFill: dark ? tokens.outlineVariant : tokens.surface,
    roadCasing: dark ? tokens.background : tokens.outlineVariant,
    path: dark ? tokens.inkVariant : palette.graniteDeep,
    lineMuted: tokens.outline,
    building: tokens.outlineVariant,
    contour: palette.ochre,
    ink: tokens.ink,
    inkMuted: tokens.inkMuted,
    halo: land,
  };
}

/** The base-map palette for the current colour scheme. */
export function stoneScheme(dark: boolean): StoneBasemapScheme {
  return stoneSchemeFromTokens(schemeTokens(dark), dark);
}
