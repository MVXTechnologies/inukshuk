import Constants from 'expo-constants';
import {
  admin1LabelsUrl,
  DEFAULT_ADMIN1_LABELS_URL,
  DEFAULT_VECTOR_CONTOURS_URL,
  DEFAULT_VECTOR_GLYPHS_URL,
  DEFAULT_VECTOR_PARKS_URL,
  DEFAULT_VECTOR_PEAKS_URL,
  DEFAULT_VECTOR_TILES_URL,
  PARKS_TILES_PUBLISHED,
  vectorBasemapOption,
  vectorContoursUrl,
  vectorGlyphsUrl,
  vectorParksUrl,
  vectorPeaksUrl,
  vectorTilesUrl,
} from './basemapTiles';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const extra = () => Constants.expoConfig?.extra as Record<string, unknown>;

it('defaults to our tile host', () => {
  delete extra().vectorTilesUrl;
  expect(vectorTilesUrl()).toBe(DEFAULT_VECTOR_TILES_URL);
  expect(DEFAULT_VECTOR_TILES_URL).toMatch(/\{z\}\/\{x\}\/\{y\}/);
});

it('honours a build-time override, ignoring an empty one', () => {
  extra().vectorTilesUrl = 'http://127.0.0.1:8080/quebec/{z}/{x}/{y}.mvt';
  expect(vectorTilesUrl()).toBe('http://127.0.0.1:8080/quebec/{z}/{x}/{y}.mvt');
  extra().vectorTilesUrl = '';
  expect(vectorTilesUrl()).toBe(DEFAULT_VECTOR_TILES_URL);
});

it('serves Atkinson glyphs from our host unless turned off', () => {
  delete extra().vectorGlyphsUrl;
  expect(vectorGlyphsUrl()).toBe(DEFAULT_VECTOR_GLYPHS_URL);
  expect(DEFAULT_VECTOR_GLYPHS_URL).toMatch(/\{fontstack\}\/\{range\}\.pbf$/);
  extra().vectorGlyphsUrl = 'https://tiles.example/fonts/{fontstack}/{range}.pbf';
  expect(vectorGlyphsUrl()).toBe('https://tiles.example/fonts/{fontstack}/{range}.pbf');
  extra().vectorGlyphsUrl = 'none';
  expect(vectorGlyphsUrl()).toBeNull();
});

it('reads contour tiles from our Worker unless overridden', () => {
  delete extra().vectorContoursUrl;
  expect(vectorContoursUrl()).toBe(DEFAULT_VECTOR_CONTOURS_URL);
  expect(DEFAULT_VECTOR_CONTOURS_URL).toMatch(/\/contours\/\{z\}\/\{x\}\/\{y\}\.mvt\?v=\d+$/);
  extra().vectorContoursUrl = 'http://127.0.0.1:8787/contours/{z}/{x}/{y}.mvt';
  expect(vectorContoursUrl()).toBe('http://127.0.0.1:8787/contours/{z}/{x}/{y}.mvt');
});

it('reads summit tiles from our Worker unless overridden', () => {
  delete extra().vectorPeaksUrl;
  expect(vectorPeaksUrl()).toBe(DEFAULT_VECTOR_PEAKS_URL);
  expect(DEFAULT_VECTOR_PEAKS_URL).toMatch(/\/peaks\/\{z\}\/\{x\}\/\{y\}\.mvt$/);
  extra().vectorPeaksUrl = 'http://127.0.0.1:8787/peaks/{z}/{x}/{y}.mvt';
  expect(vectorPeaksUrl()).toBe('http://127.0.0.1:8787/peaks/{z}/{x}/{y}.mvt');
  extra().vectorPeaksUrl = '';
  expect(vectorPeaksUrl()).toBe(DEFAULT_VECTOR_PEAKS_URL);
});

it('names no parks tiles until they are published, unless a build points at some', () => {
  delete extra().vectorParksUrl;
  expect(DEFAULT_VECTOR_PARKS_URL).toMatch(/\/parks\/\{z\}\/\{x\}\/\{y\}\.mvt$/);
  // The gate and the default move together: published = our Worker's archive.
  expect(vectorParksUrl()).toBe(PARKS_TILES_PUBLISHED ? DEFAULT_VECTOR_PARKS_URL : null);
  expect('parks' in vectorBasemapOption(false, false)).toBe(PARKS_TILES_PUBLISHED);
  extra().vectorParksUrl = 'http://127.0.0.1:8787/parks/{z}/{x}/{y}.mvt';
  expect(vectorParksUrl()).toBe('http://127.0.0.1:8787/parks/{z}/{x}/{y}.mvt');
  expect(vectorBasemapOption(false, false).parks).toBe(
    'http://127.0.0.1:8787/parks/{z}/{x}/{y}.mvt',
  );
  extra().vectorParksUrl = '';
  expect(vectorParksUrl()).toBe(PARKS_TILES_PUBLISHED ? DEFAULT_VECTOR_PARKS_URL : null);
  delete extra().vectorParksUrl;
});

it('builds the style option from our hosts, summits always, contours only when asked', () => {
  delete extra().vectorTilesUrl;
  delete extra().vectorGlyphsUrl;
  delete extra().vectorContoursUrl;
  delete extra().vectorPeaksUrl;
  expect(vectorBasemapOption(true, false)).toEqual({
    tiles: [DEFAULT_VECTOR_TILES_URL],
    dark: true,
    glyphs: DEFAULT_VECTOR_GLYPHS_URL,
    peaks: DEFAULT_VECTOR_PEAKS_URL,
    admin1: DEFAULT_ADMIN1_LABELS_URL,
    ...(PARKS_TILES_PUBLISHED ? { parks: DEFAULT_VECTOR_PARKS_URL } : {}),
  });
  expect(vectorBasemapOption(false, true).contours).toBe(DEFAULT_VECTOR_CONTOURS_URL);
});

it('reads the province labels from the Pages site unless overridden', () => {
  delete extra().admin1LabelsUrl;
  expect(admin1LabelsUrl()).toBe(DEFAULT_ADMIN1_LABELS_URL);
  // Served from docs/data/ (GitHub Pages), versioned by file name.
  expect(DEFAULT_ADMIN1_LABELS_URL).toBe(
    'https://inukshuk.mvxtechnologies.com/data/admin1-labels-v1.json',
  );
  extra().admin1LabelsUrl = 'http://127.0.0.1:8000/admin1.json';
  expect(admin1LabelsUrl()).toBe('http://127.0.0.1:8000/admin1.json');
  expect(vectorBasemapOption(false, false).admin1).toBe('http://127.0.0.1:8000/admin1.json');
  extra().admin1LabelsUrl = '';
  expect(admin1LabelsUrl()).toBe(DEFAULT_ADMIN1_LABELS_URL);
  delete extra().admin1LabelsUrl;
});
