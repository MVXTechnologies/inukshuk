import { configureFonts, MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';

import { FONT_FAMILY } from './fonts';
import { darkScheme, lightScheme, palette, type SchemeTokens } from './tokens';

/**
 * Inukshuk's Paper themes, built from the Stone & Paper tokens (`tokens.ts`).
 * Every MD3 colour slot is set here: spreading MD3LightTheme/MD3DarkTheme
 * left Material's lavender in the elevation steps, outlines, inverse and
 * disabled colours (the "purple leak"); `theme.test.ts` now fails on any
 * purple slot. Roles: stone leads primary actions, sage marks selection, red
 * is reserved for stop, danger and lost GPS.
 */

const fonts = configureFonts({ config: { fontFamily: FONT_FAMILY } });

/** The MD3 slots every scheme shares the shape of. */
function schemeColors(t: SchemeTokens) {
  return {
    background: t.background,
    onBackground: t.ink,
    surface: t.surface,
    onSurface: t.ink,
    surfaceVariant: t.surfaceVariant,
    // Secondary text (List descriptions, subheaders, card subtitles, inactive
    // nav). Kept strong on purpose: at small sizes a mid-grey reads "pale" once
    // anti-aliased against cream outdoors (field report). Gated AAA by
    // theme.test.ts. The muted ink is for captions only.
    onSurfaceVariant: t.inkVariant,
    outline: t.outline,
    outlineVariant: t.outlineVariant,
    elevation: { ...t.elevation },
  };
}

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  fonts,
  colors: {
    ...schemeColors(lightScheme),
    primary: palette.stone,
    onPrimary: palette.surface,
    primaryContainer: '#DCE1E6',
    onPrimaryContainer: '#161C22',
    secondary: palette.sageDeep,
    onSecondary: palette.white,
    secondaryContainer: palette.sagePill,
    onSecondaryContainer: palette.stone,
    tertiary: palette.graniteDeep,
    onTertiary: palette.white,
    tertiaryContainer: '#E1E5E8',
    onTertiaryContainer: palette.ink,
    error: palette.signalRed,
    onError: palette.white,
    errorContainer: '#F9DEDC',
    onErrorContainer: '#410E0B',
    surfaceDisabled: 'rgba(30,37,44,0.12)',
    onSurfaceDisabled: 'rgba(30,37,44,0.38)',
    inverseSurface: palette.stone,
    inverseOnSurface: palette.paper,
    inversePrimary: '#B6C98A',
    shadow: palette.black,
    scrim: palette.black,
    backdrop: 'rgba(45,55,64,0.4)',
  },
};

/** Stone night. */
export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  fonts,
  colors: {
    ...schemeColors(darkScheme),
    // Stone vanishes on the night ground, so primary actions invert: paper ink
    // buttons with stone labels.
    primary: darkScheme.ink,
    onPrimary: palette.stone,
    primaryContainer: darkScheme.elevation.level5,
    onPrimaryContainer: darkScheme.ink,
    secondary: '#B6C98A',
    onSecondary: '#28340A',
    secondaryContainer: '#3F4B2A',
    onSecondaryContainer: '#DCE5BE',
    tertiary: darkScheme.inkVariant,
    onTertiary: darkScheme.surface,
    tertiaryContainer: darkScheme.elevation.level3,
    onTertiaryContainer: darkScheme.ink,
    error: '#FFB4AB',
    onError: '#690005',
    errorContainer: '#93000A',
    onErrorContainer: '#FFDAD6',
    surfaceDisabled: 'rgba(233,228,216,0.12)',
    onSurfaceDisabled: 'rgba(233,228,216,0.38)',
    inverseSurface: darkScheme.ink,
    inverseOnSurface: palette.stone,
    inversePrimary: palette.stone,
    shadow: palette.black,
    scrim: palette.black,
    backdrop: 'rgba(0,0,0,0.5)',
  },
};

/** The Paper theme for a resolved colour scheme. */
export function resolveTheme(scheme: 'light' | 'dark'): MD3Theme {
  return scheme === 'dark' ? darkTheme : lightTheme;
}

/** Semantic colours used by the map HUD that aren't part of MD3. */
export const mapColors = {
  // Warm orange-red route line, in the AllTrails/Gaia idiom: reads over a muted
  // topo basemap. Its casing is what carries it on paper-coloured ground
  // (route alone is 2.9:1 there; on its casing 3.8:1).
  trail: lightScheme.data.route,
  trailCasing: lightScheme.data.routeCasing,
  trackOverlay: '#C2410C', // saved-track overlays — burnt orange
  trackOverlayActive: '#EA580C', // the inspected track — brighter orange
  userLocation: palette.sageDeep, // live position dot / scrub marker (becomes the puck in PR 4)
  pdfOverlayBorder: palette.stone,
  // Trim preview: the kept segment pops, the cut ends recede. Drawn over map
  // tiles (not themed surfaces), so one pair works in light and dark mode.
  trimKept: '#EA580C',
  trimCut: '#8A8F98',
};
