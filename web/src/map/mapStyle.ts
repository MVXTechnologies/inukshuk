import type {
  BackgroundLayerSpecification,
  FilterSpecification,
  LayerSpecification,
  LineLayerSpecification,
  RasterLayerSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl';

import type { Theme } from '@/ui/theme';

/**
 * The playground's re-creation of the app's map look.
 *
 * ## Why this file exists at all
 *
 * `src/features/map/mapStyle.ts` cannot be imported here: it types itself
 * against `@maplibre/maplibre-react-native` (native-only) and reads
 * `MapBasemap` out of `@state/mapStore` (a Zustand store full of RN concerns).
 * Its *numbers*, though, are the whole point of the playground — they were
 * measured on device, over four capture cases, in both themes, and the owner
 * signed off on them. So they are copied here VERBATIM with their provenance,
 * and the app file stays the source of truth.
 *
 * If you change a number here, you are proposing a change to the app. If you
 * change one there, copy it here or the playground stops being a baseline.
 *
 * ## The one deliberate divergence
 *
 * The app's basemap is RASTER (OSM tiles), so its weather mute is a
 * `raster-saturation: -0.85` wash on the tile pixels plus a semi-opaque dim.
 * The playground's basemap is the OpenFreeMap VECTOR style, where there is no
 * global saturation knob — so only the dim survives, and it does the whole
 * job. Everything downstream of the mute (the reference overlay, the drape
 * opacities) is unchanged, which is what actually gets judged.
 */

/** Weather drape ids. Two slots so a frame change can crossfade — see
 *  `@core/weather/weatherCrossfade` for why one source is not enough. */
export const DRAPE_SLOT_IDS = ['weather-drape-a', 'weather-drape-b'] as const;
export const WEATHER_DIM_ID = 'weather-dim';
export const TRACK_SOURCE_ID = 'gpx-tracks';

/** The vector source id inside every OpenFreeMap style (OpenMapTiles schema). */
const OMT_SOURCE = 'openmaptiles';

/**
 * Ink for the reference overlay that redraws geography ABOVE the colour drapes.
 * Copied verbatim from `src/features/map/mapStyle.ts` (WEATHER_REFERENCE_INK).
 *
 * Owner review, 2026-08-13: with a weather layer running you could not tell
 * where the coast was — "it should be much easier to differentiate coasts and
 * features, have lines thicker". A single hairline loses twice: once against
 * the drape (a full-spectrum ramp — no single ink reads over all of it) and
 * again against the wind streaks drawn on top.
 *
 * So each reference line is a CASING + CORE pair in opposite polarity. The pair
 * brings its own contrast, so it reads identically over blue, green or magenta
 * drape. Alphas are high on purpose: this overlay only exists while a drape is
 * up, and under a drape "subtle" means "invisible".
 */
const WEATHER_REFERENCE_INK = {
  light: {
    coast: 'rgba(11, 45, 74, 0.95)',
    road: 'rgba(60, 48, 38, 0.80)',
    casing: 'rgba(255, 255, 255, 0.85)',
    casingAdd: 2.6,
  },
  dark: {
    coast: 'rgba(190, 224, 248, 0.95)',
    road: 'rgba(236, 222, 200, 0.78)',
    casing: 'rgba(6, 11, 16, 0.85)',
    casingAdd: 2.6,
  },
} as const;

/**
 * Core stroke widths by zoom, roughly double the hairlines they replaced
 * (water was 0.6/1.1/1.7). Water carries the shape of the land so it leads;
 * roads stay a step behind so the coast still wins the eye when the two run
 * together along a waterfront. Verbatim from the app.
 */
const WATER_LINE_W = { z5: 1.4, z10: 2.4, z14: 3.4 } as const;
const ROAD_LINE_W = { z5: 0.8, z10: 1.4, z14: 2.2 } as const;

type LineWidth = NonNullable<NonNullable<LineLayerSpecification['paint']>['line-width']>;

/**
 * A zoom-interpolated `line-width`, optionally widened by a fixed casing
 * allowance. The casing is a constant amount wider at every zoom rather than a
 * multiple: a proportional casing vanishes at low zoom, which is exactly where
 * the coastline most needs help.
 */
function widthAtZoom(w: { z5: number; z10: number; z14: number }, add: number): LineWidth {
  return ['interpolate', ['linear'], ['zoom'], 5, w.z5 + add, 10, w.z10 + add, 14, w.z14 + add];
}

/**
 * The weather-mode basemap dim: a semi-opaque neutral screen between the
 * basemap and the drape. A `background` layer paints the whole viewport
 * regardless of where it sits in the list, so — exactly as on native — it works
 * as a screen over everything declared before it.
 */
export function weatherDimLayer(theme: Theme): BackgroundLayerSpecification {
  return {
    id: WEATHER_DIM_ID,
    type: 'background',
    paint: {
      'background-color': theme.dimColor,
      'background-opacity': theme.dimOpacity,
    },
  };
}

/** One crossfade slot for the weather drape image. */
export function drapeLayer(slot: 0 | 1, opacity: number): RasterLayerSpecification {
  return {
    id: DRAPE_SLOT_IDS[slot],
    type: 'raster',
    source: DRAPE_SLOT_IDS[slot],
    paint: {
      'raster-opacity': opacity,
      // The drape is a smooth continuous field; MapLibre's default nearest
      // resampling on an upscaled ImageSource shows the GetMap pixel grid.
      'raster-resampling': 'linear',
      'raster-fade-duration': 0,
      'raster-opacity-transition': { duration: 220, delay: 0 },
    },
  };
}

/**
 * Labels + coastline reference pass, drawn ABOVE the drape (weather wave B,
 * owner: "names and coastlines readable above the colors, like Windy").
 *
 * On native this needs its own OpenFreeMap vector source, because the basemap
 * there is raster. Here the basemap IS an OpenFreeMap vector style, so the
 * pass reuses the style's existing `openmaptiles` source and the same
 * `water` / `transportation` / `place` source-layers — identical data,
 * one fewer network source.
 */
export function referenceOverlayLayers(theme: Theme, roads: boolean): LayerSpecification[] {
  const ref = theme.dark ? WEATHER_REFERENCE_INK.dark : WEATHER_REFERENCE_INK.light;
  const ink = theme.dark ? '#FFFFFF' : '#20303C';
  const halo = theme.dark ? 'rgba(12, 16, 20, 0.92)' : 'rgba(255, 255, 255, 0.94)';

  // Only the top three road classes, from z9. The basemap already draws every
  // street; redrawing all of them above the drape would trade one unreadable
  // image for a busier one. This pass restores ORIENTATION, not detail.
  const roadFilter: FilterSpecification = [
    'in',
    ['get', 'class'],
    ['literal', ['motorway', 'trunk', 'primary']],
  ];

  const roadLayers: LayerSpecification[] = roads
    ? [
        {
          id: 'overlay-road-casing',
          type: 'line',
          source: OMT_SOURCE,
          'source-layer': 'transportation',
          minzoom: 9,
          filter: roadFilter,
          paint: {
            'line-color': ref.casing,
            'line-width': widthAtZoom(ROAD_LINE_W, ref.casingAdd),
            'line-blur': 0.4,
          },
        },
        {
          id: 'overlay-road-line',
          type: 'line',
          source: OMT_SOURCE,
          'source-layer': 'transportation',
          minzoom: 9,
          filter: roadFilter,
          paint: {
            'line-color': ref.road,
            'line-width': widthAtZoom(ROAD_LINE_W, 0),
          },
        },
      ]
    : [];

  const townLabels: SymbolLayerSpecification = {
    id: 'overlay-town-labels',
    type: 'symbol',
    source: OMT_SOURCE,
    'source-layer': 'place',
    minzoom: 9,
    filter: ['in', ['get', 'class'], ['literal', ['town', 'village']]],
    layout: {
      'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 14, 13.5],
      'text-max-width': 8,
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
    },
    paint: {
      'text-color': ink,
      'text-halo-color': halo,
      'text-halo-width': 1.4,
      'text-halo-blur': 0.4,
    },
  };

  const cityLabels: SymbolLayerSpecification = {
    id: 'overlay-city-labels',
    type: 'symbol',
    source: OMT_SOURCE,
    'source-layer': 'place',
    minzoom: 3,
    filter: ['==', ['get', 'class'], 'city'],
    layout: {
      'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11.5, 8, 13, 12, 16],
      'text-max-width': 8,
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
    },
    paint: {
      'text-color': ink,
      'text-halo-color': halo,
      'text-halo-width': 1.6,
      'text-halo-blur': 0.4,
    },
  };

  // Water outlines first, then towns, then cities — MapLibre resolves symbol
  // collisions top-layer-first, so cities win crowded spots.
  return [
    {
      id: 'overlay-water-casing',
      type: 'line',
      source: OMT_SOURCE,
      'source-layer': 'water',
      paint: {
        'line-color': ref.casing,
        'line-width': widthAtZoom(WATER_LINE_W, ref.casingAdd),
        'line-blur': 0.4,
      },
    },
    {
      id: 'overlay-water-line',
      type: 'line',
      source: OMT_SOURCE,
      'source-layer': 'water',
      paint: {
        'line-color': ref.coast,
        'line-width': widthAtZoom(WATER_LINE_W, 0),
      },
    },
    ...roadLayers,
    townLabels,
    cityLabels,
  ];
}

/**
 * Imported GPX tracks. Cased like the reference lines and for the same reason:
 * a track has to stay legible over a full-spectrum weather drape.
 */
export function trackLayers(theme: Theme): LayerSpecification[] {
  return [
    {
      id: 'track-casing',
      type: 'line',
      source: TRACK_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': theme.dark ? 'rgba(6, 11, 16, 0.85)' : 'rgba(255, 255, 255, 0.9)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 4.4, 14, 7.6],
      },
    },
    {
      id: 'track-line',
      type: 'line',
      source: TRACK_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#F2643C'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2, 14, 4],
      },
    },
  ];
}
