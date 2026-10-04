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
import { placeNameExpression } from './placeNames';
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
  /** Park and protected-area boundaries and their names — the green ink. */
  parkInk: string;
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
  /**
   * Our Worker's steepness tags (#509): `coarseField` = how many lines of the
   * zoom's own interval a line stands for (1 = interval kept), `steepField` =
   * the steepness class 0–3 of that stretch. Where the Worker coarsened the
   * interval, steep stretches are drawn heavier (see {@link contourStroke}),
   * so walls read dark again; where it didn't (k = 1), nothing changes.
   */
  coarseField?: string;
  steepField?: string;
}

/** The steepest class our contour tiles carry (`s`, Worker `MAX_SLOPE_CLASS`). */
export const CONTOUR_MAX_STEEP = 3;

/**
 * How a contour line is stroked at emphasis `e` (0 = as always, up to
 * {@link CONTOUR_MAX_STEEP} on a coarsened tile's steepest walls): opacity,
 * width (px) and how far its colour moves toward the scheme's ink (0–1;
 * darker on paper, brighter on the night map and on imagery — more contrast
 * either way). At e = 0 these are exactly the pre-#509 values.
 */
export function contourStroke(
  e: number,
  major: boolean,
  dark: boolean,
): { opacity: number; width: number; inkMix: number } {
  const t = Math.max(0, Math.min(1, e / CONTOUR_MAX_STEEP));
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return major
    ? {
        opacity: lerp(dark ? 0.7 : 0.75, dark ? 0.9 : 0.92),
        width: lerp(1.25, 1.7),
        inkMix: lerp(0, 0.15),
      }
    : {
        opacity: lerp(dark ? 0.5 : 0.55, dark ? 0.8 : 0.85),
        width: lerp(0.7, 1.2),
        inkMix: lerp(0, 0.15),
      };
}

/**
 * The emphasis a contour feature gets: its steepness class where its tile
 * was coarsened, else 0 — so tiles that kept their interval (Québec, any
 * gentle terrain) draw exactly as before.
 */
export function contourEmphasis(c: StoneContourSource): ExpressionSpecification | null {
  if (!c.coarseField || !c.steepField) return null;
  return [
    'case',
    ['>', ['to-number', ['get', c.coarseField], 1], 1],
    ['min', ['max', ['to-number', ['get', c.steepField], 0], 0], CONTOUR_MAX_STEEP],
    0,
  ];
}

/** Line paint for the minor or major contours, data-driven when the tiles carry steepness. */
function contourPaint(
  c: StoneContourSource,
  major: boolean,
  scheme: StoneBasemapScheme,
): LineLayerSpecification['paint'] {
  const flat = contourStroke(0, major, scheme.dark);
  const e = contourEmphasis(c);
  if (e === null) {
    return { 'line-color': scheme.contour, 'line-opacity': flat.opacity, 'line-width': flat.width };
  }
  const steep = contourStroke(CONTOUR_MAX_STEEP, major, scheme.dark);
  return {
    // Linear in e from the contour colour toward ink; the ink stop sits where
    // the mix would reach 1, so e = max lands at `steep.inkMix`. Stops are
    // explicit colours: a bare string stop is typed as a string by the
    // reference parser ("Type string is not interpolatable").
    'line-color': [
      'interpolate',
      ['linear'],
      e,
      0,
      ['to-color', scheme.contour],
      CONTOUR_MAX_STEEP / steep.inkMix,
      ['to-color', scheme.ink],
    ],
    'line-opacity': [
      'interpolate',
      ['linear'],
      e,
      0,
      flat.opacity,
      CONTOUR_MAX_STEEP,
      steep.opacity,
    ],
    'line-width': ['interpolate', ['linear'], e, 0, flat.width, CONTOUR_MAX_STEEP, steep.width],
  };
}

/**
 * How the heights ride the major contours (owner, 2026-10: "I see 3 darker
 * lines and only the 50, not the 50, 100 and 150"). MapLibre lays line
 * labels out per tile: candidate spots every `symbol-spacing` px along each
 * line (a line that crosses the tile edge gets its first one half a spacing
 * in, and no fallback in the middle), and each spot is kept only if the line
 * bends less than `text-max-angle` under the label. It never looks for
 * another spot. With 320 px and 25° (until 2.1.0), a phone screen — 400 px
 * wide, and up to twice a tile's scale before the next zoom's tiles take
 * over, so up to 640 px between spots — often held no surviving spot for
 * most of the lines crossing it. Measured on the served contour tiles
 * (Mont-Sainte-Anne, Stoneham, Charlevoix, Jacques-Cartier, Baie-Saint-Paul,
 * random 400×720 px views at z13–14): 73 % of the index lines in view
 * carried a height; with these values, 89 % (z12–13: 75 → 94 %) — the rest
 * are lines that only clip a corner. The tighter `text-padding` lets heights
 * on neighbouring index lines of a steep slope stack, as on a paper topo map.
 */
export const CONTOUR_LABEL_LAYOUT = {
  /** px between candidate spots along one line (on-screen: up to 2×). */
  spacingPx: 220,
  /** Bend allowed under a label (MapLibre's default; contours wiggle). */
  maxAngleDeg: 45,
  /** Collision padding around each height (px). */
  paddingPx: 2,
} as const;

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

/**
 * Our worldwide parks tileset (`infra/tiles/nas/parks.sh`), which exists
 * because Protomaps cannot be trusted to know a national park: it files
 * Yellowstone and Kruger under `nature_reserve`, and Jacques-Cartier, the
 * Swiss National Park and Algonquin under `park` — the kind of a city square
 * — naming those only from z12–13 (measured on the served tiles, 2026-10).
 *
 * - `areaLayer`: one polygon per OSM boundary=national_park (or IUCN II
 *   protected area), in the tiles from two zooms before its `rank`;
 * - `labelLayer`: one point per named protected area, carrying `name`
 *   (+ `name:en` / `name:fr`), `class` (`national` | `reserve`) and `rank` —
 *   the zoom its area earns (≥ 5000 km² at z5 … the smallest at z12), which is
 *   also the first zoom whose tiles carry it.
 *
 * Without this source the map draws what Protomaps has (see
 * {@link StoneStyleOptions.protectedAreas}).
 */
export interface StoneParksSource {
  source: string;
  areaLayer: string;
  labelLayer: string;
}

/**
 * Our worldwide province / state label points (`docs/data/admin1-labels-v1.json`,
 * built from Natural Earth by `scripts/map/build-admin1-labels.mjs`), as a
 * GeoJSON source. Each point carries `name` (+ `name:fr` / `name:en`), `r` —
 * the zoom it is due from, sized by its area — and, for the régions /
 * regioni / comunidades grouped from their members, `u`: the zoom it hides
 * from again, where its members take over.
 *
 * It exists because the Protomaps tiles only carry `region` points for a
 * few countries (US, Canada, Australia, Brazil): with it, the provinces are
 * drawn from it EVERYWHERE and Protomaps' regions not at all — one source
 * and one ranking, so no name is ever doubled. Without it, the map draws
 * Protomaps' regions as before.
 */
export interface StoneAdmin1Source {
  source: string;
}

export interface StoneStyleOptions {
  /** Id of the Protomaps vector source in the style. */
  source: string;
  fonts?: StoneFonts;
  language?: StoneLabelLanguage;
  contours?: StoneContourSource;
  peaks?: StonePeaksSource;
  parks?: StoneParksSource;
  admin1?: StoneAdmin1Source;
  /**
   * "Parks & protected areas" (overlays menu): the boundary of every national
   * park, reserve and protected area, and its name in green italic. Default
   * true. Off leaves only the faint land-use wash parks always had.
   */
  protectedAreas?: boolean;
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

/**
 * Collision priority of a summit, as few distinct values as will do.
 *
 * MapLibre Native cuts a symbol bucket into one draw segment per distinct
 * `symbol-sort-key` — and since its drawable renderer, one drawable each,
 * every frame. The key used to be the height itself (`-ele`), which is all
 * but unique per summit: the tiles around Zermatt hold ~4 000 summits at z9
 * and ~350 at z11, so a frame issued thousands of draws for a few dozen
 * visible names. Measured on the emulator (2026-10, the Alps camera path):
 * panning at z9 ran at 1 fps and at z11 at 6 fps; with the layer off, 59.
 * Height bands 100 m wide still cost half the frame rate (21 fps at z9),
 * 250 m bands 34 fps, 500 m bands 45 fps.
 *
 * So the key is mostly the summit's `rank` — its rung on the tileset's
 * elevation ladder (≥ 3000 m, ≥ 2000 m, ≥ 1500 m, ≥ 1000 m, ≥ 500 m, lower,
 * unknown; a prominent summit a rung or two up) — so a 3000er still beats a
 * 2000er to a crowded spot, and two summits on one rung are placed in tile
 * order. Rank alone ran the Alps at 49 fps at z9 (57 at z11), but it let
 * Picco Muzio (4187 m, a shoulder of the Matterhorn) take the Matterhorn's
 * place, and Dom go missing, at z9–10. So the top of the ladder keeps finer
 * steps: 250 m bands from 4000 m, 1000 m bands from 5000 m — the names a
 * range is known by. That is at most {@link PEAK_SORT_KEY_MAX_VALUES} values
 * worldwide and ~10 in an Alpine tile; measured with real drags at z9 near
 * Zermatt, 35 fps against rank's 38 (and 2 before).
 *
 * Protomaps' own peaks (the fallback without our tiles) carry no rank:
 * {@link PEAK_SORT_BAND_M}-metre height bands instead.
 */
export function peakSortKey(ours: boolean, eleField: string): ExpressionSpecification {
  const ele: ExpressionSpecification = ['to-number', ['coalesce', ['get', eleField], 0], 0];
  if (!ours) return ['-', 0, ['floor', ['/', ele, PEAK_SORT_BAND_M]]];
  return [
    'case',
    // 5000 m and up: −20 (5000s) … −23 (8000s).
    ['>=', ele, 5000],
    ['-', -15, ['floor', ['/', ele, 1000]]],
    // 4000–4999 m: −16 (4000–4249) … −19 (4750–4999).
    ['>=', ele, 4000],
    ['-', 0, ['floor', ['/', ele, 250]]],
    // Below: the rung, 5 … 12. coalesce first: to-number turns a missing
    // rank into 0, which would be the best key.
    ['to-number', ['coalesce', ['get', 'rank'], PEAK_UNRANKED_SORT_KEY], PEAK_UNRANKED_SORT_KEY],
  ];
}

/** Sort key of a summit from tiles built before `rank` existed: last. */
export const PEAK_UNRANKED_SORT_KEY = 12;
/**
 * Distinct keys our tiles can produce: 4 bands of 1000 m (5000–8999), 4 of
 * 250 m (4000–4999) and the 8 ranks (z5 … z12, `infra/tiles/nas/peaks_geojson.py`).
 */
export const PEAK_SORT_KEY_MAX_VALUES = 16;
/** Height band (m) of the fallback key: 18 values from sea level to Everest. */
export const PEAK_SORT_BAND_M = 500;

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
/** Protected land in Protomaps' eyes. Not `park`: that is every city park too. */
const PROTECTED = ['nature_reserve', 'national_park', 'protected_area'];
const PARK = ['park', ...PROTECTED];

/**
 * The band of green inside a park boundary, as on a paper topo map: its width
 * by zoom (px). Drawn as an inset line (`line-offset` = half the width), so it
 * hugs the inside of the edge. Kept under 8 px: vector tiles clip polygons 8 px
 * past the tile edge, and a wider band would bring those cut edges into view.
 */
export const PARK_BAND_WIDTH: readonly (readonly [number, number])[] = [
  [4, 1.5],
  [8, 4],
  [12, 7],
];

/** How strongly the boundary is inked: the band, the edge and the quiet dashes. */
export const PARK_PAINT = {
  // Lighter on stone night and imagery: a pale sage band glows on a dark ground.
  band: { light: 0.2, dark: 0.16 },
  edge: 0.8,
  quiet: 0.6,
} as const;

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
  // Countries and provinces: one name even where OSM lists several.
  const placeName = placeNameExpression(options.language ?? 'local');
  const provinceLayer = () => provinceLayerOf(scheme, options, fonts, placeName);
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
   * Summits: bold name over its height, higher-ranked peaks winning
   * collisions (`symbol-sort-key`, see {@link peakSortKey}). Drawn BELOW the
   * place labels, so a town keeps its name where a minor peak would crowd it. Text only: the style has no
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
        // Coarse on purpose: one draw per distinct value (see peakSortKey).
        'symbol-sort-key': peakSortKey(ours !== undefined, ele),
      },
      paint: { 'text-color': scheme.ink, ...halo },
    };
  };

  /**
   * Parks and protected areas: boundary and name (the fill is the land-use
   * wash below). Two weights of boundary — STRONG, a solid green edge over a
   * translucent band along its inside, and QUIET, thin dashes:
   *
   * - with our parks tiles: national parks strong, from their own polygons
   *   (as early as z4 for the largest); Protomaps' reserves and protected
   *   areas quiet, from z8. Every name comes from our label points.
   * - without them: Protomaps' national parks, reserves and protected areas
   *   strong from z5 (it tells them apart too unreliably to rank them), its
   *   `park` polygons quiet — the big parks it misfiles, and city parks,
   *   whose dashes step back as the streets arrive. Names from its `pois`
   *   points, from the zoom before their `min_zoom` (the first zoom whose
   *   tiles carry them).
   *
   * Every zoom curve is the top-level interpolate of its property (a nested
   * one crashes MapLibre iOS).
   */
  const parkLayers = (): {
    lines: LayerSpecification[];
    label: SymbolLayerSpecification | null;
  } => {
    if (options.protectedAreas === false) return { lines: [], label: null };
    const ours = options.parks;
    type From = Pick<LineLayerSpecification, 'source' | 'source-layer' | 'minzoom' | 'filter'>;
    const strong: From = ours
      ? { source: ours.source, 'source-layer': ours.areaLayer, minzoom: 4, filter: isPolygon }
      : { source, 'source-layer': 'landuse', minzoom: 5, filter: isIn('kind', PROTECTED) };
    const quiet: From = ours
      ? { source, 'source-layer': 'landuse', minzoom: 8, filter: isIn('kind', PROTECTED) }
      : { source, 'source-layer': 'landuse', minzoom: 6, filter: ['==', ['get', 'kind'], 'park'] };
    const band = PARK_BAND_WIDTH.map(([z, w]): [number, number] => [z, w]);
    return {
      lines: [
        {
          id: id('park-band'),
          type: 'line',
          ...strong,
          layout: { 'line-join': 'round' },
          paint: {
            'line-color': scheme.parkInk,
            'line-opacity': dark ? PARK_PAINT.band.dark : PARK_PAINT.band.light,
            'line-width': ramp(...band),
            // Positive = inset on a polygon: the band sits inside the edge.
            'line-offset': ramp(...band.map(([z, w]): [number, number] => [z, w / 2])),
          },
        },
        {
          id: id('park-outline'),
          type: 'line',
          ...quiet,
          paint: {
            'line-color': scheme.parkInk,
            'line-opacity': ours
              ? PARK_PAINT.quiet
              : ['interpolate', ['linear'], ['zoom'], 12, PARK_PAINT.quiet, 14, 0.3],
            'line-width': ramp([6, 0.5], [14, 1.2]),
            'line-dasharray': [3, 2],
          },
        },
        {
          id: id('park-line'),
          type: 'line',
          ...strong,
          layout: { 'line-join': 'round' },
          paint: {
            'line-color': scheme.parkInk,
            'line-opacity': PARK_PAINT.edge,
            'line-width': ramp([4, 0.6], [9, 1], [14, 1.6]),
          },
        },
      ],
      label: {
        id: id('park-label'),
        type: 'symbol',
        ...(ours
          ? {
              source: ours.source,
              'source-layer': ours.labelLayer,
              minzoom: 4,
              filter: ['has', 'name'],
            }
          : {
              source,
              'source-layer': 'pois',
              minzoom: 5,
              filter: ['all', isIn('kind', PARK), ['has', 'name'], dueWithin(1)],
            }),
        layout: {
          'text-field': name,
          'text-font': fonts.italic,
          'text-size': ramp([5, 10.5], [9, 12], [14, 14]),
          'text-letter-spacing': 0.04,
          'text-max-width': 7,
          'text-padding': 4,
          // The larger park wins a collision: our area rank, or Protomaps' zoom.
          'symbol-sort-key': [
            'to-number',
            ['coalesce', ['get', ours ? 'rank' : 'min_zoom'], 99],
            99,
          ],
        },
        paint: { 'text-color': scheme.parkInk, ...halo },
      },
    };
  };
  const parks = parkLayers();

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
    ...parks.lines,
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
        paint: contourPaint(c, false, scheme),
      },
      {
        id: id('contour-major'),
        type: 'line',
        source: c.source,
        'source-layer': c.sourceLayer,
        minzoom: c.levelField ? 8 : 10,
        filter: ['all', aboveSea, isMajor],
        paint: contourPaint(c, true, scheme),
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
        'symbol-spacing': CONTOUR_LABEL_LAYOUT.spacingPx,
        'text-field': ['to-string', ['round', ['to-number', ['get', c.field], 0]]],
        'text-font': fonts.regular,
        'text-size': ramp([12, 10], [16, 12]),
        'text-max-angle': CONTOUR_LABEL_LAYOUT.maxAngleDeg,
        'text-padding': CONTOUR_LABEL_LAYOUT.paddingPx,
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
    // Under the summits and the places: a peak or a town keeps its name where
    // a park's would crowd it.
    ...(parks.label ? [parks.label] : []),
    peakLayer(),
    // Provinces, then countries, then the settlements: MapLibre places the
    // TOP layer's labels first, so a city keeps its name where a country or
    // a province would crowd it (z4–7), and a country wins over a province.
    provinceLayer(),
    {
      id: id('place-country'),
      type: 'symbol',
      source,
      'source-layer': 'places',
      // Worldwide from Protomaps (France z2, Italia z3, Schweiz z4 …), gone
      // where the provinces and towns take over.
      minzoom: 2,
      maxzoom: 8,
      filter: ['all', ['==', ['get', 'kind'], 'country'], dueAtZoom],
      layout: {
        'text-field': placeName,
        'text-font': fonts.regular,
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10.5, 4, 12.5, 7, 15],
        'text-transform': 'uppercase',
        'text-letter-spacing': COUNTRY_LETTER_SPACING,
        'text-max-width': 7,
        'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 99],
      },
      paint: { 'text-color': scheme.inkMuted, ...halo },
    },
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
  ];

  return { base, labels };
}

/** Countries: wide-tracked capitals, a step quieter than a province's bold. */
export const COUNTRY_LETTER_SPACING = 0.22;

/** Zoom range of the province / state labels (maxzoom exclusive: drawn through z8). */
export const PROVINCE_MINZOOM = 4;
export const PROVINCE_MAXZOOM = 9;

/**
 * Province, state, canton and région names: from our Natural Earth points
 * when configured (worldwide, ranked by size — see {@link StoneAdmin1Source}),
 * else Protomaps' `region` points (a few countries only).
 */
function provinceLayerOf(
  scheme: StoneBasemapScheme,
  options: StoneStyleOptions,
  fonts: StoneFonts,
  placeName: ExpressionSpecification,
): SymbolLayerSpecification {
  const look = {
    'text-field': placeName,
    'text-font': fonts.bold,
    'text-transform': 'uppercase',
    'text-letter-spacing': 0.12,
    'text-max-width': 9,
  } as const;
  const paint = {
    'text-color': scheme.inkMuted,
    'text-halo-color': scheme.halo,
    'text-halo-width': 1.4,
    'text-halo-blur': 0.3,
  };
  const layerId = `${STONE_LAYER_PREFIX}place-province`;
  const ours = options.admin1;
  if (!ours) {
    return {
      id: layerId,
      type: 'symbol',
      source: options.source,
      'source-layer': 'places',
      minzoom: PROVINCE_MINZOOM,
      maxzoom: 8,
      filter: ['==', ['get', 'kind'], 'region'],
      layout: { ...look, 'text-size': 12 },
      paint,
    };
  }
  return {
    id: layerId,
    type: 'symbol',
    source: ours.source,
    minzoom: PROVINCE_MINZOOM,
    maxzoom: PROVINCE_MAXZOOM,
    filter: [
      'all',
      // Due from its rank (the zoom its width spans ~90 px) …
      ['<=', ['to-number', ['coalesce', ['get', 'r'], 99], 99], ['zoom']],
      // … and a grouped région hides where its départements take over.
      ['<', ['zoom'], ['to-number', ['coalesce', ['get', 'u'], 99], 99]],
    ],
    layout: {
      ...look,
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 8, 13],
      // Bigger provinces first; the rank is a whole zoom, so ≤ 6 values.
      'symbol-sort-key': ['to-number', ['coalesce', ['get', 'r'], 99], 99],
    },
    paint,
  };
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
  // Park boundaries and names, no fill: the imagery stays untouched.
  'park-band',
  'park-outline',
  'park-line',
  ...ROADS.map((r) => `road-${r.id}`),
  'track',
  'cycleway',
  'path',
  'waterway-label',
  'water-label',
  'road-label',
  'poi',
  'park-label',
  'peak',
  'place-province',
  'place-country',
  'place-village',
  'place-town',
  'place-city',
];

/** The imagery layers, split by the slot each draws in (`@core/map/layerSlots`). */
export interface StoneImageryLayers {
  /** Contour lines, each over a dark casing — the `contours` slot. */
  contours: LayerSpecification[];
  /** Road ribbons and the trail network — the `linework` slot. */
  linework: LayerSpecification[];
  /** Contour heights first, then every name — the `labels` slot. */
  labels: LayerSpecification[];
}

/** What to draw over the imagery: names and trails, contours, or both. */
export interface StoneImageryOptions extends StoneStyleOptions {
  /** Roads, trails and names ("Labels on satellite"). Default true. */
  labels?: boolean;
}

/**
 * Contour lines over imagery (#492): the same served lines and interval
 * ladder as the Map base, in the imagery palette — a light line over a soft
 * dark casing. The pair carries its own contrast, so it reads over dark
 * forest (where a lone ochre stroke vanished) and snow or bare rock (where
 * a lone white one did). Major lines stronger, as on the map.
 */
export const IMAGERY_CONTOUR_PAINT = {
  minor: { lineOpacity: 0.55, lineWidth: 0.8, casingOpacity: 0.35, casingWidth: 2.2 },
  major: { lineOpacity: 0.85, lineWidth: 1.3, casingOpacity: 0.45, casingWidth: 3 },
} as const;

/**
 * {@link buildStoneLayers} cut down to what still makes sense over satellite
 * imagery, split into the stack's slots: contours (when a contour source is
 * given) and {@link STONE_IMAGERY_LAYER_KEYS} line work and labels (unless
 * `labels` is false). The caller passes a scheme tuned for imagery — light
 * ink on a dark halo reads over any photo.
 */
export function buildStoneImagerySlots(
  scheme: StoneBasemapScheme,
  options: StoneImageryOptions,
): StoneImageryLayers {
  const keep = new Set(STONE_IMAGERY_LAYER_KEYS.map((k) => `${STONE_LAYER_PREFIX}${k}`));
  const roads = new Set(ROADS.map((r) => `${STONE_LAYER_PREFIX}road-${r.id}`));
  const { base, labels } = buildStoneLayers(scheme, options);
  const named = (options.labels ?? true) ? [...base, ...labels].filter((l) => keep.has(l.id)) : [];

  const contours: LayerSpecification[] = [];
  for (const kind of ['minor', 'major'] as const) {
    const line = base.find((l) => l.id === `${STONE_LAYER_PREFIX}contour-${kind}`);
    if (line?.type !== 'line') continue;
    const look = IMAGERY_CONTOUR_PAINT[kind];
    contours.push(
      {
        ...line,
        id: `${line.id}-casing`,
        paint: {
          'line-color': scheme.halo,
          'line-opacity': look.casingOpacity,
          'line-width': look.casingWidth,
          'line-blur': 0.6,
        },
      },
      {
        ...line,
        paint: {
          'line-color': scheme.contour,
          'line-opacity': look.lineOpacity,
          'line-width': look.lineWidth,
        },
      },
    );
  }
  const contourLabel = labels.find((l) => l.id === `${STONE_LAYER_PREFIX}contour-label`);

  return {
    contours,
    linework: named
      .filter((l) => l.type === 'line')
      .map((l) =>
        roads.has(l.id) ? { ...l, paint: { ...l.paint, 'line-opacity': IMAGERY_ROAD_OPACITY } } : l,
      ),
    // Heights first, so roads, water and place names win any collision.
    labels: [...(contourLabel ? [contourLabel] : []), ...named.filter((l) => l.type !== 'line')],
  };
}

/**
 * The roads, trails and names over imagery as one list, line work under the
 * labels: {@link buildStoneImagerySlots} without contours.
 */
export function buildStoneImageryLayers(
  scheme: StoneBasemapScheme,
  options: Omit<StoneStyleOptions, 'contours'>,
): LayerSpecification[] {
  const { linework, labels } = buildStoneImagerySlots(scheme, options);
  return [...linework, ...labels];
}

/** Road ribbons over imagery: present enough to follow, thin enough to see through. */
export const IMAGERY_ROAD_OPACITY = 0.5;
