/**
 * The geodetic-points extension's map layers (Settings → Extensions →
 * Geodetic points), read from our `geodetic.pmtiles` (official marks in
 * source-layer `geodetic`, OpenStreetMap ones in `geodetic_osm`, built by
 * `infra/tiles/nas/geodetic.sh`).
 *
 * - Below z13: small dots in the mark type's colour, already thinned by the
 *   build (a per-mark minzoom ladder), so nothing filters here.
 * - From z13: one symbol per mark — shape and colour = type (3D ◉ carmine,
 *   horizontal ▲ blue, vertical ● teal, GNSS ◆ purple, unclassified · grey),
 *   fill = datum (solid modern, hollow legacy). Every mark shows
 *   (`icon-allow-overlap` + `icon-ignore-placement`: no collision work).
 *   Marks the ladder lets in at z14 ride in z13 tiles with a `z` property; the
 *   z13 layer skips them.
 * - Marks whose drawn position may be ≥ 10 m off (scaled positions, datums
 *   like NAD27 drawn as WGS 84) only from z15, where the card states the ±.
 * - IDs from z16, as optional labels that give way to everything else.
 *
 * MapLibre rules this file keeps (each from an incident): no `["zoom"]` inside
 * `match` / `case` (crashes iOS) — zoom only drives top-level `interpolate`
 * and layer min/max zooms; no `symbol-sort-key` (every symbol is
 * overlap-allowed anyway). Images are named per type × fill × theme
 * (`geodeticIconNames`), registered by the map screen from
 * `assets/map/geodetic/` (`scripts/map/build-geodetic-icons.py`).
 */
import type {
  CircleLayerSpecification,
  LayerSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-react-native';
import { GEODETIC_CATALOG } from '@core/geodetic/catalog';
import type { GeodeticLayerFilters } from '@core/geodetic/filter';
import palette from '@core/geodetic/palette.json';

export type GeodeticTheme = 'light' | 'dark';

/** Style source id of the geodetic tiles. */
export const GEODETIC_SOURCE = 'geodetic';
export const GEODETIC_OFFICIAL_LAYER = 'geodetic';
export const GEODETIC_OSM_LAYER = 'geodetic_osm';
/** Built z5–z13 (`geodetic.sh`); MapLibre overzooms z13. */
export const GEODETIC_SOURCE_MINZOOM = 5;
export const GEODETIC_SOURCE_MAXZOOM = 13;
/** Our position for these may be ≥ 10 m off: drawn from z15 only. */
export const LOW_PRECISION_DECIMETRES = 100;

const TYPES = ['3d', 'h', 'v', 'gnss', 'u'] as const;
export type GeodeticPaletteKey = (typeof TYPES)[number];

export interface GeodeticColors {
  '3d': string;
  h: string;
  v: string;
  gnss: string;
  u: string;
  halo: string;
  label: string;
  labelHalo: string;
}

export function geodeticColors(theme: GeodeticTheme): GeodeticColors {
  return palette[theme];
}

/** Every icon image the layers may ask for, for one theme. */
export function geodeticIconNames(theme: GeodeticTheme): string[] {
  return TYPES.flatMap((k) => [`geodetic-${k}-${theme}`, `geodetic-${k}-o-${theme}`]);
}

const PREFIX = 'geodetic-';
export const GEODETIC_LAYER_IDS = {
  dots: `${PREFIX}dots`,
  osmDots: `${PREFIX}osm-dots`,
  symbols13: `${PREFIX}symbols-13`,
  symbols14: `${PREFIX}symbols-14`,
  symbols15: `${PREFIX}symbols-15`,
  osmSymbols13: `${PREFIX}osm-symbols-13`,
  osmSymbols: `${PREFIX}osm-symbols`,
  labels: `${PREFIX}labels`,
  osmLabels: `${PREFIX}osm-labels`,
} as const;

/** The layers a tap hit-tests (everything that draws a mark). */
export const GEODETIC_TAP_LAYERS: readonly string[] = [
  GEODETIC_LAYER_IDS.dots,
  GEODETIC_LAYER_IDS.osmDots,
  GEODETIC_LAYER_IDS.symbols13,
  GEODETIC_LAYER_IDS.symbols14,
  GEODETIC_LAYER_IDS.symbols15,
  GEODETIC_LAYER_IDS.osmSymbols13,
  GEODETIC_LAYER_IDS.osmSymbols,
];

/** The mark type, defaulting to unclassified for anything unexpected. */
const KIND = ['match', ['get', 'k'], ['3d', 'h', 'v', 'gnss'], ['get', 'k'], 'u'] as const;

/** Datum indexes whose lat/lon, drawn as WGS 84, can land ≥ 10 m away. */
export function lowPrecisionDatums(): number[] {
  return GEODETIC_CATALOG.datums.flatMap((d, i) => (d.wgsOffsetM >= 10 ? [i] : []));
}

export interface GeodeticLayerOptions {
  theme: GeodeticTheme;
  /** Font stack for the ID labels (the map's regular face). */
  font: readonly string[];
  /** Style source id; default {@link GEODETIC_SOURCE}. */
  source?: string;
  /** The user's attribute filter (`@core/geodetic/filter`), ANDed into every layer. */
  filters?: GeodeticLayerFilters;
}

/** AND a user filter into a layer's own filter; drop OSM layers the filter hides. */
function applyUserFilters(
  layers: LayerSpecification[],
  filters: GeodeticLayerFilters | undefined,
): LayerSpecification[] {
  if (!filters) return layers;
  const out: LayerSpecification[] = [];
  for (const layer of layers) {
    const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
    const user = sourceLayer === GEODETIC_OSM_LAYER ? filters.osm : filters.official;
    if (user === 'hidden') continue;
    if (user === null) {
      out.push(layer);
      continue;
    }
    const own = 'filter' in layer ? layer.filter : undefined;
    out.push({
      ...layer,
      filter: (own ? ['all', own, user] : user) as SymbolLayerSpecification['filter'],
    } as LayerSpecification);
  }
  return out;
}

export function buildGeodeticLayers(options: GeodeticLayerOptions): LayerSpecification[] {
  const { theme } = options;
  const source = options.source ?? GEODETIC_SOURCE;
  const c = geodeticColors(theme);
  const dotColor = [
    'match',
    ['get', 'k'],
    '3d',
    c['3d'],
    'h',
    c.h,
    'v',
    c.v,
    'gnss',
    c.gnss,
    c.u,
  ] as unknown as string;

  const dot = (id: string, sourceLayer: string): CircleLayerSpecification => ({
    id,
    type: 'circle',
    source,
    'source-layer': sourceLayer,
    maxzoom: 13,
    filter: ['!', ['has', 'z']],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.4, 9, 1.8, 12, 2.6],
      'circle-color': dotColor,
      'circle-stroke-color': c.halo,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 12, 0.9],
      'circle-stroke-opacity': 0.9,
    },
  });

  const officialIcon = [
    'concat',
    'geodetic-',
    KIND,
    ['case', ['==', ['get', 'l'], 1], '-o', ''],
    `-${theme}`,
  ];
  const osmIcon = ['concat', 'geodetic-', KIND, `-${theme}`];
  const symbol = (
    id: string,
    sourceLayer: string,
    icon: unknown,
    zoom: { minzoom: number; maxzoom?: number },
    filter?: unknown,
  ): SymbolLayerSpecification => ({
    id,
    type: 'symbol',
    source,
    'source-layer': sourceLayer,
    ...zoom,
    ...(filter ? { filter: filter as SymbolLayerSpecification['filter'] } : {}),
    layout: {
      'icon-image': icon as string,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 16, 1, 19, 1.25],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  const precise = [
    'all',
    ['any', ['!', ['has', 'p']], ['<', ['get', 'p'], LOW_PRECISION_DECIMETRES]],
    ['!', ['in', ['get', 'd'], ['literal', lowPrecisionDatums()]]],
  ];

  const label = (id: string, sourceLayer: string, text: unknown): SymbolLayerSpecification => ({
    id,
    type: 'symbol',
    source,
    'source-layer': sourceLayer,
    minzoom: 16,
    layout: {
      'text-field': text as string,
      'text-font': [...options.font],
      'text-size': 11,
      'text-anchor': 'left',
      'text-offset': [0.9, 0],
      'text-max-width': 12,
      'text-optional': true,
    },
    paint: {
      'text-color': c.label,
      'text-halo-color': c.labelHalo,
      'text-halo-width': 1.3,
    },
  });

  return applyUserFilters(
    [
      dot(GEODETIC_LAYER_IDS.osmDots, GEODETIC_OSM_LAYER),
      dot(GEODETIC_LAYER_IDS.dots, GEODETIC_OFFICIAL_LAYER),
      symbol(
        GEODETIC_LAYER_IDS.osmSymbols13,
        GEODETIC_OSM_LAYER,
        osmIcon,
        { minzoom: 13, maxzoom: 14 },
        ['!', ['has', 'z']],
      ),
      symbol(GEODETIC_LAYER_IDS.osmSymbols, GEODETIC_OSM_LAYER, osmIcon, { minzoom: 14 }),
      symbol(
        GEODETIC_LAYER_IDS.symbols13,
        GEODETIC_OFFICIAL_LAYER,
        officialIcon,
        { minzoom: 13, maxzoom: 14 },
        ['!', ['has', 'z']],
      ),
      symbol(
        GEODETIC_LAYER_IDS.symbols14,
        GEODETIC_OFFICIAL_LAYER,
        officialIcon,
        { minzoom: 14, maxzoom: 15 },
        precise,
      ),
      symbol(GEODETIC_LAYER_IDS.symbols15, GEODETIC_OFFICIAL_LAYER, officialIcon, { minzoom: 15 }),
      label(GEODETIC_LAYER_IDS.osmLabels, GEODETIC_OSM_LAYER, ['coalesce', ['get', 'n'], '']),
      label(GEODETIC_LAYER_IDS.labels, GEODETIC_OFFICIAL_LAYER, ['get', 'i']),
    ],
    options.filters,
  );
}
