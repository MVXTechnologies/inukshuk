import { configureFonts, MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';

import { FONT_FAMILY } from './fonts';
import type { DisplayCondition } from '@core/display/condition';

import {
  darkScheme,
  lightScheme,
  nightScheme,
  palette,
  sunlightScheme,
  type SchemeTokens,
} from './tokens';

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

/** Sunlight: black on white, maximum contrast (decision 4). */
export const sunlightTheme: MD3Theme = {
  ...MD3LightTheme,
  fonts,
  colors: {
    ...schemeColors(sunlightScheme),
    primary: palette.black,
    onPrimary: palette.white,
    primaryContainer: '#EEEEEE',
    onPrimaryContainer: palette.black,
    secondary: palette.black,
    onSecondary: palette.white,
    secondaryContainer: palette.black,
    onSecondaryContainer: palette.white,
    tertiary: palette.black,
    onTertiary: palette.white,
    tertiaryContainer: '#EEEEEE',
    onTertiaryContainer: palette.black,
    error: palette.signalRed,
    onError: palette.white,
    errorContainer: '#FFE5E5',
    onErrorContainer: '#5F0000',
    surfaceDisabled: 'rgba(0,0,0,0.12)',
    onSurfaceDisabled: 'rgba(0,0,0,0.45)',
    inverseSurface: palette.black,
    inverseOnSurface: palette.white,
    inversePrimary: palette.white,
    shadow: palette.black,
    scrim: palette.black,
    backdrop: 'rgba(0,0,0,0.5)',
  },
};

/** Night red: red on black, no blue or green (decision 4). */
export const nightTheme: MD3Theme = {
  ...MD3DarkTheme,
  fonts,
  colors: {
    ...schemeColors(nightScheme),
    primary: nightScheme.ink,
    onPrimary: palette.black,
    primaryContainer: nightScheme.elevation.level5,
    onPrimaryContainer: nightScheme.ink,
    secondary: nightScheme.ink,
    onSecondary: palette.black,
    secondaryContainer: nightScheme.elevation.level5,
    onSecondaryContainer: nightScheme.ink,
    tertiary: nightScheme.ink,
    onTertiary: palette.black,
    tertiaryContainer: nightScheme.elevation.level5,
    onTertiaryContainer: nightScheme.ink,
    error: nightScheme.ink,
    onError: palette.black,
    errorContainer: nightScheme.elevation.level5,
    onErrorContainer: nightScheme.ink,
    surfaceDisabled: 'rgba(255,59,48,0.12)',
    onSurfaceDisabled: 'rgba(255,59,48,0.5)',
    inverseSurface: nightScheme.ink,
    inverseOnSurface: palette.black,
    inversePrimary: palette.black,
    shadow: palette.black,
    scrim: palette.black,
    backdrop: 'rgba(0,0,0,0.6)',
  },
};

/**
 * The Paper theme for the resolved colour scheme and display mode. Sunlight
 * and Night red override the system light/dark choice while they are on.
 */
export function resolveTheme(
  scheme: 'light' | 'dark',
  condition: DisplayCondition = 'normal',
): MD3Theme {
  if (condition === 'sunlight') return sunlightTheme;
  if (condition === 'night') return nightTheme;
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
