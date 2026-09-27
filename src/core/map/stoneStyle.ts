/**
 * "Stone & Paper" vector base map — MapLibre style layers for the
 * OpenMapTiles vector schema (the schema OpenFreeMap serves; see
 * `docs/design/vector-basemap.md` for the source decision).
 *
 * The look is the approved topo board (`docs/design/ui-revamp/boards/
 * Main.html` and its `blobs/*.svg` illustration, dark twin in
 * `After-Map-Dark.html`): warm paper land, woods as a quiet sage wash,
 * lakes as a pale river tint with a river-blue shore stroke, roads as white
 * ribbons in a stone casing, and — because this is a trail app — footpaths
 * and tracks drawn as clear dashed granite lines rather than the near-
 * invisible hairlines of a street map.
 *
 * PURE: every colour comes from the {@link StoneBasemapScheme} the caller
 * passes in. `src/core` may not import `@ui/*`, so the mapping from the app's
 * `SchemeTokens` lives in `src/features/map/stoneScheme.ts`; this module only
 * decides WHERE each colour goes, at what width, opacity and zoom. Colours
 * are always plain strings — never expressions, never computed here — so a
 * test can prove the palette is closed (`stoneStyle.test.ts`).
 *
 * The only import is a type-only one of the style-spec types (erased at
 * runtime), so the output is type-checked against the real MapLibre spec.
 */
import type { LayerSpecification, LineLayerSpecification } from '@maplibre/maplibre-react-native';

/**
 * The style-spec expression type. Not re-exported by the RN package, so it is
 * recovered from a data-driven paint property: the only array members of
 * that union are the expressions.
 */
type ExpressionSpecification = Extract<
  NonNullable<NonNullable<LineLayerSpecification['paint']>['line-width']>,
  unknown[]
>;

/** The colours the base map draws with, all plain CSS colour strings. */
export interface StoneBasemapScheme {
  /** Dark (stone-night) variant: opacities and road polarity flip. */
  dark: boolean;
  /** Land / background — the paper. */
  land: string;
  /** Built-up and bare ground (residential, rock, sand) — a step off the paper. */
  landAlt: string;
  /** Woods, grass, parks, wetland — washed at low opacity. */
  vegetation: string;
  /** Lake/ocean fill (washed) and river/stream lines. */
  water: string;
  /** Shoreline stroke and waterway lines. */
  waterLine: string;
  /** Water-body and river labels (italic). */
  waterInk: string;
  /** Road ribbon. */
  roadFill: string;
  /** Road casing (the outline either side of the ribbon). */
  roadCasing: string;
  /** Footpaths and tracks — the trail colour. */
  path: string;
  /** Railways, boundaries and other secondary line work. */
  lineMuted: string;
  /** Building footprints. */
  building: string;
  /** Contour lines (only drawn when a contour source is configured). */
  contour: string;
  /** Place names and peaks. */
  ink: string;
  /** Road names, POIs, provinces. */
  inkMuted: string;
  /** Text halo — should match `land`. */
  halo: string;
}

/** MapLibre font stacks per weight. Each stack is one glyph request. */
export interface StoneFonts {
  regular: string[];
  bold: string[];
  italic: string[];
}

/**
 * The design face. A MapLibre glyph server must hold these as SDF PBF
 * ranges (see the decision note) — none of the public hosts do today.
 */
export const STONE_FONTS_ATKINSON: StoneFonts = {
  regular: ['Atkinson Hyperlegible Next Regular'],
  bold: ['Atkinson Hyperlegible Next Bold'],
  italic: ['Atkinson Hyperlegible Next Italic'],
};

/**
 * The glyph fallback: Noto Sans, which OpenFreeMap's glyph endpoint serves.
 * Stacks are NOT merged with the Atkinson ones: MapLibre requests a whole
 * stack as ONE comma-joined URL, which a static glyph host can't answer, so
 * the fallback is a whole-stack swap made together with the glyphs URL.
 */
export const STONE_FONTS_NOTO: StoneFonts = {
  regular: ['Noto Sans Regular'],
  bold: ['Noto Sans Bold'],
  italic: ['Noto Sans Italic'],
};

/** Label language: French or English name when tagged, local name otherwise. */
export type StoneLabelLanguage = 'fr' | 'en' | 'local';

/**
 * An optional contour-line source (OpenMapTiles carries none). `field` is the
 * numeric elevation attribute in metres; every `majorEvery`-th line on a
 * `intervalM` grid is drawn bold.
 */
export interface StoneContourSource {
  source: string;
  sourceLayer: string;
  field: string;
  intervalM: number;
  majorEvery: number;
}

export interface StoneStyleOptions {
  /** Id of the OpenMapTiles vector source in the style. */
  source: string;
  fonts?: StoneFonts;
  language?: StoneLabelLanguage;
  contours?: StoneContourSource;
}

/**
 * Layers split so a caller can slot other things (hillshade, drapes) between
 * the map body and its labels: `base` draws under, `labels` over.
 */
export interface StoneLayers {
  base: LayerSpecification[];
  labels: LayerSpecification[];
}

/** Id prefix on every layer, so the stone layers are easy to find/replace. */
export const STONE_LAYER_PREFIX = 'stone-';

type Width = ExpressionSpecification;

/** Exponential zoom ramp through [zoom, value] stops. */
function ramp(...stops: [number, number][]): Width {
  return ['interpolate', ['exponential', 1.4], ['zoom'], ...stops.flat()] as Width;
}

/** `['in', ['get', key], ['literal', values]]`. */
function isIn(key: string, values: readonly string[]): ExpressionSpecification {
  return ['in', ['get', key], ['literal', [...values]]];
}

/** Rivers and canals draw wider than streams, drains and ditches. */
function byWaterwayClass(river: number, stream: number): ExpressionSpecification {
  return ['match', ['get', 'class'], ['river', 'canal'], river, stream];
}

function nameField(language: StoneLabelLanguage): ExpressionSpecification {
  switch (language) {
    case 'fr':
      return ['coalesce', ['get', 'name:fr'], ['get', 'name:latin'], ['get', 'name']];
    case 'en':
      return [
        'coalesce',
        ['get', 'name:en'],
        ['get', 'name_en'],
        ['get', 'name:latin'],
        ['get', 'name'],
      ];
    default:
      return ['coalesce', ['get', 'name:latin'], ['get', 'name']];
  }
}

/** Road classes, widest first, with their ribbon width ramp. */
const ROADS: { id: string; classes: string[]; minzoom: number; width: Width }[] = [
  {
    id: 'minor',
    classes: ['minor', 'service'],
    minzoom: 12,
    width: ramp([12, 0.5], [14, 2], [16, 5], [18, 12]),
  },
  {
    id: 'secondary',
    classes: ['secondary', 'tertiary'],
    minzoom: 8,
    width: ramp([8, 0.6], [12, 1.8], [14, 3.6], [16, 7], [18, 16]),
  },
  {
    id: 'primary',
    classes: ['primary', 'trunk'],
    minzoom: 6,
    width: ramp([6, 0.6], [10, 1.6], [14, 4.2], [16, 8], [18, 18]),
  },
  {
    id: 'motorway',
    classes: ['motorway'],
    minzoom: 5,
    width: ramp([5, 0.6], [10, 2], [14, 5], [16, 9], [18, 20]),
  },
];

/** Casing allowance each side of the ribbon, by zoom. */
const CASING_ADD = ramp([8, 0.6], [14, 1.4], [18, 3]);

const POI_CLASSES = [
  'campsite',
  'shelter',
  'information',
  'drinking_water',
  'attraction',
  'toilets',
];

/**
 * Stone & Paper layers for an OpenMapTiles vector source. Light or stone-
 * night follows `scheme` (see {@link StoneBasemapScheme.dark}).
 */
export function buildStoneLayers(
  scheme: StoneBasemapScheme,
  options: StoneStyleOptions,
): StoneLayers {
  const { source } = options;
  const fonts = options.fonts ?? STONE_FONTS_ATKINSON;
  const name = nameField(options.language ?? 'local');
  const dark = scheme.dark;
  const id = (s: string) => `${STONE_LAYER_PREFIX}${s}`;
  // The board washes woods at 30 % over paper (28 % on stone night) and
  // water at roughly 45 % (a deeper 30 % on night, where a pale fill glares).
  const vegOpacity = dark ? 0.28 : 0.3;
  const waterOpacity = dark ? 0.3 : 0.45;
  const halo = { 'text-halo-color': scheme.halo, 'text-halo-width': 1.4, 'text-halo-blur': 0.3 };
  const notTunnel: ExpressionSpecification = ['!=', ['get', 'brunnel'], 'tunnel'];

  const base: LayerSpecification[] = [
    { id: id('background'), type: 'background', paint: { 'background-color': scheme.land } },
    {
      id: id('landuse-built'),
      type: 'fill',
      source,
      'source-layer': 'landuse',
      minzoom: 10,
      filter: isIn('class', ['residential', 'commercial', 'industrial', 'retail', 'suburb']),
      paint: { 'fill-color': scheme.landAlt, 'fill-opacity': dark ? 0.5 : 0.6 },
    },
    {
      id: id('landcover-bare'),
      type: 'fill',
      source,
      'source-layer': 'landcover',
      filter: isIn('class', ['rock', 'sand']),
      paint: { 'fill-color': scheme.landAlt, 'fill-opacity': 0.7 },
    },
    {
      id: id('landcover-ice'),
      type: 'fill',
      source,
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'ice'],
      paint: { 'fill-color': scheme.water, 'fill-opacity': 0.12 },
    },
    {
      id: id('landcover-grass'),
      type: 'fill',
      source,
      'source-layer': 'landcover',
      filter: isIn('class', ['grass', 'wetland']),
      paint: { 'fill-color': scheme.vegetation, 'fill-opacity': vegOpacity * 0.5 },
    },
    {
      id: id('landcover-wood'),
      type: 'fill',
      source,
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'wood'],
      paint: { 'fill-color': scheme.vegetation, 'fill-opacity': vegOpacity },
    },
    {
      id: id('park'),
      type: 'fill',
      source,
      'source-layer': 'park',
      paint: { 'fill-color': scheme.vegetation, 'fill-opacity': vegOpacity * 0.35 },
    },
    {
      id: id('park-outline'),
      type: 'line',
      source,
      'source-layer': 'park',
      minzoom: 8,
      paint: {
        'line-color': scheme.vegetation,
        'line-opacity': 0.7,
        'line-width': ramp([8, 0.6], [14, 1.6]),
        'line-dasharray': [3, 2],
      },
    },
    {
      id: id('water'),
      type: 'fill',
      source,
      'source-layer': 'water',
      filter: notTunnel,
      paint: { 'fill-color': scheme.water, 'fill-opacity': waterOpacity },
    },
    {
      id: id('water-shore'),
      type: 'line',
      source,
      'source-layer': 'water',
      minzoom: 8,
      filter: notTunnel,
      paint: { 'line-color': scheme.waterLine, 'line-width': ramp([8, 0.5], [12, 1], [16, 1.6]) },
    },
    {
      id: id('waterway'),
      type: 'line',
      source,
      'source-layer': 'waterway',
      minzoom: 8,
      filter: notTunnel,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': scheme.waterLine,
        // One zoom curve (the spec allows a single zoom interpolate), the
        // class picked per stop: rivers/canals vs streams and ditches.
        'line-width': [
          'interpolate',
          ['exponential', 1.4],
          ['zoom'],
          8,
          byWaterwayClass(0.8, 0.2),
          12,
          byWaterwayClass(1.6, 0.8),
          16,
          byWaterwayClass(4, 2),
        ],
        // Intermittent streams step back (a dash would need a second layer).
        'line-opacity': ['match', ['get', 'intermittent'], 1, 0.6, 1],
      },
    },
  ];

  if (options.contours) {
    const c = options.contours;
    const isMajor: ExpressionSpecification = [
      '==',
      ['%', ['to-number', ['get', c.field], 0], c.intervalM * c.majorEvery],
      0,
    ];
    base.push(
      {
        id: id('contour-minor'),
        type: 'line',
        source: c.source,
        'source-layer': c.sourceLayer,
        minzoom: 12,
        filter: ['!', isMajor],
        paint: {
          'line-color': scheme.contour,
          'line-opacity': dark ? 0.5 : 0.55,
          'line-width': 0.7,
        },
      },
      {
        id: id('contour-major'),
        type: 'line',
        source: c.source,
        'source-layer': c.sourceLayer,
        minzoom: 10,
        filter: isMajor,
        paint: {
          'line-color': scheme.contour,
          'line-opacity': dark ? 0.7 : 0.75,
          'line-width': 1.25,
        },
      },
    );
  }

  base.push(
    {
      id: id('building'),
      type: 'fill',
      source,
      'source-layer': 'building',
      minzoom: 13,
      paint: { 'fill-color': scheme.building, 'fill-opacity': dark ? 0.6 : 0.5 },
    },
    {
      id: id('boundary'),
      type: 'line',
      source,
      'source-layer': 'boundary',
      filter: ['all', ['<=', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
      paint: {
        'line-color': scheme.lineMuted,
        'line-opacity': 0.7,
        'line-width': ramp([3, 0.6], [10, 1.2], [14, 1.8]),
        'line-dasharray': [4, 2, 1, 2],
      },
    },
    // Casings, widest class last so its casing draws over lesser roads' ribbons.
    ...ROADS.map((r): LayerSpecification => ({
      id: id(`road-${r.id}-casing`),
      type: 'line',
      source,
      'source-layer': 'transportation',
      minzoom: r.minzoom,
      filter: ['all', isIn('class', r.classes), notTunnel],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': scheme.roadCasing,
        'line-gap-width': r.width,
        'line-width': CASING_ADD,
      },
    })),
    ...ROADS.map((r): LayerSpecification => ({
      id: id(`road-${r.id}`),
      type: 'line',
      source,
      'source-layer': 'transportation',
      minzoom: r.minzoom,
      filter: ['all', isIn('class', r.classes), notTunnel],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': scheme.roadFill, 'line-width': r.width },
    })),
    {
      id: id('rail'),
      type: 'line',
      source,
      'source-layer': 'transportation',
      minzoom: 10,
      filter: isIn('class', ['rail', 'transit']),
      paint: {
        'line-color': scheme.lineMuted,
        'line-width': ramp([10, 0.6], [16, 1.6]),
        'line-dasharray': [3, 3],
      },
    },
    // The trail network — the point of the app. Tracks (forest/ATV roads) and
    // paths are both dashed in the trail colour; tracks longer-dashed and a
    // touch wider so the two read apart. Both are drawn from their first
    // zoom in the tiles and stay above the road ribbons they cross.
    {
      id: id('track'),
      type: 'line',
      source,
      'source-layer': 'transportation',
      minzoom: 11,
      filter: ['==', ['get', 'class'], 'track'],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': scheme.path,
        'line-opacity': 0.85,
        'line-width': ramp([11, 0.8], [14, 1.6], [18, 3.2]),
        'line-dasharray': [5, 2],
      },
    },
    {
      id: id('path'),
      type: 'line',
      source,
      'source-layer': 'transportation',
      minzoom: 11,
      filter: ['==', ['get', 'class'], 'path'],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': scheme.path,
        'line-width': ramp([11, 0.8], [14, 1.3], [18, 2.6]),
        // The board's 5 / 3.5 dash at a 1.3 stroke, in line-width units.
        'line-dasharray': [3.8, 2.7],
      },
    },
  );

  const labels: LayerSpecification[] = [
    {
      id: id('waterway-label'),
      type: 'symbol',
      source,
      'source-layer': 'waterway',
      minzoom: 12,
      filter: ['has', 'name'],
      layout: {
        'symbol-placement': 'line',
        'text-field': name,
        'text-font': fonts.italic,
        'text-size': 12,
        'text-letter-spacing': 0.05,
      },
      paint: { 'text-color': scheme.waterInk, ...halo },
    },
    {
      id: id('water-label'),
      type: 'symbol',
      source,
      'source-layer': 'water_name',
      filter: ['has', 'name'],
      layout: {
        'text-field': name,
        'text-font': fonts.italic,
        'text-size': ramp([8, 11], [14, 13.5]),
        'text-max-width': 7,
      },
      paint: { 'text-color': scheme.waterInk, ...halo },
    },
    {
      id: id('road-label'),
      type: 'symbol',
      source,
      'source-layer': 'transportation_name',
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'text-field': name,
        'text-font': fonts.regular,
        'text-size': ramp([13, 11], [17, 13]),
      },
      paint: { 'text-color': scheme.inkMuted, ...halo },
    },
    {
      id: id('poi'),
      type: 'symbol',
      source,
      'source-layer': 'poi',
      minzoom: 15,
      filter: ['all', isIn('class', POI_CLASSES), ['has', 'name']],
      layout: {
        'text-field': name,
        'text-font': fonts.regular,
        'text-size': 12,
        'text-max-width': 8,
      },
      paint: { 'text-color': scheme.inkMuted, ...halo },
    },
    {
      id: id('peak'),
      type: 'symbol',
      source,
      'source-layer': 'mountain_peak',
      minzoom: 11,
      filter: ['==', ['get', 'class'], 'peak'],
      layout: {
        'text-field': [
          'format',
          ['coalesce', name, ''],
          { 'text-font': ['literal', fonts.bold] },
          '\n',
          {},
          ['case', ['has', 'ele'], ['concat', ['to-string', ['get', 'ele']], ' m'], ''],
          { 'font-scale': 0.85 },
        ],
        'text-font': fonts.regular,
        'text-size': 12,
        'text-max-width': 8,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: { 'text-color': scheme.ink, ...halo },
    },
    {
      id: id('place-village'),
      type: 'symbol',
      source,
      'source-layer': 'place',
      minzoom: 11,
      filter: isIn('class', ['village', 'hamlet', 'suburb', 'neighbourhood', 'isolated_dwelling']),
      layout: {
        'text-field': name,
        'text-font': fonts.regular,
        'text-size': ramp([11, 11.5], [15, 14]),
        'text-max-width': 8,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: { 'text-color': scheme.ink, ...halo },
    },
    {
      id: id('place-town'),
      type: 'symbol',
      source,
      'source-layer': 'place',
      minzoom: 8,
      filter: ['==', ['get', 'class'], 'town'],
      layout: {
        'text-field': name,
        'text-font': fonts.regular,
        'text-size': ramp([8, 12], [14, 16]),
        'text-max-width': 8,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: { 'text-color': scheme.ink, ...halo },
    },
    {
      id: id('place-city'),
      type: 'symbol',
      source,
      'source-layer': 'place',
      minzoom: 4,
      filter: ['==', ['get', 'class'], 'city'],
      layout: {
        'text-field': name,
        'text-font': fonts.bold,
        'text-size': ramp([4, 11.5], [8, 13.5], [12, 18]),
        'text-max-width': 8,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: { 'text-color': scheme.ink, ...halo },
    },
    {
      id: id('place-province'),
      type: 'symbol',
      source,
      'source-layer': 'place',
      minzoom: 4,
      maxzoom: 8,
      filter: isIn('class', ['state', 'province']),
      layout: {
        'text-field': name,
        'text-font': fonts.bold,
        'text-size': 12,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 9,
      },
      paint: { 'text-color': scheme.inkMuted, ...halo },
    },
  ];

  return { base, labels };
}
