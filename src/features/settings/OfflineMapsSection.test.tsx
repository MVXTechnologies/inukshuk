/** Settings › Offline maps: a trail download's stale parts update as one map. */
import { DEFAULT_GEODETIC_URL } from '@data/basemapTiles';
import type { OfflineRegion } from '@data/offline';
import { currentPackUrls } from '@features/map/offlinePackHealth';
import { useOfflineStore } from '@state/offlineStore';
import { DEFAULT_TILE_URL, useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { OfflineMapsSection } from './OfflineMapsSection';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@data/offline', () => ({ OfflineConnectivityError: class extends Error {} }));

const region = (id: string, label: string, stale: boolean): OfflineRegion => {
  const base: OfflineRegion = {
    id,
    packId: `native-${id}`,
    label,
    basemap: 'map',
    bounds: { minLng: -71.3, minLat: 46.8, maxLng: -71.1, maxLat: 46.9 },
    sizeBytes: 10,
    complete: true,
    format: 'vector',
    maxZoom: 14,
  };
  const urls = currentPackUrls(DEFAULT_TILE_URL, base) ?? {};
  return {
    ...base,
    urls: stale ? { ...urls, 'source:geodetic': DEFAULT_GEODETIC_URL.replace('v=2', 'v=1') } : urls,
  };
};

const redownload = jest.fn(async () => undefined);

beforeEach(() => {
  redownload.mockClear();
  useSettingsStore.setState({ hydrated: true, tileUrl: DEFAULT_TILE_URL, offlineOnly: false });
  useOfflineStore.setState({
    hydrated: true,
    progress: null,
    hydrate: jest.fn(async () => undefined),
    redownload,
    regions: [
      region('trail-gr20-s3-1', 'GR20 · Stage 3 (1/3)', true),
      region('trail-gr20-s3-2', 'GR20 · Stage 3 (2/3)', false),
      region('trail-gr20-s3-3', 'GR20 · Stage 3 (3/3)', true),
      region('k1-map', 'Charlevoix', true),
    ],
  });
});

it("updates every stale part of a trail download from any part's button", async () => {
  const r = await render(
    <PaperProvider>
      <OfflineMapsSection />
    </PaperProvider>,
  );
  await act(async () => {
    fireEvent.press(r.getByLabelText('Update GR20 · Stage 3 (3/3)'));
  });
  await act(async () => {
    fireEvent.press(r.getByText('Download'));
  });
  expect(redownload.mock.calls.map((c) => (c as unknown as [OfflineRegion])[0].id)).toEqual([
    'trail-gr20-s3-1',
    'trail-gr20-s3-3',
  ]);
});
