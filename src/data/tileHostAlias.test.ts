import { TransformRequestManager } from '@maplibre/maplibre-react-native';

import { TILE_HOST, TILE_KEY_HOST } from './basemapTiles';
import { installTileHostAlias } from './tileHostAlias';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@maplibre/maplibre-react-native', () => ({
  TransformRequestManager: { addUrlTransform: jest.fn() },
}));

const addUrlTransform = TransformRequestManager.addUrlTransform as jest.Mock;

beforeEach(() => addUrlTransform.mockClear());

it('installs nothing while the Worker lives on the template host', () => {
  expect(installTileHostAlias(TILE_KEY_HOST, TILE_KEY_HOST)).toBe(false);
  expect(addUrlTransform).not.toHaveBeenCalled();
});

it('sends the shipped templates to the moved Worker (#731)', () => {
  expect(TILE_HOST).not.toBe(TILE_KEY_HOST);
  expect(installTileHostAlias()).toBe(true);
  const alias = addUrlTransform.mock.calls[0]?.[0] as { find: string; replace: string };
  expect(`${TILE_KEY_HOST}/basemap/1/2/3.mvt`.replace(new RegExp(alias.find), alias.replace)).toBe(
    `${TILE_HOST}/basemap/1/2/3.mvt`,
  );
});

it('rewrites the template host to the new one once the Worker moves', () => {
  expect(installTileHostAlias(TILE_KEY_HOST, 'https://tiles.example.com')).toBe(true);
  expect(addUrlTransform).toHaveBeenCalledTimes(1);
  const alias = addUrlTransform.mock.calls[0]?.[0] as { find: string; replace: string };
  expect(`${TILE_KEY_HOST}/basemap/1/2/3.mvt`.replace(new RegExp(alias.find), alias.replace)).toBe(
    'https://tiles.example.com/basemap/1/2/3.mvt',
  );
});
