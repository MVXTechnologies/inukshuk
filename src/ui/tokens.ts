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
  /** Connected sources (Settings › Connections, the Import sheet and cards — #432/#435). */
  connect: {
    /** Strava's brand tile, and the glyph on it. */
    brand: string;
    onBrand: string;
    /** The small "Strava" / "Apple Health" source mark on imported rows. */
    mark: string;
    markBorder: string;
    /** The rate-limit pause notice on the progress card. */
    notice: string;
    noticeInk: string;
    /** Import progress bar: fill and track. */
    progress: string;
    progressTrack: string;
  };
  /** The map explorer (#447, boards `Main/MapView/Detail/Collection.dc.html`). */
  explore: {
    /** "By terrain" tile grounds, and the ink on them. */
    terrain: {
      mountains: string;
      water: string;
      glacier: string;
      coast: string;
      forest: string;
    };
    terrainInk: string;
    /** The link-out collection's badge (Parcs Québec) and its glyph. */
    collectionBadge: string;
    collectionBadgeInk: string;
    /** Publisher badges, picked per source id, and their initials. */
    sourceBadges: readonly [string, string, string, string];
    sourceBadgeInk: string;
    /** Explorer accent: activity glyphs and text links ("See on map"). */
    accent: string;
    /** Drawn map placeholder: ground and three contour inks. */
    placeholder: string;
    placeholderContours: readonly [string, string, string];
    /** Explorer map: clusters (fill, ring, count), single points, the selected footprint. */
    cluster: string;
    clusterRing: string;
    clusterInk: string;
    point: string;
    footprint: string;
    /**
     * Long-distance trails (#467, boards `Main/List/Detail/OnMap.dc.html`):
     * the trail line, its halo, the selected stage, the numbered stage disc
     * and its figure, and the drawn thumbnail's ground and contours.
     */
    trail: string;
    trailHalo: string;
    trailStage: string;
    trailBadge: string;
    trailBadgeInk: string;
    trailThumb: string;
    trailThumbContour: string;
  };
  /** Support Inukshuk (#476, boards `Main/Thanks/Entry.dc.html`). */
  support: {
    /** The Settings entry card and the Tip button, and the ink on them. */
    accent: string;
    onAccent: string;
    /** Tier icons and the "full accounts" link. */
    link: string;
    /** The chosen tip tier: its ground and its border. */
    selected: string;
    selectedBorder: string;
    /** The year's progress bar: fill and track. */
    progress: string;
    progressTrack: string;
    /** The thank-you inukshuk: light and dark stones. */
    stone: string;
    stoneDeep: string;
    /** Tip button pieces (TipButton.dc.html): the cairn's pale stones, the coin, the heart. */
    cairnLight: string;
    cairnMid: string;
    coin: string;
    heart: string;
  };
  /** Logbook statistics (Statistics, Personal records, Year in review). */
  stats: {
    /** The week-streak flame and its count (warm orange). */
    flame: string;
    /** Chart bars, and the current period's darker bar. */
    bar: string;
    barCurrent: string;
    /** Heart-rate zones Z1 … Z5, cool to hot. */
    zones: readonly [string, string, string, string, string];
    /** Year-in-review heatmap: an empty day, then the four shades. */
    dayEmpty: string;
    /** Hairline around an empty day, so the grid reads on a dark card (≥ 3:1 there). */
    dayEmptyOutline: string;
    dayShades: readonly [string, string, string, string];
    /** The "NEW" record badge and its ink. */
    newBadge: string;
    onNewBadge: string;
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
  connect: {
    brand: '#FC4C02',
    onBrand: palette.white,
    mark: '#B03A00',
    markBorder: '#F0B79A',
    notice: '#F7EDDC',
    noticeInk: '#5A2E06',
    progress: palette.sageDeep,
    progressTrack: '#E3DCCB',
  },
  explore: {
    terrain: {
      mountains: palette.sageDeep,
      water: '#2E6E94',
      glacier: '#4A6875',
      coast: '#7A5C32',
      forest: '#3F5025',
    },
    terrainInk: palette.surface,
    collectionBadge: '#3F5025',
    collectionBadgeInk: palette.sagePill,
    sourceBadges: [palette.stone, '#3F5025', '#9B2C2C', '#8F4206'],
    sourceBadgeInk: palette.surface,
    accent: palette.sageDeep,
    placeholder: '#E9E2D2',
    placeholderContours: [palette.ochre, palette.sageDeep, palette.river],
    cluster: palette.sageDeep,
    clusterRing: palette.surface,
    clusterInk: palette.surface,
    point: palette.sageDeep,
    footprint: palette.sageDeep,
    trail: '#C2410C',
    trailHalo: palette.surface,
    trailStage: '#7C2D12',
    trailBadge: '#C2410C',
    trailBadgeInk: palette.surface,
    trailThumb: '#E8E4D6',
    trailThumbContour: '#C9C0A8',
  },
  support: {
    accent: palette.sageDeep,
    onAccent: palette.surface,
    link: '#3F5025',
    selected: '#EEF1E4',
    selectedBorder: palette.sageDeep,
    progress: palette.sageDeep,
    progressTrack: '#E2DBCB',
    stone: '#3B444D',
    stoneDeep: '#2D353D',
    cairnLight: '#C9CFC2',
    cairnMid: '#AEB6AA',
    coin: '#E0B94E',
    heart: '#C2410C',
  },
  stats: {
    flame: '#C2410C',
    bar: palette.sage,
    barCurrent: palette.sageDeep,
    zones: ['#8D9AA6', '#5C93B7', '#6F8F3F', '#C98A2B', '#C2410C'],
    dayEmpty: '#E8E1D2',
    dayEmptyOutline: '#D5CEBF',
    dayShades: ['#D6DEB8', '#B1C181', '#849E4E', '#566B33'],
    newBadge: '#C2410C',
    onNewBadge: palette.white,
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
  connect: {
    brand: '#FC4C02',
    onBrand: palette.white,
    mark: '#FFB08A',
    markBorder: '#7A3A1C',
    notice: '#33261A',
    noticeInk: '#F2C79A',
    progress: '#B9C98A',
    progressTrack: '#2F3842',
  },
  explore: {
    terrain: {
      mountains: '#3F5025',
      water: '#1F4E6B',
      glacier: '#34505C',
      coast: '#5E4526',
      forest: '#2E3A1F',
    },
    terrainInk: '#E9E4D8',
    collectionBadge: '#2E3A1F',
    collectionBadgeInk: palette.sagePill,
    sourceBadges: ['#3E4852', '#2E3A1F', '#6E2020', '#6B3A10'],
    sourceBadgeInk: '#E9E4D8',
    accent: '#B9C98A',
    placeholder: '#242B32',
    placeholderContours: ['#9C7F5C', '#8A9A5B', '#3C5F78'],
    cluster: '#4A5E2B',
    clusterRing: '#E9E4D8',
    clusterInk: '#F2ECE0',
    point: '#B9C98A',
    footprint: '#B9C98A',
    trail: '#D4521A',
    // Dark ground: the selected stage lifts to a lighter orange, not a darker one.
    trailHalo: '#13171B',
    trailStage: '#F4A26B',
    trailBadge: '#C2410C',
    trailBadgeInk: '#FBF8F2',
    trailThumb: '#1B2127',
    trailThumbContour: '#39424B',
  },
  support: {
    // The board's #6F8A45 fill is only ~3.5:1 under paper ink; one step
    // deeper (the explorer's cluster green) carries the button label at AA.
    accent: '#4A5E2B',
    onAccent: '#F2ECE0',
    link: '#A9C07A',
    selected: '#26301F',
    selectedBorder: '#A9C07A',
    progress: '#A9C07A',
    progressTrack: '#2F3842',
    // The light board's charcoal stones vanish on stone night: lift them.
    stone: '#A7B0B8',
    stoneDeep: '#77828E',
    cairnLight: '#C9CFC2',
    cairnMid: '#AEB6AA',
    coin: '#E0B94E',
    heart: '#F07A45',
  },
  stats: {
    flame: '#F07A45',
    bar: '#6F7F4A',
    barCurrent: '#B6C98A',
    zones: ['#8E9AA5', '#6FA7CC', '#93B35E', '#D9A24A', '#F07A45'],
    dayEmpty: '#262D33',
    dayEmptyOutline: '#66727D',
    dayShades: ['#4E5F33', '#6C8242', '#93AD60', '#C1D396'],
    newBadge: '#F07A45',
    onNewBadge: '#13171B',
  },
};

/**
 * Sunlight (decision 4, `After-Sunlight.html`): opt-in maximum contrast for
 * bright sun — white surfaces, black ink and outlines, blue kept for "you".
 */
export const sunlightScheme: SchemeTokens = {
  background: palette.white,
  surface: palette.white,
  surfaceVariant: '#F2F2F2',
  elevation: {
    level0: 'transparent',
    level1: palette.white,
    level2: palette.white,
    level3: '#F5F5F5',
    level4: '#F2F2F2',
    level5: '#EEEEEE',
  },
  ink: palette.black,
  inkVariant: palette.black,
  inkMuted: '#333333',
  outline: palette.black,
  outlineVariant: palette.black,
  divider: '#555555',
  map: {
    chrome: palette.white,
    chromeMini: palette.white,
    chromeInk: palette.black,
    followInk: '#1565C0',
    chromeActive: palette.black,
    chromeDivider: palette.black,
    compassNorth: palette.signalRed,
    compassSouth: palette.black,
    chip: palette.white,
    chipInk: palette.black,
    chipInkMuted: palette.black,
    puck: '#1565C0',
    puckRing: palette.white,
    puckHalo: 'rgba(21,101,192,0.2)',
  },
  status: {
    recording: palette.black,
    recordingDot: '#FF3B30',
    paused: palette.amber,
    onPaused: palette.white,
    pausedInk: '#8F4206',
    gpsWeak: '#8F4206',
    gpsLost: palette.signalRed,
    onGpsLost: palette.white,
    gpsLostInk: '#B02222',
  },
  data: {
    route: palette.route,
    routeCasing: palette.black,
    ascent: palette.black,
    descent: '#555555',
    heading: '#1565C0',
    info: '#1565C0',
  },
  library: {
    thumb: palette.white,
    thumbEdge: palette.black,
    thumbContour: '#D0D0D0',
    thumbStart: palette.black,
    thumbCasing: palette.black,
    badge: palette.white,
    mapThumb: '#F2F2F2',
    mapSheet: palette.white,
    mapSheetEdge: palette.black,
    mapContour: '#8F6B3E',
    mapWater: '#6FA3C8',
    chipOn: palette.black,
    chipOnInk: palette.white,
    chipOnCount: '#D0D0D0',
    chip: palette.white,
    chipBorder: palette.black,
    chipInk: palette.black,
    chipCount: '#333333',
    onMap: palette.white,
    onMapBorder: palette.black,
    onMapInk: palette.black,
    texture: 'rgba(0,0,0,0.05)',
  },
  connect: {
    brand: '#FC4C02',
    onBrand: palette.white,
    mark: palette.black,
    markBorder: palette.black,
    notice: '#F2F2F2',
    noticeInk: palette.black,
    progress: palette.black,
    progressTrack: '#DDDDDD',
  },
  explore: {
    terrain: {
      mountains: palette.black,
      water: palette.black,
      glacier: palette.black,
      coast: palette.black,
      forest: palette.black,
    },
    terrainInk: palette.white,
    collectionBadge: palette.black,
    collectionBadgeInk: palette.white,
    sourceBadges: [palette.black, palette.black, palette.black, palette.black],
    sourceBadgeInk: palette.white,
    accent: palette.black,
    placeholder: '#F2F2F2',
    placeholderContours: ['#8F6B3E', '#555555', '#6FA3C8'],
    cluster: palette.black,
    clusterRing: palette.white,
    clusterInk: palette.white,
    point: palette.black,
    footprint: palette.black,
    trail: '#C2410C',
    trailHalo: palette.white,
    trailStage: '#5A1E0B',
    trailBadge: '#A8380A',
    trailBadgeInk: palette.white,
    trailThumb: '#F2F2F2',
    trailThumbContour: '#D0D0D0',
  },
  support: {
    accent: palette.black,
    onAccent: palette.white,
    link: palette.black,
    selected: '#F2F2F2',
    selectedBorder: palette.black,
    progress: palette.black,
    progressTrack: '#DDDDDD',
    stone: '#333333',
    stoneDeep: palette.black,
    cairnLight: '#EEEEEE',
    cairnMid: '#CCCCCC',
    coin: '#E0B94E',
    heart: '#B02222',
  },
  stats: {
    flame: '#B02222',
    bar: '#777777',
    barCurrent: palette.black,
    zones: ['#BBBBBB', '#888888', '#555555', '#333333', palette.black],
    dayEmpty: '#EEEEEE',
    dayEmptyOutline: '#777777',
    dayShades: ['#BBBBBB', '#888888', '#555555', palette.black],
    newBadge: palette.black,
    onNewBadge: palette.white,
  },
};

/** Night red's ink: the one red that reads on black (5.9:1). */
const NIGHT_INK = '#FF3B30';

/**
 * Night red (decision 4, `After-Night.html`): opt-in, red on black, no blue
 * or green anywhere, to keep night vision. The board's muted #7A1C17 is only
 * 2:1 on black, so text stays in the ink red (hierarchy by size and weight)
 * and #7A1C17 / #3A0B08 serve as hairlines and raised surfaces.
 */
export const nightScheme: SchemeTokens = {
  background: palette.black,
  surface: '#1A0000',
  surfaceVariant: '#2A0503',
  elevation: {
    level0: 'transparent',
    level1: '#1A0000',
    level2: '#220301',
    level3: '#2A0503',
    level4: '#320805',
    level5: '#3A0B08',
  },
  ink: NIGHT_INK,
  inkVariant: NIGHT_INK,
  inkMuted: NIGHT_INK,
  outline: '#CC2E24',
  outlineVariant: '#7A1C17',
  divider: '#3A0B08',
  map: {
    chrome: 'rgba(0,0,0,0.94)',
    chromeMini: 'rgba(0,0,0,0.94)',
    chromeInk: NIGHT_INK,
    followInk: NIGHT_INK,
    chromeActive: '#3A0B08',
    chromeDivider: 'rgba(255,59,48,0.25)',
    compassNorth: NIGHT_INK,
    compassSouth: '#D13A30',
    chip: 'rgba(0,0,0,0.94)',
    chipInk: NIGHT_INK,
    chipInkMuted: NIGHT_INK,
    puck: NIGHT_INK,
    puckRing: palette.black,
    puckHalo: 'rgba(255,59,48,0.2)',
  },
  status: {
    recording: '#3A0B08',
    recordingDot: NIGHT_INK,
    paused: NIGHT_INK,
    onPaused: palette.black,
    pausedInk: NIGHT_INK,
    gpsWeak: NIGHT_INK,
    gpsLost: NIGHT_INK,
    onGpsLost: palette.black,
    gpsLostInk: NIGHT_INK,
  },
  data: {
    route: NIGHT_INK,
    routeCasing: palette.black,
    ascent: NIGHT_INK,
    descent: '#CC2E24',
    heading: NIGHT_INK,
    info: NIGHT_INK,
  },
  library: {
    thumb: '#1A0000',
    thumbEdge: '#3A0B08',
    thumbContour: '#2A0503',
    thumbStart: NIGHT_INK,
    thumbCasing: palette.black,
    badge: palette.black,
    mapThumb: '#1A0000',
    mapSheet: '#2A0503',
    mapSheetEdge: '#CC2E24',
    mapContour: '#7A1C17',
    mapWater: '#3A0B08',
    chipOn: NIGHT_INK,
    chipOnInk: palette.black,
    chipOnCount: palette.black,
    chip: palette.black,
    chipBorder: '#7A1C17',
    chipInk: NIGHT_INK,
    chipCount: NIGHT_INK,
    onMap: '#3A0B08',
    onMapBorder: NIGHT_INK,
    onMapInk: NIGHT_INK,
    texture: 'rgba(255,59,48,0.06)',
  },
  connect: {
    brand: '#3A0B08',
    onBrand: NIGHT_INK,
    mark: NIGHT_INK,
    markBorder: '#7A1C17',
    notice: '#2A0503',
    noticeInk: NIGHT_INK,
    progress: NIGHT_INK,
    progressTrack: '#3A0B08',
  },
  explore: {
    terrain: {
      mountains: '#2A0503',
      water: '#2A0503',
      glacier: '#2A0503',
      coast: '#2A0503',
      forest: '#2A0503',
    },
    terrainInk: NIGHT_INK,
    collectionBadge: '#3A0B08',
    collectionBadgeInk: NIGHT_INK,
    sourceBadges: ['#2A0503', '#2A0503', '#2A0503', '#2A0503'],
    sourceBadgeInk: NIGHT_INK,
    accent: NIGHT_INK,
    placeholder: '#1A0000',
    placeholderContours: ['#7A1C17', '#7A1C17', '#7A1C17'],
    cluster: '#3A0B08',
    clusterRing: NIGHT_INK,
    clusterInk: NIGHT_INK,
    point: NIGHT_INK,
    footprint: NIGHT_INK,
    trail: NIGHT_INK,
    trailHalo: palette.black,
    trailStage: '#FF8A80',
    trailBadge: '#3A0B08',
    trailBadgeInk: NIGHT_INK,
    trailThumb: '#1A0000',
    trailThumbContour: '#7A1C17',
  },
  support: {
    accent: '#3A0B08',
    onAccent: NIGHT_INK,
    link: NIGHT_INK,
    selected: '#2A0503',
    selectedBorder: NIGHT_INK,
    progress: NIGHT_INK,
    progressTrack: '#3A0B08',
    stone: NIGHT_INK,
    stoneDeep: '#CC2E24',
    cairnLight: NIGHT_INK,
    cairnMid: '#CC2E24',
    coin: NIGHT_INK,
    heart: NIGHT_INK,
  },
  stats: {
    flame: '#FF5C5C',
    bar: '#7A2626',
    barCurrent: '#FF5C5C',
    zones: ['#4A1A1A', '#6E2323', '#9A2E2E', '#C83A3A', '#FF5C5C'],
    dayEmpty: '#1F0E0E',
    dayEmptyOutline: '#C83A3A',
    dayShades: ['#4A1A1A', '#7A2626', '#B03434', '#FF5C5C'],
    newBadge: '#FF5C5C',
    onNewBadge: palette.black,
  },
};

/** Night red's map treatment: greyscale, dimmed raster under a red veil. */
export const NIGHT_MAP = {
  rasterSaturation: -1,
  rasterBrightnessMax: 0.35,
  veil: 'rgba(120,0,0,0.35)',
} as const;

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
