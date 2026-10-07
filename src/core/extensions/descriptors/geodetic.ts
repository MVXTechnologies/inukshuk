/**
 * Geodetic points: the world's survey marks and benchmarks (`@core/map/geodeticStyle`),
 * one archive built weekly on the NAS (`infra/tiles/nas/geodetic.sh`).
 */
import type { GeodeticLayerFilters } from '@core/geodetic/filter';
import {
  buildGeodeticLayers,
  GEODETIC_SOURCE,
  GEODETIC_SOURCE_MAXZOOM,
  GEODETIC_SOURCE_MINZOOM,
} from '@core/map/geodeticStyle';

import type { ExtensionDescriptor, ExtensionStyleInput } from '../types';

export interface GeodeticStyleInput extends ExtensionStyleInput {
  tiles: string;
  /** The user's attribute filter (`@core/geodetic/filter`); unset = every mark. */
  filters?: GeodeticLayerFilters;
}

export const GEODETIC_EXTENSION: ExtensionDescriptor<GeodeticStyleInput> = {
  label: 'Geodetic points',
  teaser: 'survey marks',
  summary: 'Survey marks and benchmarks',
  dataset: 'geodetic',
  defaults: { show: true, offline: true },
  legacySettings: {
    installedAt: 'geodeticInstalledAt',
    show: 'showGeodetic',
    offline: 'geodeticOffline',
  },
  map: {
    fontWeight: 'regular',
    sourceId: GEODETIC_SOURCE,
    build: (input, ctx) => ({
      sources: {
        [GEODETIC_SOURCE]: {
          type: 'vector',
          tiles: [input.tiles],
          minzoom: GEODETIC_SOURCE_MINZOOM,
          // Built to z13 (`geodetic.sh`); MapLibre overzooms past that.
          maxzoom: GEODETIC_SOURCE_MAXZOOM,
        },
      },
      layers: buildGeodeticLayers({
        theme: ctx.theme,
        font: ctx.font,
        ...(input.filters ? { filters: input.filters } : {}),
      }),
    }),
  },
  offline: {
    // "Offline in your regions" (on by default): the marks are up to ~1 MB a region.
    packs: 'opt-in',
    companion: { minZoom: 5, maxZoom: 13, items: 'marks' },
  },
  credit: {
    label: 'Geodetic points',
    credit:
      "Survey agencies' published data (each mark's card names its source and licence) · " +
      'survey points © OpenStreetMap contributors',
    osmLink: true,
  },
};
