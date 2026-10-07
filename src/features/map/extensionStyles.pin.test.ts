/**
 * Pins the exact style JSON the extensions put on the map and into offline
 * packs, for every combination of extension state (architecture review P1-3:
 * the extension registry must render identically to the hand-wired code it
 * replaced). Each entry is the SHA-256 of `JSON.stringify(style)`, so key
 * ORDER counts as well as content: a source, layer, glyph host or font that
 * moves, appears or disappears changes a hash.
 *
 * If a hash changes on purpose (a new layer, a restyle), say why in the PR
 * and update the snapshot. If it changes during a refactor, the refactor is
 * not behaviour-neutral.
 */
import { createHash } from 'crypto';

import { buildGeodeticFilters, DEFAULT_GEODETIC_FILTER } from '@core/geodetic/filter';
import type { Basemap, PackFormat } from '@core/geo/tiles';
import {
  geodeticTilesUrl,
  tideTilesUrl,
  vectorBasemapOption,
  vectorGlyphsUrl,
} from '@data/basemapTiles';
import { DEFAULT_TILE_URL, useSettingsStore } from '@state/settingsStore';

import { buildGeodeticPackStyle, buildOsmStyle } from './mapStyle';
import { packStyle, type PackExtensions } from './packStyle';
import { setExtensionsForTest } from './extensionStyles.testUtils';

// No build-time overrides: the shipped defaults.
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const hash = (style: unknown): string =>
  createHash('sha256').update(JSON.stringify(style)).digest('hex').slice(0, 16);

const PACK_KINDS: readonly [Basemap, PackFormat][] = [
  ['map', 'vector'],
  ['map', 'raster'],
  ['satellite', 'raster'],
];

const CHS: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-71.2, 46.8] },
      properties: { id: 'chs-1', name: 'Québec' },
    },
  ],
};

beforeEach(() => {
  useSettingsStore.setState({ hydrated: true });
});

it('offline pack styles, every extension state × pack kind × mode', () => {
  const out: Record<string, string> = {};
  for (const geoInstalled of [false, true]) {
    for (const geoOffline of [false, true]) {
      for (const geoShown of [false, true]) {
        for (const tidesInstalled of [false, true]) {
          for (const tidesShown of [false, true]) {
            setExtensionsForTest({
              geoInstalled,
              geoOffline,
              geoShown,
              tidesInstalled,
              tidesShown,
            });
            for (const [basemap, format] of PACK_KINDS) {
              for (const mode of ['settings', 'all', 'none'] as PackExtensions[]) {
                const key = [
                  `geo:${geoInstalled ? 'in' : 'out'}`,
                  `off:${geoOffline}`,
                  `show:${geoShown}`,
                  `tides:${tidesInstalled ? 'in' : 'out'}`,
                  `show:${tidesShown}`,
                  `${basemap}/${format}`,
                  mode,
                ].join(' ');
                out[key] = hash(packStyle(DEFAULT_TILE_URL, basemap, format, mode));
              }
            }
          }
        }
      }
    }
  }
  expect(out).toMatchSnapshot();
});

it('the live map, every extension option × base map', () => {
  const geoTiles = geodeticTilesUrl() ?? '';
  const tideTiles = tideTilesUrl() ?? '';
  const glyphs = vectorGlyphsUrl() ?? undefined;
  const filters = buildGeodeticFilters({ ...DEFAULT_GEODETIC_FILTER, hasHeights: true });
  const geodetic = {
    none: {},
    plain: { geodetic: { tiles: geoTiles, dark: false } },
    full: {
      geodetic: { tiles: geoTiles, dark: true, filters, ...(glyphs ? { glyphs } : {}) },
    },
  };
  const tides = {
    none: {},
    plain: { tides: { tiles: tideTiles, dark: false } },
    chsNull: { tides: { tiles: tideTiles, dark: false, chs: null } },
    full: { tides: { tiles: tideTiles, dark: true, chs: CHS, ...(glyphs ? { glyphs } : {}) } },
  };
  const bases = {
    vector: (o: object) =>
      buildOsmStyle(DEFAULT_TILE_URL, 'map', true, {
        vectorBasemap: vectorBasemapOption(false, true),
        ...o,
      }),
    vectorDark: (o: object) =>
      buildOsmStyle(DEFAULT_TILE_URL, 'map', false, {
        vectorBasemap: vectorBasemapOption(true, false),
        ...o,
      }),
    raster: (o: object) => buildOsmStyle(DEFAULT_TILE_URL, 'map', true, o),
    satellite: (o: object) => buildOsmStyle(DEFAULT_TILE_URL, 'satellite', false, o),
  };
  const out: Record<string, string> = {};
  for (const [g, gOpt] of Object.entries(geodetic)) {
    for (const [t, tOpt] of Object.entries(tides)) {
      for (const [b, build] of Object.entries(bases)) {
        out[`geo:${g} tides:${t} ${b}`] = hash(build({ ...gOpt, ...tOpt }));
      }
    }
  }
  expect(out).toMatchSnapshot();
});

it('the geodetic companion pack style', () => {
  const tiles = geodeticTilesUrl() ?? '';
  expect({
    withGlyphs: hash(buildGeodeticPackStyle(tiles, vectorGlyphsUrl())),
    noGlyphs: hash(buildGeodeticPackStyle(tiles, null)),
  }).toMatchSnapshot();
});
