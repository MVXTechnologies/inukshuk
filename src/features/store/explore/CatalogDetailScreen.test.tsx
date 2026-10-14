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
import { schemeTokens } from '@ui/tokens';
import { Linking, StyleSheet } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';
import { openMapPdf } from '@features/library/openMapPdf';

import { CatalogDetailScreen } from './CatalogDetailScreen';
import {
  cpaIndex,
  cpaMap,
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
jest.mock('@features/library/openMapPdf', () => ({
  openMapPdf: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../../map/search/deviceLanguage', () => ({ deviceSearchLanguage: () => 'en' }));

const installed = (updatedAt: string): MapDocument =>
  ({
    id: 'map-1',
    name: 'Lac-Beauport',
    sourceItemId: lacBeauport.id,
    sourceUpdatedAt: updatedAt,
    // A GeoPDF: it has a georeference, so it opens on the map.
    georeferences: [{ pageIndex: 0 }],
  }) as unknown as MapDocument;

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

describe('a Cartes Plein-air map (#680)', () => {
  beforeEach(() => seedCatalog(cpaIndex()));

  it.each([false, true])(
    'credits the author, says it is free, and links the map’s page (dark: %s)',
    async (dark) => {
      const view = await mountWithProviders(
        <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>
          <CatalogDetailScreen id={cpaMap.id} />
        </PaperProvider>,
      );
      expect(view.getByText('Auteur Exemple · 2022 · Cartes Plein-air')).toBeTruthy();
      const free = view.getByText('Available free at cartespleinair.org');
      expect(StyleSheet.flatten(free.props.style).color).toBe(schemeTokens(dark).explore.accent);
      expect(view.getByText('Author')).toBeTruthy();
      expect(view.getByText('Not placed yet')).toBeTruthy();
      expect(view.getByText('PDF · works offline')).toBeTruthy();
      expect(view.getByText(/^Approximate area \(the river\) · /)).toBeTruthy();
      expect(view.getByText(/opens as a PDF, without your position/)).toBeTruthy();
      expect(view.getByText('Download · Free')).toBeTruthy();
      expect(view.queryByText(/\$|Buy|Purchase/)).toBeNull();

      const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
      await fireEvent.press(free);
      expect(open).toHaveBeenCalledWith('https://cartespleinair.org/cartes/aigle-desert-x-2022');
      await fireEvent.press(view.getByLabelText('Open On cartespleinair.org'));
      expect(open).toHaveBeenLastCalledWith(
        'https://cartespleinair.org/cartes/aigle-desert-x-2022',
      );
      await fireEvent.press(view.getByLabelText('Open cartespleinair.org'));
      expect(open).toHaveBeenLastCalledWith('https://cartespleinair.org/cartes');
    },
  );

  it('installed, it opens as a PDF, never on the map', async () => {
    const setActiveMap = jest.fn();
    useLibraryStore.setState({
      setActiveMap,
      maps: [
        {
          id: 'map-cpa',
          name: 'Aigle-Désert',
          fileUri: 'maps/map-cpa.pdf',
          georeferences: [],
          sourceItemId: cpaMap.id,
          sourceVersion: 'v2',
        } as unknown as MapDocument,
      ],
    });
    const view = await mountWithProviders(<CatalogDetailScreen id={cpaMap.id} />);
    expect(view.queryByText('Open on map')).toBeNull();
    await fireEvent.press(view.getByText('Open PDF'));
    expect(openMapPdf).toHaveBeenCalledWith(expect.objectContaining({ id: 'map-cpa' }));
    expect(setActiveMap).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('a republished file says a newer version is available', async () => {
    useLibraryStore.setState({
      maps: [
        {
          id: 'map-cpa',
          name: 'Aigle-Désert',
          georeferences: [],
          sourceItemId: cpaMap.id,
          sourceVersion: 'v1',
        } as unknown as MapDocument,
      ],
    });
    const view = await mountWithProviders(<CatalogDetailScreen id={cpaMap.id} />);
    expect(view.getByText('A newer version is available')).toBeTruthy();
    expect(view.getByText('Update')).toBeTruthy();
    expect(view.getByText('Open PDF')).toBeTruthy();
  });
});

it('says so when the map is not in the loaded catalog', async () => {
  const view = await mountWithProviders(<CatalogDetailScreen id="nope" />);
  expect(view.getByText(/isn’t in the part of the catalog loaded/)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('Back'));
  expect(mockBack).toHaveBeenCalled();
});
