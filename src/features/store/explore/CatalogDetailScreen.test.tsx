/**
 * The map detail page (#447): content from the item and its source, and the
 * one primary action per install state — Download · Free (folder dialog),
 * Open on map, Update — plus cancel while a download runs.
 */
import type { MapDocument } from '@core/models';
import { cancelCatalogDownload } from '@features/store/downloadCatalogItem';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { fireEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { CatalogDetailScreen } from './CatalogDetailScreen';
import {
  fixtureIndex,
  lacBeauport,
  mountWithProviders,
  QUEBEC,
  saguenay,
  seedCatalog,
} from './exploreTestUtils';

const mockNavigate = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    navigate: mockNavigate,
    push: jest.fn(),
    back: mockBack,
    replace: jest.fn(),
  }),
}));
jest.mock('@features/store/downloadCatalogItem', () => ({
  CatalogDownloadCanceled: class extends Error {},
  cancelCatalogDownload: jest.fn(),
  downloadCatalogItemToLibrary: jest.fn(),
}));
jest.mock('@data/catalogCache', () => ({
  loadCatalogManifest: jest.fn(),
  loadCatalogShard: jest.fn(),
  loadCatalogSearchDigest: jest.fn(),
}));
jest.mock('@data/diskSpace', () => ({ assessFreeSpaceForWrite: () => null }));

const installed = (updatedAt: string): MapDocument =>
  ({
    id: 'map-1',
    name: 'Lac-Beauport',
    sourceItemId: lacBeauport.id,
    sourceUpdatedAt: updatedAt,
  }) as MapDocument;

beforeEach(() => {
  seedCatalog(fixtureIndex());
  useLibraryStore.setState({ maps: [], folders: [] });
  useSettingsStore.setState({ lastKnownPosition: QUEBEC, units: 'metric' });
});

it('shows the map: tags, publisher, stats, coverage and rows', async () => {
  const view = await mountWithProviders(<CatalogDetailScreen id={lacBeauport.id} />);
  expect(view.getByText('Québec — Lac-Beauport')).toBeTruthy();
  expect(view.getByText('Topographic')).toBeTruthy();
  expect(view.getByText('Hiking')).toBeTruthy();
  expect(view.getByText('Ski')).toBeTruthy();
  expect(view.getByText('Mountains')).toBeTruthy();
  expect(view.getByText('Rivers & lakes')).toBeTruthy();
  expect(view.getByText('Natural Resources Canada · cantopo-021l14')).toBeTruthy();
  expect(view.getByText('1:25 000')).toBeTruthy();
  expect(view.getByText('5 MB')).toBeTruthy();
  expect(view.getByText(/^\d+ km$/)).toBeTruthy();
  expect(view.getByText(/^Coverage · 46\.85°N to 47\.05°N/)).toBeTruthy();
  expect(view.getByText('GeoPDF · works offline')).toBeTruthy();
  expect(view.getByText('2024-03-12')).toBeTruthy();
  expect(view.getByText('OGL-Canada-2.0')).toBeTruthy();
  expect(
    view.getByText(
      'Downloaded straight from the publisher, kept in your Library, works without signal.',
    ),
  ).toBeTruthy();
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  await fireEvent.press(view.getByLabelText('Open open.canada.ca'));
  expect(open).toHaveBeenCalledWith('https://open.canada.ca');
  expect(view.queryByText(/Buy|Purchase|\$/)).toBeNull();
});

it('leaves out the stats it does not know', async () => {
  const view = await mountWithProviders(<CatalogDetailScreen id={saguenay.id} />);
  expect(view.queryByText('Scale')).toBeNull();
  expect(view.getByText('Download')).toBeTruthy();
});

it('Download · Free asks for a destination folder', async () => {
  const view = await mountWithProviders(<CatalogDetailScreen id={lacBeauport.id} />);
  await fireEvent.press(view.getByText('Download · Free'));
  expect(view.getByText('Add to Library')).toBeTruthy();
});

it('an installed map opens on the map instead', async () => {
  useLibraryStore.setState({ maps: [installed('2024-03-12')] });
  const setActiveMap = jest.fn();
  useLibraryStore.setState({ setActiveMap });
  const view = await mountWithProviders(<CatalogDetailScreen id={lacBeauport.id} />);
  expect(view.queryByText('Download · Free')).toBeNull();
  await fireEvent.press(view.getByText('Open on map'));
  expect(setActiveMap).toHaveBeenCalledWith('map-1');
  expect(mockNavigate).toHaveBeenCalledWith('/');
});

it('a newer revision offers Update, and still Open on map', async () => {
  useLibraryStore.setState({ maps: [installed('2020-01-01')] });
  const view = await mountWithProviders(<CatalogDetailScreen id={lacBeauport.id} />);
  expect(view.getByText('Update')).toBeTruthy();
  expect(view.getByText('Open on map')).toBeTruthy();
});

it('a running download shows progress and cancels', async () => {
  useCatalogStore.setState({ downloads: { [lacBeauport.id]: 0.4 } });
  const view = await mountWithProviders(<CatalogDetailScreen id={lacBeauport.id} />);
  expect(view.queryByText('Download · Free')).toBeNull();
  await fireEvent.press(view.getByText('Cancel download'));
  expect(cancelCatalogDownload).toHaveBeenCalledWith(lacBeauport.id);
});

it('says so when the map is not in the loaded catalog', async () => {
  const view = await mountWithProviders(<CatalogDetailScreen id="nope" />);
  expect(view.getByText(/isn’t in the part of the catalog loaded/)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('Back'));
  expect(mockBack).toHaveBeenCalled();
});
