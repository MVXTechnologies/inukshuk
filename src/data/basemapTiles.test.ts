import Constants from 'expo-constants';
import { DEFAULT_VECTOR_TILES_URL, vectorTilesUrl } from './basemapTiles';

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
