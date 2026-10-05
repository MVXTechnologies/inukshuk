/**
 * The "Tide stations" overlay's map layers, read from our `tides.pmtiles`
 * (source-layer `tide_stations`, built by `infra/tiles/nas/tides.sh`):
 * NOAA CO-OPS, SHOM, Kartverket and JMA stations. Marine teal (owner Q3a);
 * blue stays reserved for "you".
 *
 * - z3–z8: small dots — filled for a live gauge, hollow for predictions-only,
 *   secondary or historic stations.
 * - from z8: the station symbol (filled / hollow rounded square with a tide
 *   staff), every station shown (overlap allowed: a few thousand worldwide).
 * - from z10: the station name, an optional label that gives way.
 *
 * MapLibre rules this file keeps (each from an incident): no `["zoom"]`
 * inside `match` / `case` (crashes iOS) — zoom only drives top-level
 * `interpolate` and layer min/max zooms; no `symbol-sort-key`.
 */
import type {
  CircleLayerSpecification,
  LayerSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-react-native';
import palette from '@core/tides/palette.json';

export type TideTheme = 'light' | 'dark';

export const TIDE_SOURCE = 'tides';
export const TIDE_SOURCE_LAYER = 'tide_stations';
/** Built z3–z10 (`tides.sh`); MapLibre overzooms past that. */
export const TIDE_SOURCE_MINZOOM = 3;
export const TIDE_SOURCE_MAXZOOM = 10;

export interface TideColors {
  station: string;
  stationFill: string;
  tidal: string;
  halo: string;
  label: string;
  labelHalo: string;
}

export function tideColors(theme: TideTheme): TideColors {
  return palette[theme];
}

export const TIDE_LAYER_IDS = {
  dots: 'tides-dots',
  symbols: 'tides-symbols',
  labels: 'tides-labels',
} as const;

/**
 * Canadian (CHS) stations: a client-side GeoJSON source the phone fills from
 * CHS IWLS itself (`@core/tides/chs`), drawn by the same layers under these
 * ids — one tide layer to the user, nothing CHS in our tiles.
 */
export const CHS_TIDE_SOURCE = 'tides-chs';
export const CHS_TIDE_LAYER_IDS = {
  dots: 'tides-chs-dots',
  symbols: 'tides-chs-symbols',
  labels: 'tides-chs-labels',
} as const;

/** The layers a tap hit-tests (ours and CHS's). */
export const TIDE_TAP_LAYERS: readonly string[] = [
  TIDE_LAYER_IDS.dots,
  TIDE_LAYER_IDS.symbols,
  CHS_TIDE_LAYER_IDS.dots,
  CHS_TIDE_LAYER_IDS.symbols,
];

/** Every icon image the layers may ask for, for one theme. */
export function tideIconNames(theme: TideTheme): string[] {
  return [`tide-gauge-${theme}`, `tide-pred-${theme}`];
}

const IS_GAUGE = ['==', ['get', 'k'], 'gauge'];

export interface TideLayerOptions {
  theme: TideTheme;
  font: readonly string[];
  source?: string;
  /** A GeoJSON source (no source-layer) drawn under the CHS layer ids. */
  chs?: boolean;
}

export function buildTideLayers(options: TideLayerOptions): LayerSpecification[] {
  const { theme } = options;
  const source = options.source ?? (options.chs ? CHS_TIDE_SOURCE : TIDE_SOURCE);
  const ids = options.chs ? CHS_TIDE_LAYER_IDS : TIDE_LAYER_IDS;
  const sourceLayer = options.chs ? {} : { 'source-layer': TIDE_SOURCE_LAYER };
  const c = tideColors(theme);

  const dots: CircleLayerSpecification = {
    id: ids.dots,
    type: 'circle',
    source,
    ...sourceLayer,
    maxzoom: 8,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 6, 3, 8, 4],
      'circle-color': ['case', IS_GAUGE, c.station, c.stationFill] as unknown as string,
      'circle-stroke-color': c.station,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 8, 1.6],
    },
  };

  const symbols: SymbolLayerSpecification = {
    id: ids.symbols,
    type: 'symbol',
    source,
    ...sourceLayer,
    minzoom: 8,
    layout: {
      'icon-image': [
        'case',
        IS_GAUGE,
        `tide-gauge-${theme}`,
        `tide-pred-${theme}`,
      ] as unknown as string,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.75, 12, 1, 16, 1.15],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  };

  const labels: SymbolLayerSpecification = {
    id: ids.labels,
    type: 'symbol',
    source,
    ...sourceLayer,
    minzoom: 10,
    layout: {
      'text-field': ['get', 'n'] as unknown as string,
      'text-font': [...options.font],
      'text-size': 12,
      'text-anchor': 'top',
      'text-offset': [0, 1.15],
      'text-max-width': 10,
      'text-optional': true,
    },
    paint: {
      'text-color': c.label,
      'text-halo-color': c.labelHalo,
      'text-halo-width': 1.4,
    },
  };

  return [dots, symbols, labels];
}
