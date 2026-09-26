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

// ---------------------------------------------------------------------------
// UI styles beyond the classic brand look. 'minimal' strips the chrome to a
// quiet monochrome; 'edge' is the pastel look whose map controls become
// half-pills hugging the screen edge (see EdgePill). Both keep every colour
// inside MD3 slots so Paper components need no per-style code, and both are
// held to the same contrast gates as the classic themes (theme.test.ts).
// ---------------------------------------------------------------------------

export type UiStyle = 'classic' | 'minimal' | 'edge';

export const minimalLightTheme: MD3Theme = {
  ...lightTheme,
  roundness: 2,
  colors: {
    ...lightTheme.colors,
    primary: '#1F1F1F',
    onPrimary: '#FFFFFF',
    primaryContainer: '#E8E8E8',
    onPrimaryContainer: '#111111',
    secondary: '#444444',
    onSecondary: '#FFFFFF',
    secondaryContainer: '#EDEDED',
    onSecondaryContainer: '#161616',
    tertiary: '#333333',
    onTertiary: '#FFFFFF',
    tertiaryContainer: '#E4E4E4',
    onTertiaryContainer: '#101010',
    background: '#FCFCFC',
    surface: '#FFFFFF',
    surfaceVariant: '#F0F0F0',
    onSurfaceVariant: '#1A1A1A',
    outline: '#C8C8C8',
    error: '#B3261E',
  },
};

export const minimalDarkTheme: MD3Theme = {
  ...darkTheme,
  roundness: 2,
  colors: {
    ...darkTheme.colors,
    primary: '#E6E6E6',
    onPrimary: '#111111',
    primaryContainer: '#333333',
    onPrimaryContainer: '#F0F0F0',
    secondary: '#BFBFBF',
    onSecondary: '#1A1A1A',
    secondaryContainer: '#2E2E2E',
    onSecondaryContainer: '#E8E8E8',
    tertiary: '#CFCFCF',
    onTertiary: '#141414',
    tertiaryContainer: '#2E2E2E',
    onTertiaryContainer: '#EDEDED',
    background: '#0F0F0F',
    surface: '#171717',
    surfaceVariant: '#2A2A2A',
    onSurfaceVariant: '#DEDEDE',
    outline: '#6E6E6E',
    error: '#FFB4AB',
  },
};

// Edge pastels are the LOGO's hues, lifted: sage #93A25E → pastel sage,
// river #5C93B7 → pastel river, paper cream #F2ECE0 as the ground, and the
// charcoal-navy stone figure (#2D3740) as the night ground.
export const edgeLightTheme: MD3Theme = {
  ...lightTheme,
  roundness: 6,
  colors: {
    ...lightTheme.colors,
    primary: '#BECBA0', // pastel sage
    onPrimary: '#2A331A',
    primaryContainer: '#E2E9CE',
    onPrimaryContainer: '#26301A',
    secondary: '#A9BDC9', // pastel stone-blue
    onSecondary: '#1F2D36',
    secondaryContainer: '#DCE7ED',
    onSecondaryContainer: '#1C2930',
    tertiary: '#AECCDF', // pastel river — the "+" dial
    onTertiary: '#17303F',
    tertiaryContainer: '#D6E7F1',
    onTertiaryContainer: '#142A38',
    background: '#F7F1E4', // the logo's paper cream, lifted
    surface: '#FBF7ED',
    surfaceVariant: '#EAE3D2',
    onSurfaceVariant: '#32302A',
    outline: '#A29B8C',
    error: '#B3261E',
  },
};

export const edgeDarkTheme: MD3Theme = {
  ...darkTheme,
  roundness: 6,
  colors: {
    ...darkTheme.colors,
    primary: '#BECBA0',
    onPrimary: '#232B13',
    primaryContainer: '#454F31',
    onPrimaryContainer: '#E2E9CE',
    secondary: '#A9BDC9',
    onSecondary: '#1B2830',
    secondaryContainer: '#3B4750',
    onSecondaryContainer: '#DCE7ED',
    tertiary: '#AECCDF',
    onTertiary: '#122B3A',
    tertiaryContainer: '#2E4756',
    onTertiaryContainer: '#D6E7F1',
    background: '#1E242B', // the stone figure's charcoal-navy, deepened
    surface: '#262D35',
    surfaceVariant: '#3A424C',
    onSurfaceVariant: '#D5DBE1',
    outline: '#8B94A0',
    error: '#FFB4AB',
  },
};

/**
 * The edge rail's pill chrome. One fixed dark slab in BOTH colour schemes
 * (user call): the pills sit over map tiles, not themed surfaces, so a single
 * charcoal reads consistently; engagement is signalled by the pastel-river
 * ink — the same blue as the "+" dial and the edge tab selection.
 */
export const edgePill = {
  background: '#262D35',
  ink: '#E6EAEF',
  active: '#AECCDF',
  muted: '#77808C',
};

/** The MD3 theme for a UI style + resolved colour scheme. */
export function resolveTheme(style: UiStyle, scheme: 'light' | 'dark'): MD3Theme {
  const dark = scheme === 'dark';
  if (style === 'minimal') return dark ? minimalDarkTheme : minimalLightTheme;
  if (style === 'edge') return dark ? edgeDarkTheme : edgeLightTheme;
  return dark ? darkTheme : lightTheme;
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
