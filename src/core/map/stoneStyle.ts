/**
 * "Stone & Paper" vector base map — MapLibre style layers for the
 * Protomaps basemap schema v4 (`roads`, `water`, `landuse`, … with `kind` /
 * `kind_detail`), which our self-hosted PMTiles extract serves; see
 * `docs/design/vector-basemap.md` for the source decision.
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
import type {
  LayerSpecification,
  LineLayerSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-react-native';
import { DEFAULT_PEAK_DENSITY, PEAK_LEAD, type PeakDensity } from './terrainOptions';

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
 * An optional contour-line source (the basemap carries none). `field` is the
 * numeric elevation attribute in metres. Major lines come either from a
 * `levelField` the tiles carry (1 = major, as our Worker's contour tiles do,
 * whose interval already tightens with zoom) or, without one, from every
 * `majorEvery`-th line on an `intervalM` grid.
 */
export interface StoneContourSource {
  source: string;
  sourceLayer: string;
  field: string;
  levelField?: string;
  intervalM?: number;
  majorEvery?: number;
}

/**
 * Our worldwide named-summits tileset (`infra/tiles/nas/peaks.sh`): one point
 * per OSM natural=peak|volcano with a name, carrying `name` (+ `name:en` /
 * `name:fr`), `ele` (integer metres, when known), `kind` and `rank` — the
 * zoom its height earns on the elevation ladder (≥ 4000 m at z5 … unknown
 * height at z12). Tiles carry each summit `PEAK_MAX_LEAD` zooms before its
 * rank, and the style's filter picks how early to draw it (the peak-density
 * setting). Tiles built before `rank` existed carry each summit only from its
 * rank, and every feature of theirs is drawn as it arrives.
 * Protomaps only ships peaks from z13; without this source the map falls back
 * to those.
 */
export interface StonePeaksSource {
  source: string;
  sourceLayer: string;
}

export interface StoneStyleOptions {
  /** Id of the Protomaps vector source in the style. */
  source: string;
  fonts?: StoneFonts;
  language?: StoneLabelLanguage;
  contours?: StoneContourSource;
  peaks?: StonePeaksSource;
  /**
   * How early our summits appear (#461): each is drawn `PEAK_LEAD` zooms
   * before its elevation-ladder `rank`. Default {@link DEFAULT_PEAK_DENSITY}.
   */
  peakDensity?: PeakDensity;
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

const isLine: ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
const isPolygon: ExpressionSpecification = ['==', ['geometry-type'], 'Polygon'];
const isPoint: ExpressionSpecification = ['==', ['geometry-type'], 'Point'];
/** Protomaps flags tunnels as a boolean; tunnels are not drawn. */
const notTunnel: ExpressionSpecification = ['!', ['to-boolean', ['get', 'is_tunnel']]];
/** A feature is due once the map reaches its `min_zoom` (Protomaps' own ranking). */
const dueAtZoom: ExpressionSpecification = ['<=', ['coalesce', ['get', 'min_zoom'], 0], ['zoom']];
/**
 * Due `lead` zoom levels BEFORE its `min_zoom`. Protomaps ranks villages and
 * towns for a dense city basemap; on a trail map they are the landmarks you
 * navigate by, and the owner found them appearing too late (2026-09-28).
 * Collision + the sort key still keep the biggest places when space is short.
 */
function dueWithin(lead: number): ExpressionSpecification {
  return ['<=', ['-', ['coalesce', ['get', 'min_zoom'], 0], lead], ['zoom']];
}

/**
 * A summit from our peaks tiles is due `lead` zooms before its `rank`.
 * Features without a rank (tiles built before #461) are already tiled from
 * their rank, so they pass. Filters see the TILE's zoom — an integer, which
 * is why the leads are whole levels.
 */
export function peakDueFilter(lead: number): ExpressionSpecification {
  return [
    'any',
    ['!', ['has', 'rank']],
    ['>=', ['zoom'], ['-', ['to-number', ['get', 'rank'], 0], lead]],
  ];
}

/** Rivers and canals draw wider than streams, drains and ditches. */
function byWaterwayKind(river: number, stream: number): ExpressionSpecification {
  return ['match', ['get', 'kind'], ['river', 'canal'], river, stream];
}

function nameField(language: StoneLabelLanguage): ExpressionSpecification {
  switch (language) {
    case 'fr':
      return ['coalesce', ['get', 'name:fr'], ['get', 'name']];
    case 'en':
      return ['coalesce', ['get', 'name:en'], ['get', 'name']];
    default:
      return ['coalesce', ['get', 'name'], ''];
  }
}

/** A number 0–999 as three digits: 7 → "007". */
function pad3(n: ExpressionSpecification): ExpressionSpecification {
  return [
    'case',
    ['<', n, 10],
    ['concat', '00', ['to-string', n]],
    ['<', n, 100],
    ['concat', '0', ['to-string', n]],
    ['to-string', n],
  ];
}

/**
 * No-break space between a height and its unit. A plain space is a line-break
 * opportunity for MapLibre's label wrapping, which balances line widths over
 * the WHOLE label — so a long summit name could push the unit onto a line of
 * its own ("1 234" / "m", #461). U+00A0 is in both glyph fonts' 0–255 range.
 */
const NBSP = '\u00a0';

/**
 * A summit height in whole metres, thousands set off by a thin space the way
 * the topo sheets print them: "808 m", "1 234 m", "8 849 m"; empty when the
 * feature has none. Neither the thin space (U+2009) nor the no-break space
 * before the unit is a break opportunity, so the height never wraps. Built from plain arithmetic rather than `number-format`,
 * whose locale support differs between the native renderers.
 */
export function elevationLabel(field: string): ExpressionSpecification {
  const m: ExpressionSpecification = ['round', ['to-number', ['get', field], 0]];
  return [
    'case',
    ['!', ['has', field]],
    '',
    ['>=', m, 1000],
    [
      'concat',
      ['to-string', ['floor', ['/', m, 1000]]],
      '\u2009',
      pad3(['%', m, 1000]),
      `${NBSP}m`,
    ],
    ['concat', ['to-string', m], `${NBSP}m`],
  ];
}

/** Land-use kinds by how they are washed. */
const BUILT = [
  'residential',
  'commercial',
  'industrial',
  'retail',
  'military',
  'naval_base',
  'railway',
  'school',
  'college',
  'university',
  'hospital',
  'aerodrome',
  'airfield',
];
const BARE = ['beach', 'sand', 'bare_rock', 'scree', 'quarry', 'barren'];
const WOOD = ['wood', 'forest'];
const GREEN = [
  'grass',
  'grassland',
  'meadow',
  'scrub',
  'heath',
  'wetland',
  'marsh',
  'swamp',
  'orchard',
  'vineyard',
  'allotments',
  'village_green',
  'recreation_ground',
  'golf_course',
  'pitch',
  'playground',
  'garden',
  'cemetery',
];
const PARK = ['park', 'nature_reserve', 'national_park', 'protected_area'];

/**
 * Road ribbons, widest first, each with its width ramp. Protomaps groups
 * roads by `kind` and keeps the OSM class in `kind_detail`.
 */
const ROADS: { id: string; filter: ExpressionSpecification; minzoom: number; width: Width }[] = [
  {
    id: 'minor',
    filter: isIn('kind', ['minor_road', 'other']),
    minzoom: 12,
    width: ramp([12, 0.5], [14, 2], [16, 5], [18, 12]),
  },
  {
    id: 'secondary',
    filter: [
      'any',
      ['==', ['get', 'kind'], 'medium_road'],
      [
        'all',
        ['==', ['get', 'kind'], 'major_road'],
        isIn('kind_detail', ['secondary', 'secondary_link', 'tertiary', 'tertiary_link']),
      ],
    ],
    minzoom: 8,
    width: ramp([8, 0.6], [12, 1.8], [14, 3.6], [16, 7], [18, 16]),
  },
  {
    id: 'primary',
    filter: [
      'all',
      ['==', ['get', 'kind'], 'major_road'],
      isIn('kind_detail', ['primary', 'primary_link', 'trunk', 'trunk_link']),
    ],
    minzoom: 6,
    width: ramp([6, 0.6], [10, 1.6], [14, 4.2], [16, 8], [18, 18]),
  },
  {
    id: 'motorway',
    filter: ['==', ['get', 'kind'], 'highway'],
    minzoom: 5,
    width: ramp([5, 0.6], [10, 2], [14, 5], [16, 9], [18, 20]),
  },
];

/** Casing allowance each side of the ribbon, by zoom. */
const CASING_ADD = ramp([8, 0.6], [14, 1.4], [18, 3]);

/** Trails proper — what a hiker follows. Drawn bold and dashed from z11. */
const TRAIL_PATHS = ['path', 'bridleway'];
/**
 * Urban walkways: sidewalks, crossings, plazas, steps. A city is laced with
 * them, so they stay thin and quiet (from z15) and sit UNDER the roads,
 * leaving the trail dashes to mean "trail".
 */
const URBAN_PATHS = [
  'footway',
  'sidewalk',
  'crossing',
  'pedestrian',
  'steps',
  'corridor',
  'parking_aisle',
];

const POI_KINDS = [
  'camp_site',
  'campsite',
  'shelter',
  'alpine_hut',
  'wilderness_hut',
  'information',
  'drinking_water',
  'viewpoint',
  'attraction',
  'toilets',
];

/**
 * Stone & Paper layers for a Protomaps v4 vector source. Light or stone-night
 * follows `scheme` (see {@link StoneBasemapScheme.dark}).
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
  const road = (extra: ExpressionSpecification): ExpressionSpecification => [
    'all',
    extra,
    notTunnel,
  ];

  /**
   * Summits: bold name over its height, higher peaks winning collisions
   * (`symbol-sort-key`). Drawn BELOW the place labels, so a town keeps its
   * name where a minor peak would crowd it. Text only: the style has no
   * sprite and Atkinson carries no ▲ (U+25B2) to draw a marker with.
   * Metres only — the style builder doesn't know the units setting.
   */
  const peakLayer = (): SymbolLayerSpecification => {
    const ours = options.peaks;
    const ele = ours ? 'ele' : 'elevation';
    const from: Pick<SymbolLayerSpecification, 'source' | 'source-layer' | 'minzoom' | 'filter'> =
      ours
        ? // Every feature is a named summit, drawn from its rank less the lead.
          {
            source: ours.source,
            'source-layer': ours.sourceLayer,
            minzoom: 5,
            filter: peakDueFilter(PEAK_LEAD[options.peakDensity ?? DEFAULT_PEAK_DENSITY]),
          }
        : {
            source,
            'source-layer': 'pois',
            minzoom: 11,
            filter: isIn('kind', ['peak', 'volcano']),
          };
    return {
      id: id('peak'),
      type: 'symbol',
      ...from,
      layout: {
        'text-field': [
          'format',
          name,
          { 'text-font': ['literal', fonts.bold] },
          // The height on its own line — no dangling line break without one.
          ['case', ['has', ele], ['concat', '\n', elevationLabel(ele)], ''],
          { 'font-scale': 0.85 },
        ],
        'text-font': fonts.regular,
        'text-size': ramp([5, 10.5], [10, 12], [14, 13]),
        'text-max-width': 8,
        // A little more air than the default 2 px: with summits arriving
        // earlier (#461) the ranges would otherwise read as a wall of names.
        'text-padding': 6,
        'symbol-sort-key': ['-', 0, ['to-number', ['coalesce', ['get', ele], 0], 0]],
      },
      paint: { 'text-color': scheme.ink, ...halo },
    };
  };

  const base: LayerSpecification[] = [
    { id: id('background'), type: 'background', paint: { 'background-color': scheme.land } },
    // Low zooms (z0–7): Protomaps' generalised land cover.
    {
      id: id('landcover-bare'),
      type: 'fill',
      source,
      'source-layer': 'landcover',
      filter: isIn('kind', ['barren', 'urban_area']),
      paint: { 'fill-color': scheme.landAlt, 'fill-opacity': 0.6 },
    },
    {
      id: id('landcover-ice'),
      type: 'fill',
      source,
      'source-layer': 'landcover',
      filter: ['==', ['get', 'kind'], 'glacier'],
      paint: { 'fill-color': scheme.water, 'fill-opacity': 0.12 },
    },
    {
      id: id('landcover-wood'),
      type: 'fill',
      source,
      'source-layer': 'landcover',
      filter: ['==', ['get', 'kind'], 'forest'],
      paint: { 'fill-color': scheme.vegetation, 'fill-opacity': vegOpacity },
    },
    {
      id: id('landcover-grass'),
      type: 'fill',
      source,
      'source-layer': 'landcover',
      filter: isIn('kind', ['grassland', 'scrub']),
      paint: { 'fill-color': scheme.vegetation, 'fill-opacity': vegOpacity * 0.5 },
    },
    // From z8 on: detailed land use.
    {
      id: id('landuse-built'),
      type: 'fill',
      source,
      'source-layer': 'landuse',
      minzoom: 10,
      filter: isIn('kind', BUILT),
      paint: { 'fill-color': scheme.landAlt, 'fill-opacity': dark ? 0.5 : 0.6 },
    },
    {
      id: id('landuse-bare'),
      type: 'fill',
      source,
      'source-layer': 'landuse',
      filter: isIn('kind', BARE),
      paint: { 'fill-color': scheme.landAlt, 'fill-opacity': 0.7 },
    },
    {
      id: id('landuse-ice'),
      type: 'fill',
      source,
      'source-layer': 'landuse',
      filter: ['==', ['get', 'kind'], 'glacier'],
      paint: { 'fill-color': scheme.water, 'fill-opacity': 0.12 },
    },
    {
      id: id('landuse-grass'),
      type: 'fill',
      source,
      'source-layer': 'landuse',
      filter: isIn('kind', GREEN),
      paint: { 'fill-color': scheme.vegetation, 'fill-opacity': vegOpacity * 0.5 },
    },
    {
      id: id('landuse-wood'),
      type: 'fill',
      source,
      'source-layer': 'landuse',
      filter: isIn('kind', WOOD),
      paint: { 'fill-color': scheme.vegetation, 'fill-opacity': vegOpacity },
    },
    {
      id: id('park'),
      type: 'fill',
      source,
      'source-layer': 'landuse',
      filter: isIn('kind', PARK),
      paint: { 'fill-color': scheme.vegetation, 'fill-opacity': vegOpacity * 0.35 },
    },
    {
      id: id('park-outline'),
      type: 'line',
      source,
      'source-layer': 'landuse',
      minzoom: 8,
      filter: isIn('kind', ['nature_reserve', 'national_park', 'protected_area']),
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
      filter: isPolygon,
      paint: { 'fill-color': scheme.water, 'fill-opacity': waterOpacity },
    },
    {
      id: id('water-shore'),
      type: 'line',
      source,
      'source-layer': 'water',
      minzoom: 8,
      filter: isPolygon,
      paint: { 'line-color': scheme.waterLine, 'line-width': ramp([8, 0.5], [12, 1], [16, 1.6]) },
    },
    {
      id: id('waterway'),
      type: 'line',
      source,
      'source-layer': 'water',
      minzoom: 8,
      filter: isLine,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': scheme.waterLine,
        // One zoom curve (the spec allows a single zoom interpolate), the
        // kind picked per stop: rivers/canals vs streams and ditches.
        'line-width': [
          'interpolate',
          ['exponential', 1.4],
          ['zoom'],
          8,
          byWaterwayKind(0.8, 0.2),
          12,
          byWaterwayKind(1.6, 0.8),
          16,
          byWaterwayKind(4, 2),
        ],
      },
    },
  ];

  // Set with the contour lines below; the height labels ride the major ones.
  let contourLabel: LayerSpecification | null = null;
  if (options.contours) {
    const c = options.contours;
    // Terrarium carries bathymetry: never draw sea-level or underwater lines
    // (they read as stray orange rings in the St. Lawrence).
    const aboveSea: ExpressionSpecification = ['>', ['to-number', ['get', c.field], 0], 0];
    const isMajor: ExpressionSpecification = c.levelField
      ? ['==', ['to-number', ['get', c.levelField], 0], 1]
      : [
          '==',
          ['%', ['to-number', ['get', c.field], 0], (c.intervalM ?? 10) * (c.majorEvery ?? 5)],
          0,
        ];
    base.push(
      {
        id: id('contour-minor'),
        type: 'line',
        source: c.source,
        'source-layer': c.sourceLayer,
        minzoom: c.levelField ? 10 : 12,
        filter: ['all', aboveSea, ['!', isMajor]],
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
        minzoom: c.levelField ? 8 : 10,
        filter: ['all', aboveSea, isMajor],
        paint: {
          'line-color': scheme.contour,
          'line-opacity': dark ? 0.7 : 0.75,
          'line-width': 1.25,
        },
      },
    );
    // The height written along the major lines, the way a paper topo map
    // does (owner, 2026-09-28): from z12, where the lines are far enough
    // apart to read. First among the labels, so roads, water and place
    // names win any collision; metres, as the contour interval is.
    contourLabel = {
      id: id('contour-label'),
      type: 'symbol',
      source: c.source,
      'source-layer': c.sourceLayer,
      minzoom: 12,
      filter: ['all', aboveSea, isMajor],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'text-field': ['to-string', ['round', ['to-number', ['get', c.field], 0]]],
        'text-font': fonts.regular,
        'text-size': ramp([12, 10], [16, 12]),
        'text-max-angle': 25,
        'text-padding': 4,
      },
      paint: { 'text-color': scheme.contour, ...halo },
    };
  }

  base.push(
    {
      id: id('cliff'),
      type: 'line',
      source,
      'source-layer': 'earth',
      minzoom: 13,
      filter: ['all', isLine, ['==', ['get', 'kind'], 'cliff']],
      paint: {
        'line-color': scheme.lineMuted,
        'line-opacity': 0.8,
        'line-width': ramp([13, 0.8], [17, 2]),
      },
    },
    {
      id: id('building'),
      type: 'fill',
      source,
      'source-layer': 'buildings',
      minzoom: 13,
      filter: ['all', isPolygon, isIn('kind', ['building', 'building_part'])],
      paint: { 'fill-color': scheme.building, 'fill-opacity': dark ? 0.6 : 0.5 },
    },
    {
      id: id('boundary'),
      type: 'line',
      source,
      'source-layer': 'boundaries',
      filter: isIn('kind', ['country', 'region']),
      paint: {
        'line-color': scheme.lineMuted,
        'line-opacity': 0.7,
        'line-width': ramp([3, 0.6], [10, 1.2], [14, 1.8]),
        'line-dasharray': [4, 2, 1, 2],
      },
    },
    // Urban walkways, under the roads (see URBAN_PATHS).
    {
      id: id('footway'),
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 15,
      filter: road(['all', ['==', ['get', 'kind'], 'path'], isIn('kind_detail', URBAN_PATHS)]),
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': scheme.path,
        'line-opacity': 0.45,
        'line-width': ramp([15, 0.6], [18, 1.4]),
        'line-dasharray': [2, 2],
      },
    },
    // Casings, widest class last so its casing draws over lesser roads' ribbons.
    ...ROADS.map((r): LayerSpecification => ({
      id: id(`road-${r.id}-casing`),
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: r.minzoom,
      filter: road(r.filter),
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
      'source-layer': 'roads',
      minzoom: r.minzoom,
      filter: road(r.filter),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': scheme.roadFill, 'line-width': r.width },
    })),
    {
      id: id('rail'),
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 10,
      filter: road([
        'all',
        ['==', ['get', 'kind'], 'rail'],
        ['!=', ['get', 'kind_detail'], 'yard'],
      ]),
      paint: {
        'line-color': scheme.lineMuted,
        'line-width': ramp([10, 0.6], [16, 1.6]),
        'line-dasharray': [3, 3],
      },
    },
    {
      id: id('ferry'),
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 9,
      filter: ['==', ['get', 'kind'], 'ferry'],
      paint: {
        'line-color': scheme.waterLine,
        'line-opacity': 0.8,
        'line-width': ramp([9, 0.6], [16, 1.4]),
        'line-dasharray': [4, 3],
      },
    },
    // The trail network — the point of the app. Tracks (forest/ATV roads),
    // cycleways and trails are dashed in the trail colour and drawn above the
    // road ribbons they cross; tracks longer-dashed and a touch wider so the
    // kinds read apart.
    {
      id: id('track'),
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 11,
      filter: road([
        'all',
        ['==', ['get', 'kind'], 'path'],
        ['==', ['get', 'kind_detail'], 'track'],
      ]),
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': scheme.path,
        'line-opacity': 0.85,
        'line-width': ramp([11, 0.8], [14, 1.6], [18, 3.2]),
        'line-dasharray': [5, 2],
      },
    },
    {
      id: id('cycleway'),
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 13,
      filter: road([
        'all',
        ['==', ['get', 'kind'], 'path'],
        ['==', ['get', 'kind_detail'], 'cycleway'],
      ]),
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': scheme.path,
        'line-opacity': 0.7,
        'line-width': ramp([13, 0.8], [18, 2.2]),
        'line-dasharray': [3.8, 2.7],
      },
    },
    {
      id: id('path'),
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 11,
      filter: road([
        'all',
        ['==', ['get', 'kind'], 'path'],
        ['in', ['coalesce', ['get', 'kind_detail'], 'path'], ['literal', TRAIL_PATHS]],
      ]),
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
    ...(contourLabel ? [contourLabel] : []),
    {
      id: id('waterway-label'),
      type: 'symbol',
      source,
      'source-layer': 'water',
      minzoom: 12,
      filter: ['all', isLine, ['has', 'name']],
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
      'source-layer': 'water',
      // Protomaps ships one label point per named water body.
      filter: ['all', isPoint, ['has', 'name'], dueAtZoom],
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
      'source-layer': 'roads',
      minzoom: 13,
      filter: [
        'all',
        ['has', 'name'],
        ['!', ['in', ['coalesce', ['get', 'kind_detail'], ''], ['literal', URBAN_PATHS]]],
      ],
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
      'source-layer': 'pois',
      minzoom: 14,
      filter: ['all', isIn('kind', POI_KINDS), ['has', 'name'], dueAtZoom],
      layout: {
        'text-field': name,
        'text-font': fonts.regular,
        'text-size': 12,
        'text-max-width': 8,
      },
      paint: { 'text-color': scheme.inkMuted, ...halo },
    },
    peakLayer(),
    {
      id: id('place-village'),
      type: 'symbol',
      source,
      'source-layer': 'places',
      minzoom: 10,
      filter: [
        'all',
        [
          'any',
          isIn('kind', ['neighbourhood', 'macrohood']),
          [
            'all',
            ['==', ['get', 'kind'], 'locality'],
            isIn('kind_detail', ['village', 'hamlet', 'locality', 'isolated_dwelling']),
          ],
        ],
        dueWithin(1.5),
      ],
      layout: {
        'text-field': name,
        'text-font': fonts.regular,
        'text-size': ramp([10, 11], [15, 14]),
        'text-max-width': 8,
        'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 99],
      },
      paint: { 'text-color': scheme.ink, ...halo },
    },
    {
      id: id('place-town'),
      type: 'symbol',
      source,
      'source-layer': 'places',
      minzoom: 8,
      filter: [
        'all',
        ['==', ['get', 'kind'], 'locality'],
        ['==', ['get', 'kind_detail'], 'town'],
        dueWithin(1),
      ],
      layout: {
        'text-field': name,
        'text-font': fonts.regular,
        'text-size': ramp([8, 12], [14, 16]),
        'text-max-width': 8,
        'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 99],
      },
      paint: { 'text-color': scheme.ink, ...halo },
    },
    {
      id: id('place-city'),
      type: 'symbol',
      source,
      'source-layer': 'places',
      minzoom: 4,
      filter: [
        'all',
        ['==', ['get', 'kind'], 'locality'],
        ['==', ['get', 'kind_detail'], 'city'],
        dueAtZoom,
      ],
      layout: {
        'text-field': name,
        'text-font': fonts.bold,
        'text-size': ramp([4, 11.5], [8, 13.5], [12, 18]),
        'text-max-width': 8,
        'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 99],
      },
      paint: { 'text-color': scheme.ink, ...halo },
    },
    {
      id: id('place-province'),
      type: 'symbol',
      source,
      'source-layer': 'places',
      minzoom: 4,
      maxzoom: 8,
      filter: ['==', ['get', 'kind'], 'region'],
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

/**
 * The stone layers that still make sense drawn OVER satellite imagery — the
 * "Labels on satellite" overlay (#484): road casings and ribbons, the trail
 * network (tracks, cycleways, paths) and every label (water, roads, POIs,
 * peaks, places), in the same order the map draws them. The road casings
 * are left out and the ribbons made translucent ({@link IMAGERY_ROAD_OPACITY}):
 * opaque paper roads in dark casings buried the imagery on the emulator
 * pass. Everything that
 * paints ground — the paper background, land cover and land use, water
 * fills, buildings, the contour lines and their labels — is left out, so the
 * imagery shows through untouched.
 */
export const STONE_IMAGERY_LAYER_KEYS: readonly string[] = [
  ...ROADS.map((r) => `road-${r.id}`),
  'track',
  'cycleway',
  'path',
  'waterway-label',
  'water-label',
  'road-label',
  'poi',
  'peak',
  'place-village',
  'place-town',
  'place-city',
  'place-province',
];

/**
 * {@link buildStoneLayers} cut down to {@link STONE_IMAGERY_LAYER_KEYS}, in
 * draw order (line work first, labels last). The caller passes a scheme
 * tuned for imagery — light ink on a dark halo reads over any photo.
 */
export function buildStoneImageryLayers(
  scheme: StoneBasemapScheme,
  options: Omit<StoneStyleOptions, 'contours'>,
): LayerSpecification[] {
  const keep = new Set(STONE_IMAGERY_LAYER_KEYS.map((k) => `${STONE_LAYER_PREFIX}${k}`));
  const roads = new Set(ROADS.map((r) => `${STONE_LAYER_PREFIX}road-${r.id}`));
  const { base, labels } = buildStoneLayers(scheme, options);
  return [...base, ...labels]
    .filter((l) => keep.has(l.id))
    .map((l) =>
      l.type === 'line' && roads.has(l.id)
        ? { ...l, paint: { ...l.paint, 'line-opacity': IMAGERY_ROAD_OPACITY } }
        : l,
    );
}

/** Road ribbons over imagery: present enough to follow, thin enough to see through. */
export const IMAGERY_ROAD_OPACITY = 0.5;
