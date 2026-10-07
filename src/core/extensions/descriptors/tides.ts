/**
 * Tide stations: NOAA CO-OPS, SHOM, Kartverket and JMA gauges from our
 * archive (`infra/tiles/nas/tides.sh`), plus Canada's stations fetched live
 * from CHS by the phone (never our tiles: owner decision). `@core/map/tideStyle`.
 */
import type { FeatureCollection } from 'geojson';

import {
  buildTideLayers,
  CHS_TIDE_SOURCE,
  TIDE_SOURCE,
  TIDE_SOURCE_MAXZOOM,
  TIDE_SOURCE_MINZOOM,
} from '@core/map/tideStyle';

import type { ExtensionDescriptor, ExtensionStyleInput } from '../types';

export interface TideStyleInput extends ExtensionStyleInput {
  tiles: string;
  /** CHS (Canada) stations the phone fetched live from CHS (`@core/tides/chs`). */
  chs?: FeatureCollection | null;
}

export const TIDES_EXTENSION: ExtensionDescriptor<TideStyleInput> = {
  label: 'Tide stations',
  teaser: 'tide stations',
  summary: 'Tide gauges and tidal levels',
  dataset: 'tides',
  defaults: { show: true, offline: false },
  legacySettings: { installedAt: 'tidesInstalledAt', show: 'showTideStations' },
  map: {
    fontWeight: 'regular',
    sourceId: TIDE_SOURCE,
    // A station symbol draws over the survey marks round its harbour.
    build: (input, ctx) => ({
      sources: {
        [TIDE_SOURCE]: {
          type: 'vector',
          tiles: [input.tiles],
          minzoom: TIDE_SOURCE_MINZOOM,
          // Built to z10 (`tides.sh`); MapLibre overzooms past that.
          maxzoom: TIDE_SOURCE_MAXZOOM,
        },
        ...(input.chs ? { [CHS_TIDE_SOURCE]: { type: 'geojson', data: input.chs } } : {}),
      },
      layers: [
        ...buildTideLayers({ theme: ctx.theme, font: ctx.font }),
        ...(input.chs ? buildTideLayers({ theme: ctx.theme, font: ctx.font, chs: true }) : []),
      ],
    }),
  },
  offline: {
    // A few kB per region (the archive stops at z10 and overzooms): always
    // carried once installed, so the overlay works offline in every new region.
    packs: 'installed',
  },
  credit: {
    label: 'Tide stations',
    credit:
      'NOAA/NOS/CO-OPS · Shom, 2025. Références Altimétriques Maritimes, ' +
      'doi:10.17183/MAREE_COURANTS_RAM (Licence Ouverte 2.0) · © Kartverket (CC BY 4.0) · ' +
      '出典：気象庁 (JMA) · Canada: contains data of the Canadian Hydrographic Service (DFO), ' +
      'fetched live by this device · Not for navigation',
  },
};
