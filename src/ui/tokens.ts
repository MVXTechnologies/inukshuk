/**
 * Stone & Paper — Inukshuk's design tokens (docs/design/ui-revamp, board
 * `After-Tokens.html`). Three layers:
 *
 * 1. `palette` — the named brand colours, sampled from the logo;
 * 2. `lightScheme` / `darkScheme` — surfaces, inks and elevation steps per
 *    colour scheme, and the semantic roles (`map`, `status`, `data`) the app
 *    draws with; MD3 slots in `theme.ts` are built from these;
 * 3. `space`, `radius`, `type`, `target` — the scale.
 *
 * Every colour here is held to the gates in `tokens.test.ts` (no purple;
 * contrast as used). Sunlight and Night red are specified by the board but
 * built with the Display modes (revamp PR 6).
 */

export const palette = {
  stone: '#2D3740',
  paper: '#F2ECE0',
  surface: '#FBF8F2',
  outlineVariant: '#D5CEBF',
  sage: '#93A25E',
  sageDeep: '#566B33',
  /** The active-tab / selected pill (Main.html). */
  sagePill: '#D6DEB8',
  river: '#5C93B7',
  puck: '#2F7FC1',
  granite: '#8A8B8C',
  graniteDeep: '#5F6B76',
  ochre: '#C98A2B',
  amber: '#B45309',
  signalRed: '#C62828',
  route: '#E8612C',
  routeCasing: '#5A1E0B',
  /** Muted ink: captions and labels, never body text (6.5:1 on the tab bar). */
  muted: '#4A5561',
  /** Near-black stone: body text (14.6:1 on surface). */
  ink: '#1E252C',
  white: '#FFFFFF',
  black: '#000000',
  /** Drop-shadow colour for chrome floating over the map. */
  shadow: '#14181C',
} as const;

/** MD3 elevation steps. Light: warm paper steps, replacing MD3's lavender tint. */
export interface ElevationSteps {
  level0: string;
  level1: string;
  level2: string;
  level3: string;
  level4: string;
  level5: string;
}

/** The colours one scheme draws with: surfaces, inks, lines and semantic roles. */
export interface SchemeTokens {
  background: string;
  surface: string;
  surfaceVariant: string;
  elevation: ElevationSteps;
  /** Body text. */
  ink: string;
  /** Secondary text: descriptions, subheaders. Held to AAA on surface. */
  inkVariant: string;
  /** Captions and labels only. */
  inkMuted: string;
  /** Control borders (graphics: ≥ 3:1 on surface). */
  outline: string;
  /** Dividers and hairlines (decorative). */
  outlineVariant: string;
  /** Hairlines between instrument fields (recording panel). */
  divider: string;
  map: {
    /** Chrome floating over the map (pills, rail, compass). */
    chrome: string;
    chromeInk: string;
    /** The "following" state of the target button (decision 2). */
    followInk: string;
    /** The minimized recording pill (decision 3 A: stone at 70 %). */
    chromeMini: string;
    /** Solid fill of a pressed/active map button (the following target). */
    chromeActive: string;
    /** Hairline between buttons joined in one pill. */
    chromeDivider: string;
    /** Compass needle: north tip and south tail. */
    compassNorth: string;
    compassSouth: string;
    /** Scale bar and attribution chips over the map. */
    chip: string;
    chipInk: string;
    chipInkMuted: string;
    /** Location puck: fill, ring, accuracy halo. */
    puck: string;
    puckRing: string;
    puckHalo: string;
  };
  status: {
    /** Recording: stone chip with a pulsing red dot. */
    recording: string;
    recordingDot: string;
    /** Paused and weak GPS: amber. `paused` fills; `pausedInk`/`gpsWeak` are text and icons on surfaces. */
    paused: string;
    onPaused: string;
    pausedInk: string;
    gpsWeak: string;
    /** Lost GPS and stop: red is reserved for stop, danger and lost GPS. */
    gpsLost: string;
    onGpsLost: string;
    /** Lost GPS as text/icon ink on raised surfaces (until the chip lands in PR 5). */
    gpsLostInk: string;
  };
  data: {
    route: string;
    routeCasing: string;
    /** Ascent/descent series: granite, never red. */
    ascent: string;
    descent: string;
    /** Heading needles and bearing marks. */
    heading: string;
    /** Satellite/info accent. */
    info: string;
  };
  /** The Library (After-Library.html, After-Empty.html). */
  library: {
    /** Route thumbnail: ground, inner hairline, decorative contours, start dot. */
    thumb: string;
    thumbEdge: string;
    thumbContour: string;
    thumbStart: string;
    /** Halo under the thumbnail route (the route's casing on paper). */
    thumbCasing: string;
    /** Activity badge fill (decision 7: paper; ring + glyph take the category colour). */
    badge: string;
    /** Map-row placeholder: ground, sheet, sheet edge, contour and water marks. */
    mapThumb: string;
    mapSheet: string;
    mapSheetEdge: string;
    mapContour: string;
    mapWater: string;
    /** Type chips: selected (stone) and idle (surface + hairline). */
    chipOn: string;
    chipOnInk: string;
    chipOnCount: string;
    chip: string;
    chipBorder: string;
    chipInk: string;
    chipCount: string;
    /** The sage "On map" toggle chip. */
    onMap: string;
    onMapBorder: string;
    onMapInk: string;
    /** Contour-line texture behind the header and the empty state. */
    texture: string;
  };
}

export const lightScheme: SchemeTokens = {
  background: palette.paper,
  surface: palette.surface,
  surfaceVariant: '#E3DDD0',
  elevation: {
    level0: 'transparent',
    level1: '#F7F2E8',
    level2: '#F3EDE1',
    level3: '#EEE7D9',
    level4: '#ECE4D5',
    level5: '#E8E0CF',
  },
  ink: palette.ink,
  inkVariant: palette.stone,
  inkMuted: palette.muted,
  outline: palette.granite,
  outlineVariant: palette.outlineVariant,
  divider: '#E3DCCB',
  map: {
    chrome: 'rgba(45,55,64,0.92)',
    chromeInk: palette.paper,
    followInk: '#8CC4F0',
    // The board's 70 % leans on a blur(14) backdrop; without blur, 70 % over
    // a white map is 4.1:1 for the paper ink. 78 % clears text contrast alone.
    chromeMini: 'rgba(45,55,64,0.78)',
    chromeActive: palette.stone,
    chromeDivider: 'rgba(242,236,224,0.22)',
    compassNorth: '#FF6B5E',
    compassSouth: palette.paper,
    chip: 'rgba(251,248,242,0.86)',
    chipInk: palette.stone,
    chipInkMuted: palette.muted,
    puck: palette.puck,
    puckRing: palette.paper,
    puckHalo: 'rgba(47,127,193,0.18)',
  },
  status: {
    recording: palette.stone,
    recordingDot: '#FF5A4E',
    paused: palette.amber,
    onPaused: palette.white,
    // Amber as text/icon ink on raised surfaces (the HUD sits on level 4,
    // where #B45309 is 4.0:1); the board's paused-footer ink.
    pausedInk: '#8F4206',
    gpsWeak: '#8F4206',
    gpsLost: palette.signalRed,
    onGpsLost: palette.white,
    gpsLostInk: '#B02222',
  },
  data: {
    route: palette.route,
    routeCasing: palette.routeCasing,
    ascent: palette.graniteDeep,
    descent: palette.granite,
    heading: palette.puck,
    info: palette.puck,
  },
  library: {
    thumb: '#F7F2E8',
    thumbEdge: '#E3DCCB',
    thumbContour: '#DDD5C4',
    thumbStart: palette.stone,
    thumbCasing: palette.routeCasing,
    badge: palette.surface,
    mapThumb: '#E9E3D5',
    mapSheet: palette.surface,
    mapSheetEdge: '#8F8674',
    mapContour: '#B8946A',
    mapWater: '#A9CBE0',
    chipOn: palette.stone,
    chipOnInk: palette.paper,
    chipOnCount: '#D9D2C3',
    chip: palette.surface,
    chipBorder: palette.outlineVariant,
    chipInk: palette.stone,
    chipCount: palette.muted,
    onMap: '#E4E9CF',
    onMapBorder: palette.sage,
    onMapInk: '#3D4D22',
    texture: 'rgba(45,55,64,0.07)',
  },
};

/** Stone night: the dark scheme. */
export const darkScheme: SchemeTokens = {
  background: '#13171B',
  surface: '#1A1F24',
  surfaceVariant: '#242B32',
  elevation: {
    level0: 'transparent',
    level1: '#1F252B',
    level2: '#242B32',
    level3: '#29313A',
    level4: '#2B343D',
    level5: '#2F3842',
  },
  ink: '#E9E4D8',
  inkVariant: '#A7B0B8',
  inkMuted: '#A7B0B8',
  // The board's #3E4852 is a divider (1.8:1 on surface); control borders need
  // 3:1, so outline is lifted and #3E4852 serves as outlineVariant.
  outline: '#77828E',
  outlineVariant: '#3E4852',
  divider: '#2F3842',
  map: {
    // After-Map-Dark.html: level2 at 94 %, not stone (stone on #13171B is 1.5:1).
    chrome: 'rgba(36,43,50,0.94)',
    chromeInk: '#E9E4D8',
    followInk: '#8CC4F0',
    chromeMini: 'rgba(36,43,50,0.78)',
    chromeActive: '#13171B',
    chromeDivider: 'rgba(233,228,216,0.18)',
    compassNorth: '#FF6B5E',
    compassSouth: '#E9E4D8',
    chip: 'rgba(26,31,36,0.86)',
    chipInk: '#E9E4D8',
    chipInkMuted: '#A7B0B8',
    puck: palette.puck,
    puckRing: palette.paper,
    puckHalo: 'rgba(47,127,193,0.22)',
  },
  status: {
    recording: palette.stone,
    recordingDot: '#FF6B5E',
    paused: palette.amber,
    onPaused: palette.white,
    // Amber lifted for dark surfaces (#B45309 is ~3:1 there).
    pausedInk: '#E89A4A',
    gpsWeak: '#E89A4A',
    gpsLost: '#FF6B5E',
    onGpsLost: palette.black,
    gpsLostInk: '#FF8A80',
  },
  data: {
    route: palette.route,
    routeCasing: palette.routeCasing,
    ascent: '#A7B0B8',
    descent: palette.granite,
    heading: '#8CC4F0',
    info: '#8CC4F0',
  },
  library: {
    // Stone night keeps the thumbnail dark: a paper tile per row would glare.
    thumb: '#1F252B',
    thumbEdge: '#2F3842',
    thumbContour: '#343E48',
    thumbStart: '#E9E4D8',
    // A dark halo instead of the brown casing (invisible on stone night).
    thumbCasing: '#13171B',
    badge: '#1A1F24',
    mapThumb: '#242B32',
    mapSheet: '#2F3842',
    mapSheetEdge: '#8A949E',
    mapContour: '#9C7F5C',
    mapWater: '#3C5F78',
    chipOn: '#E9E4D8',
    chipOnInk: '#13171B',
    chipOnCount: palette.muted,
    chip: '#1A1F24',
    chipBorder: '#3E4852',
    chipInk: '#E9E4D8',
    chipCount: '#A7B0B8',
    onMap: '#2E3A1F',
    onMapBorder: palette.sage,
    onMapInk: '#D6DEB8',
    texture: 'rgba(233,228,216,0.06)',
  },
};

export function schemeTokens(dark: boolean): SchemeTokens {
  return dark ? darkScheme : lightScheme;
}

/** Spacing steps (dp). */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Corner radii (dp). */
export const radius = { sm: 8, md: 12, lg: 16, pill: 28 } as const;

/**
 * Type scale. Nothing below 12. `label` is set in caps with 0.08 em tracking
 * (≈ 1 dp at 13). Font families come from `fonts.ts`.
 */
export const type = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: '700' },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 1 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
} as const;

/** Minimum type size anywhere in the app. */
export const MIN_FONT_SIZE = 12;

/** Touch targets (dp): 48 minimum; a 36 dp visual gets a 6 dp hitSlop. */
export const target = { min: 48, compact: 36, compactHitSlop: 6, record: 56 } as const;
