import Constants from 'expo-constants';
import {
  DEFAULT_VECTOR_CONTOURS_URL,
  DEFAULT_VECTOR_GLYPHS_URL,
  DEFAULT_VECTOR_TILES_URL,
  vectorBasemapOption,
  vectorContoursUrl,
  vectorGlyphsUrl,
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

it('builds the style option from our hosts, contours only when asked', () => {
  delete extra().vectorTilesUrl;
  delete extra().vectorGlyphsUrl;
  delete extra().vectorContoursUrl;
  expect(vectorBasemapOption(true, false)).toEqual({
    tiles: [DEFAULT_VECTOR_TILES_URL],
    dark: true,
    glyphs: DEFAULT_VECTOR_GLYPHS_URL,
  });
  expect(vectorBasemapOption(false, true).contours).toBe(DEFAULT_VECTOR_CONTOURS_URL);
});
