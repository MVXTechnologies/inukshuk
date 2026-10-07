/**
 * The climbing-crags layers (Explore → Climbing; Settings → Extensions →
 * Climbing crags), in granite ochre (owner decision Q8-A):
 *
 * - every crag, from our `crags.pmtiles` (source-layer `crags`, built by
 *   `infra/tiles/nas/climbing.sh`, already thinned per zoom by the build):
 *   a rounded-square rock badge — hollow when streamed, filled when saved,
 *   grey when access is closed or banned — and the name with its route
 *   count. Badges may overlap only from z12 (two layers: below z12 they
 *   collide and the bigger crag wins);
 * - the SAVED crags, from a local GeoJSON source (`@core/climbing/saved`):
 *   the filled badge always, sector pins from z13, route-start dots from z17
 *   (numbered from z18 where the order is known).
 *
 * MapLibre rules kept (each from an incident): `["zoom"]` only as the input
 * of a top-level `interpolate`/`step` and in layer min/max zooms, never inside
 * `match`/`case` (crashes iOS); `symbol-sort-key` is banded (4 values by
 * route count), never continuous (one draw per distinct key per frame).
 * Images are named per kind × theme (`climbingIconNames`), registered by the
 * screens from `assets/map/climbing/` (`scripts/map/build-crag-icons.py`).
 */
import type {
  CircleLayerSpecification,
  FilterSpecification,
  LayerSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-react-native';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import palette from '@core/climbing/palette.json';
import type { ClimbStyle } from '@core/climbing/crag';
import { STYLE_BITS } from '@core/climbing/crag';

export type ClimbingTheme = 'light' | 'dark';

export interface ClimbingColors {
  crag: string;
  cragInk: string;
  cragSoft: string;
  closed: string;
  halo: string;
  label: string;
  labelHalo: string;
  sector: string;
  bands: [string, string, string, string];
  bandInk: string;
  none: string;
}

export function climbingColors(theme: ClimbingTheme): ClimbingColors {
  return palette[theme] as ClimbingColors;
}

export const CRAG_SOURCE = 'crags';
export const CRAG_SOURCE_LAYER = 'crags';
export const ROUTE_STARTS_SOURCE_LAYER = 'route_starts';
export const SAVED_CRAG_SOURCE = 'climbing-saved';
/** Built z4–z14 (`climbing.sh`); MapLibre overzooms z14. */
export const CRAG_SOURCE_MINZOOM = 4;
export const CRAG_SOURCE_MAXZOOM = 14;

export const CRAG_ICON_KINDS = ['hollow', 'saved', 'closed'] as const;
export type CragIconKind = (typeof CRAG_ICON_KINDS)[number];

export function cragIconName(kind: CragIconKind, theme: ClimbingTheme): string {
  return `crag-${kind}-${theme}`;
}

export function climbingIconNames(theme: ClimbingTheme): string[] {
  return CRAG_ICON_KINDS.map((k) => cragIconName(k, theme));
}

/** Grade facet of the Explore chips: by band, on the rope (else boulder) range. */
export type CragGradeFacet = 'easy' | 'mid' | 'hard';

export interface CragFacets {
  styles?: readonly ClimbStyle[];
  grade?: CragGradeFacet | null;
}

const ROPE_BANDS: Record<CragGradeFacet, [number, number]> = {
  easy: [0, 9], // up to 5.9
  mid: [10, 17], // 5.10–5.11
  hard: [18, 33], // 5.12 and up
};
const BOULDER_BANDS: Record<CragGradeFacet, [number, number]> = {
  easy: [-1, 2],
  mid: [3, 5],
  hard: [6, 17],
};

/**
 * The Explore chips as a layer filter on the tile record: a style bit test
 * (`(st mod 2b) ≥ b`, as expressions have no bitwise AND) and a grade-range
 * overlap. Null = no facet.
 */
export function cragFacetFilter(f: CragFacets): ExpressionSpecification | null {
  const parts: ExpressionSpecification[] = [];
  const styles = f.styles ?? [];
  if (styles.length > 0) {
    parts.push([
      'any',
      ...styles.map((s): ExpressionSpecification => {
        const b = STYLE_BITS[s];
        return ['>=', ['%', ['coalesce', ['get', 'st'], 0], 2 * b], b];
      }),
    ] as ExpressionSpecification);
  }
  if (f.grade) {
    const [rlo, rhi] = ROPE_BANDS[f.grade];
    const [blo, bhi] = BOULDER_BANDS[f.grade];
    parts.push([
      'any',
      ['all', ['has', 'g0'], ['<=', ['get', 'g0'], rhi], ['>=', ['get', 'g1'], rlo]],
      ['all', ['has', 'v0'], ['<=', ['get', 'v0'], bhi], ['>=', ['get', 'v1'], blo]],
    ] as ExpressionSpecification);
  }
  if (parts.length === 0) return null;
  return parts.length === 1
    ? (parts[0] as ExpressionSpecification)
    : (['all', ...parts] as ExpressionSpecification);
}

/** Route-count bands for `symbol-sort-key` (lower draws first, so it wins). */
const SORT_KEY: ExpressionSpecification = [
  'step',
  ['coalesce', ['get', 'r'], 0],
  3,
  10,
  2,
  50,
  1,
  200,
  0,
];

export interface CragTileLayerOptions {
  theme: ClimbingTheme;
  font: readonly string[];
  /** Style source id; default {@link CRAG_SOURCE}. */
  source?: string;
  /** Layer id prefix, so Explore and the map never share ids. */
  prefix?: string;
  /** Saved crags: drawn filled (Explore) or skipped (the map draws them itself). */
  saved?: readonly string[];
  savedMode?: 'filled' | 'skip';
  /** The Explore chips / filter field; ANDed into every layer. */
  filter?: ExpressionSpecification | null;
  /** Hide the labels (dense overviews). Default false. */
  noLabels?: boolean;
}

export function cragLayerIds(prefix = 'crags') {
  return {
    badgesLow: `${prefix}-badges-low`,
    badgesHigh: `${prefix}-badges-high`,
    starts: `${prefix}-starts`,
  };
}

export function buildCragTileLayers(o: CragTileLayerOptions): LayerSpecification[] {
  const source = o.source ?? CRAG_SOURCE;
  const ids = cragLayerIds(o.prefix);
  const c = climbingColors(o.theme);
  const saved = [...(o.saved ?? [])];
  const isSaved: ExpressionSpecification = ['in', ['get', 'i'], ['literal', saved]];
  const closed: ExpressionSpecification = ['>=', ['coalesce', ['get', 'a'], -1], 2];
  const icon: ExpressionSpecification = [
    'case',
    closed,
    cragIconName('closed', o.theme),
    isSaved,
    cragIconName('saved', o.theme),
    cragIconName('hollow', o.theme),
  ];
  const own: ExpressionSpecification[] = [];
  if (o.savedMode === 'skip' && saved.length > 0) own.push(['!', isSaved]);
  if (o.filter) own.push(o.filter);
  const filter = (own.length === 0 ? undefined : own.length === 1 ? own[0] : ['all', ...own]) as
    FilterSpecification | undefined;
  const label: ExpressionSpecification = [
    'format',
    ['get', 'n'],
    {},
    '\n',
    {},
    [
      'case',
      ['>', ['coalesce', ['get', 'r'], 0], 0],
      [
        'concat',
        ['to-string', ['get', 'r']],
        ['case', ['==', ['get', 'r'], 1], ' route', ' routes'],
      ],
      '',
    ],
    { 'font-scale': 0.82 },
  ];
  const badge = (id: string, zoom: { minzoom?: number; maxzoom?: number }, overlap: boolean) =>
    ({
      id,
      type: 'symbol',
      source,
      'source-layer': CRAG_SOURCE_LAYER,
      ...zoom,
      ...(filter ? { filter } : {}),
      layout: {
        'icon-image': icon,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.7, 10, 0.9, 14, 1],
        'icon-allow-overlap': overlap,
        'icon-ignore-placement': false,
        'symbol-sort-key': SORT_KEY,
        ...(o.noLabels
          ? {}
          : {
              'text-field': label,
              'text-font': [...o.font],
              'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 13],
              'text-anchor': 'left',
              'text-justify': 'left',
              'text-offset': [1.25, 0],
              'text-max-width': 10,
              'text-optional': true,
            }),
      },
      paint: {
        'text-color': c.label,
        'text-halo-color': c.labelHalo,
        'text-halo-width': 1.4,
      },
    }) as SymbolLayerSpecification;
  const starts: CircleLayerSpecification = {
    id: ids.starts,
    type: 'circle',
    source,
    'source-layer': ROUTE_STARTS_SOURCE_LAYER,
    minzoom: 17,
    ...(o.savedMode === 'skip' && saved.length > 0
      ? { filter: ['!', ['in', ['get', 'c'], ['literal', saved]]] as FilterSpecification }
      : {}),
    paint: {
      'circle-radius': 4,
      'circle-color': bandColor(c),
      'circle-stroke-color': c.halo,
      'circle-stroke-width': 1.2,
    },
  };
  return [
    badge(ids.badgesLow, { maxzoom: 12 }, false),
    badge(ids.badgesHigh, { minzoom: 12 }, true),
    starts,
  ];
}

function bandColor(c: ClimbingColors): ExpressionSpecification {
  return [
    'match',
    ['coalesce', ['get', 'bd'], -1],
    0,
    c.bands[0],
    1,
    c.bands[1],
    2,
    c.bands[2],
    3,
    c.bands[3],
    c.none,
  ];
}

export const SAVED_LAYER_IDS = {
  starts: 'climbing-saved-starts',
  startNumbers: 'climbing-saved-start-numbers',
  sectors: 'climbing-saved-sectors',
  sectorLabels: 'climbing-saved-sector-labels',
  crags: 'climbing-saved-crags',
} as const;

/** What a tap on the main map hit-tests for a crag (saved first, then streamed). */
export const CRAG_TAP_LAYERS: readonly string[] = [
  SAVED_LAYER_IDS.crags,
  SAVED_LAYER_IDS.sectors,
  'map-crags-badges-low',
  'map-crags-badges-high',
];

export interface SavedCragLayerOptions {
  theme: ClimbingTheme;
  font: readonly string[];
  source?: string;
}

/** The saved crags on the main map (bottom to top: starts, sectors, badges). */
export function buildSavedCragLayers(o: SavedCragLayerOptions): LayerSpecification[] {
  const source = o.source ?? SAVED_CRAG_SOURCE;
  const c = climbingColors(o.theme);
  const kind = (k: string): FilterSpecification => ['==', ['get', 'kind'], k];
  return [
    {
      id: SAVED_LAYER_IDS.starts,
      type: 'circle',
      source,
      minzoom: 17,
      filter: kind('start'),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 17, 4, 19, 8],
        'circle-color': bandColor(c),
        'circle-stroke-color': c.halo,
        'circle-stroke-width': 1.2,
      },
    },
    {
      id: SAVED_LAYER_IDS.startNumbers,
      type: 'symbol',
      source,
      minzoom: 18,
      filter: ['all', ['==', ['get', 'kind'], 'start'], ['has', 'o']],
      layout: {
        'text-field': ['to-string', ['get', 'o']],
        'text-font': [...o.font],
        'text-size': 10,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': c.bandInk },
    },
    {
      id: SAVED_LAYER_IDS.sectors,
      type: 'circle',
      source,
      minzoom: 13,
      filter: kind('sector'),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 4.5, 17, 6.5],
        'circle-color': c.sector,
        'circle-stroke-color': c.halo,
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: SAVED_LAYER_IDS.sectorLabels,
      type: 'symbol',
      source,
      minzoom: 14,
      filter: kind('sector'),
      layout: {
        'text-field': ['get', 'n'],
        'text-font': [...o.font],
        'text-size': 12,
        'text-anchor': 'left',
        'text-offset': [0.8, 0],
        'text-max-width': 9,
        'text-optional': true,
      },
      paint: { 'text-color': c.label, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.4 },
    },
    {
      id: SAVED_LAYER_IDS.crags,
      type: 'symbol',
      source,
      filter: kind('crag'),
      layout: {
        'icon-image': cragIconName('saved', o.theme),
        'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.75, 12, 1],
        'icon-allow-overlap': true,
        'text-field': ['get', 'n'],
        'text-font': [...o.font],
        'text-size': 13,
        'text-anchor': 'left',
        'text-offset': [1.25, 0],
        'text-max-width': 10,
        'text-optional': true,
      },
      paint: { 'text-color': c.label, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.5 },
    },
  ];
}
