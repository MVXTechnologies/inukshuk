import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';

/**
 * Inukshuk's visual identity is sampled directly from the app logo
 * (`assets/icon-source.png`): the charcoal stone figure, sage foliage, a slate
 * river, mountain grey and warm paper cream. These map onto React Native
 * Paper's Material Design 3 system so every component stays a standard,
 * well-documented Paper primitive — easy to maintain and theme.
 */

// Palette sampled from the logo. Surfaces use deepened variants of the logo's
// sage (#93A25E) and river (#5C93B7) so white text meets contrast on them.
const INUKSHUK = '#2D3740'; // charcoal-navy — the stone figure, our primary mark
const FOLIAGE_DEEP = '#566B33'; // deepened sage — green surfaces
const RIVER_DEEP = '#3E7BA0'; // deepened river — accents / route line
const STONE = '#8A8B8C'; // mountain grey
const CREAM = '#F2ECE0'; // warm paper — app background

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: FOLIAGE_DEEP,
    onPrimary: '#FFFFFF',
    primaryContainer: '#DCE8BC',
    onPrimaryContainer: '#18250A',
    secondary: INUKSHUK,
    onSecondary: '#FFFFFF',
    secondaryContainer: '#D6DBE0',
    onSecondaryContainer: '#161C22',
    // Softened to the Edge family's pastel river (user call): the "+" dial
    // and compass wear this, and the deep slate read too heavy next to them.
    tertiary: '#AECCDF',
    onTertiary: '#17303F',
    tertiaryContainer: '#D6E7F1',
    onTertiaryContainer: '#142A38',
    background: CREAM,
    surface: '#FBF8F2',
    surfaceVariant: '#E3DDD0',
    // Secondary text (List descriptions, subheaders, card subtitles, inactive
    // nav). Pushed to near-black: at small/thin subheader sizes a mid-dark olive
    // still reads "pale" once anti-aliased against cream, so we maximize stroke
    // darkness (~15:1 on surface) for crisp outdoor readability. Gated by
    // theme.test.ts.
    onSurfaceVariant: '#242A20',
    outline: STONE,
    error: '#BA1A1A',
  },
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#B6C98A',
    onPrimary: '#28340A',
    primaryContainer: '#3E5021',
    onPrimaryContainer: '#D2E5A4',
    secondary: '#B9C4CE',
    onSecondary: '#243039',
    secondaryContainer: '#3B4750',
    onSecondaryContainer: '#D6DBE0',
    tertiary: '#8FC0E4',
    onTertiary: '#00344D',
    tertiaryContainer: '#245068',
    onTertiaryContainer: '#C7E7FF',
    background: '#12150F',
    surface: '#1B1E17',
    surfaceVariant: '#43483E',
    // Brighten secondary text for parity with the light theme's contrast.
    onSurfaceVariant: '#D2DAC8',
    outline: STONE,
    error: '#FFB4AB',
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
  ...MD3LightTheme,
  roundness: 2,
  colors: {
    ...MD3LightTheme.colors,
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
  ...MD3DarkTheme,
  roundness: 2,
  colors: {
    ...MD3DarkTheme.colors,
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
  ...MD3LightTheme,
  roundness: 6,
  colors: {
    ...MD3LightTheme.colors,
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
  ...MD3DarkTheme,
  roundness: 6,
  colors: {
    ...MD3DarkTheme.colors,
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

// Warm orange-red route line, in the AllTrails/Gaia idiom — reads clearly over a
// muted topographic basemap where the brand slate-blue washed out. The blue
// (RIVER_DEEP) still leads the app chrome; orange is reserved for "your path".
const ROUTE_WARM = '#E8612C';

/** Semantic colours used by the map HUD that aren't part of MD3. */
export const mapColors = {
  trail: ROUTE_WARM, // recorded GPX route — warm orange-red
  trailCasing: 'rgba(38, 28, 18, 0.5)', // dark casing under the route, for legibility on topo
  trackOverlay: '#C2410C', // saved-track overlays — burnt orange
  trackOverlayActive: '#EA580C', // the inspected track — brighter orange
  userLocation: FOLIAGE_DEEP, // live position dot / scrub marker — olive, stands apart
  pdfOverlayBorder: INUKSHUK,
  // Trim preview: the kept segment pops, the cut ends recede. Drawn over map
  // tiles (not themed surfaces), so one pair works in light and dark mode.
  trimKept: '#EA580C',
  trimCut: '#8A8F98',
};
