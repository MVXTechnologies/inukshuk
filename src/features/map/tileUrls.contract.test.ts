/**
 * ─── FROZEN CONTRACT: the tile URL templates (architecture review P1-2) ───
 *
 * MapLibre's offline packs store every tile, glyph range and sprite under the
 * EXACT URL the style named — host, path and `?v=` query alike. Change any
 * string below and every offline region on every phone that holds the old
 * one is orphaned: in the field, the map goes blank where the user thought it
 * was downloaded. An OTA does that to every user at once.
 *
 * So this test pins every URL template the app builds a map from, by building
 * the real styles (offline packs and the live map) and reading their URLs
 * back. If it fails, do NOT just paste the new value in. Changing a template
 * is a deliberate, reviewed act — read `docs/design/tile-urls.md` first:
 * - moving the Worker to another HOST: change `TILE_HOST` only (one line);
 *   the templates keep `TILE_KEY_HOST` as their cache key and MapLibre's
 *   request transform sends the fetches to the new host. No pack breaks.
 * - a new tile SCHEMA (`?v=` / path): packs record the templates they were
 *   built with, the offline-maps list flags the old ones "needs update" and
 *   offers the re-download. Say so in the release notes.
 * Then update the expected value here in the same PR, and say why.
 */
import { TERRARIUM_TILE_SOURCE } from '@core/geo/terrain';
import { MARINE_LAYER_IDS } from '@core/geo/marineLayers';
import { styleUrlTemplates } from '@core/map/tileUrls';
import {
  DEFAULT_ADMIN1_LABELS_URL,
  DEFAULT_GEODETIC_URL,
  DEFAULT_TIDES_URL,
  DEFAULT_VECTOR_CONTOURS_URL,
  DEFAULT_VECTOR_GLYPHS_URL,
  DEFAULT_VECTOR_PARKS_URL,
  DEFAULT_VECTOR_PEAKS_URL,
  DEFAULT_VECTOR_TILES_URL,
  geodeticTilesUrl,
  imageryContoursOption,
  tideTilesUrl,
  TILE_HOST,
  TILE_KEY_HOST,
  vectorBasemapOption,
  vectorGlyphsUrl,
} from '@data/basemapTiles';
import { DEFAULT_TILE_URL } from '@state/settingsStore';

import { buildGeodeticPackStyle, buildOsmStyle } from './mapStyle';
import { packStyle } from './packStyle';

// No build-time overrides: the shipped defaults are what packs are keyed by.
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const extensions = () => ({
  geodetic: { tiles: geodeticTilesUrl() ?? '', dark: false },
  tides: { tiles: tideTilesUrl() ?? '', dark: false },
});

it('pins the tile host: the template (cache-key) host and where requests go', () => {
  expect(TILE_KEY_HOST).toBe('https://inukshuk-tiles.marcandre-vigneault-96.workers.dev');
  // Moving the Worker changes THIS one (and only this one).
  expect(TILE_HOST).toBe('https://inukshuk-tiles.marcandre-vigneault-96.workers.dev');
});

it('pins every default template', () => {
  expect({
    DEFAULT_VECTOR_TILES_URL,
    DEFAULT_VECTOR_GLYPHS_URL,
    DEFAULT_VECTOR_CONTOURS_URL,
    DEFAULT_VECTOR_PEAKS_URL,
    DEFAULT_VECTOR_PARKS_URL,
    DEFAULT_GEODETIC_URL,
    DEFAULT_TIDES_URL,
    DEFAULT_ADMIN1_LABELS_URL,
    DEFAULT_TILE_URL,
    TERRARIUM: TERRARIUM_TILE_SOURCE.template,
  }).toEqual({
    DEFAULT_VECTOR_TILES_URL:
      'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/basemap/{z}/{x}/{y}.mvt',
    DEFAULT_VECTOR_GLYPHS_URL:
      'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/fonts/{fontstack}/{range}.pbf',
    DEFAULT_VECTOR_CONTOURS_URL:
      'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/contours/{z}/{x}/{y}.mvt?v=2',
    DEFAULT_VECTOR_PEAKS_URL:
      'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/peaks/{z}/{x}/{y}.mvt',
    DEFAULT_VECTOR_PARKS_URL:
      'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/parks/{z}/{x}/{y}.mvt',
    DEFAULT_GEODETIC_URL:
      'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/geodetic/{z}/{x}/{y}.mvt?v=2',
    DEFAULT_TIDES_URL:
      'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/tides/{z}/{x}/{y}.mvt?v=1',
    DEFAULT_ADMIN1_LABELS_URL: 'https://inukshuk.mvxtechnologies.com/data/admin1-labels-v1.json',
    DEFAULT_TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    TERRARIUM: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  });
});

describe('offline pack styles (every published extension on)', () => {
  it('pins a vector map pack', () => {
    expect(styleUrlTemplates(packStyle(DEFAULT_TILE_URL, 'map', 'vector', 'all'))).toEqual({
      glyphs:
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/fonts/{fontstack}/{range}.pbf',
      'source:basemap-vector':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/basemap/{z}/{x}/{y}.mvt',
      'source:basemap-contours':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/contours/{z}/{x}/{y}.mvt?v=2',
      'source:basemap-peaks':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/peaks/{z}/{x}/{y}.mvt',
      'source:basemap-parks':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/parks/{z}/{x}/{y}.mvt',
      'source:basemap-admin1': 'https://inukshuk.mvxtechnologies.com/data/admin1-labels-v1.json',
      'source:geodetic':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/geodetic/{z}/{x}/{y}.mvt?v=2',
      'source:tides':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/tides/{z}/{x}/{y}.mvt?v=1',
    });
  });

  it('pins a raster map pack (packs from before the vector map)', () => {
    expect(styleUrlTemplates(packStyle(DEFAULT_TILE_URL, 'map', 'raster', 'all'))).toEqual({
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      'source:osm': 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      'source:geodetic':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/geodetic/{z}/{x}/{y}.mvt?v=2',
      'source:tides':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/tides/{z}/{x}/{y}.mvt?v=1',
    });
  });

  it('pins a satellite pack', () => {
    expect(styleUrlTemplates(packStyle(DEFAULT_TILE_URL, 'satellite', 'raster', 'all'))).toEqual({
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      'source:osm':
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      'source:geodetic':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/geodetic/{z}/{x}/{y}.mvt?v=2',
      'source:tides':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/tides/{z}/{x}/{y}.mvt?v=1',
    });
  });

  it('pins a geodetic companion pack', () => {
    expect(
      styleUrlTemplates(buildGeodeticPackStyle(geodeticTilesUrl() ?? '', vectorGlyphsUrl())),
    ).toEqual({
      glyphs:
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/fonts/{fontstack}/{range}.pbf',
      'source:geodetic':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/geodetic/{z}/{x}/{y}.mvt?v=2',
    });
  });

  it('carries no sprite: nothing outside the templates above is keyed', () => {
    for (const style of [
      packStyle(DEFAULT_TILE_URL, 'map', 'vector', 'all'),
      packStyle(DEFAULT_TILE_URL, 'satellite', 'raster', 'all'),
    ]) {
      expect(style.sprite).toBeUndefined();
    }
  });
});

describe('the live map (every layer on)', () => {
  it('pins the map: vector base, contours, summits, parks, labels, relief DEM, marine, extensions', () => {
    expect(
      styleUrlTemplates(
        buildOsmStyle(DEFAULT_TILE_URL, 'map', true, {
          vectorBasemap: vectorBasemapOption(false, true),
          tiltRelief: 'natural',
          marineLayers: MARINE_LAYER_IDS,
          ...extensions(),
        }),
      ),
    ).toEqual({
      glyphs:
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/fonts/{fontstack}/{range}.pbf',
      'source:basemap-vector':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/basemap/{z}/{x}/{y}.mvt',
      'source:basemap-contours':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/contours/{z}/{x}/{y}.mvt?v=2',
      'source:basemap-peaks':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/peaks/{z}/{x}/{y}.mvt',
      'source:basemap-parks':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/parks/{z}/{x}/{y}.mvt',
      'source:basemap-admin1': 'https://inukshuk.mvxtechnologies.com/data/admin1-labels-v1.json',
      'source:dem': 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
      'source:geodetic':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/geodetic/{z}/{x}/{y}.mvt?v=2',
      'source:tides':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/tides/{z}/{x}/{y}.mvt?v=1',
      'source:marine-bathymetry':
        'https://nonna-geoserver.data.chs-shc.ca/geoserver/nonna/wms?service=WMS&version=1.3.0&request=GetMap&layers=nonna%3ANONNA%20100%2Cnonna%3ANONNA%2010&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png&transparent=true',
      'source:marine-seamarks': 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    });
  });

  it('pins satellite with served contours', () => {
    expect(
      styleUrlTemplates(
        buildOsmStyle(DEFAULT_TILE_URL, 'satellite', true, {
          imageryContours: imageryContoursOption(),
          ...extensions(),
        }),
      ),
    ).toEqual({
      glyphs:
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/fonts/{fontstack}/{range}.pbf',
      'source:osm':
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      'source:basemap-contours':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/contours/{z}/{x}/{y}.mvt?v=2',
      'source:geodetic':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/geodetic/{z}/{x}/{y}.mvt?v=2',
      'source:tides':
        'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/tides/{z}/{x}/{y}.mvt?v=1',
    });
  });
});
