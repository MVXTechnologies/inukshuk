/**
 * The Parcs Québec link-out collection (#447): sort chips, rows opening the
 * park's page on sepaq.com, and no download anywhere.
 */
import { loadCatalogCollectionsRaw } from '@data/catalogCollections';
import { useSettingsStore } from '@state/settingsStore';
import { fireEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { mountWithProviders, QUEBEC, sepaqRaw, settle } from './exploreTestUtils';
import { LinkOutCollectionScreen } from './LinkOutCollectionScreen';
import { resetLinkOutCollectionsCache } from './useLinkOutCollections';

jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@data/catalogCollections', () => ({ loadCatalogCollectionsRaw: jest.fn() }));

const collectionsMock = loadCatalogCollectionsRaw as jest.Mock;

beforeEach(() => {
  resetLinkOutCollectionsCache();
  collectionsMock.mockResolvedValue(sepaqRaw);
  useSettingsStore.setState({ lastKnownPosition: QUEBEC, units: 'metric' });
});

async function screen() {
  const view = await mountWithProviders(<LinkOutCollectionScreen id="sepaq" />);
  await settle();
  return view;
}

const names = (view: Awaited<ReturnType<typeof screen>>) =>
  view.getAllByText(/^(Parc|Réserve) /).map((n) => String(n.props.children));

it('lists every place nearest first, with the intro', async () => {
  const view = await screen();
  expect(view.getByText('Parcs Québec')).toBeTruthy();
  expect(view.getByText(/SÉPAQ’s park maps are published on sepaq\.com/)).toBeTruthy();
  expect(names(view)).toEqual([
    'Parc national de la Jacques-Cartier',
    'Réserve faunique des Laurentides',
    'Parc national de la Gaspésie',
  ]);
  expect(view.getByText('National park · hiking, paddling')).toBeTruthy();
  expect(view.queryByText(/Download/)).toBeNull();
});

it('filters by place type with the sort chips', async () => {
  const view = await screen();
  await fireEvent.press(view.getByText('Wildlife reserves'));
  expect(names(view)).toEqual(['Réserve faunique des Laurentides']);
  await fireEvent.press(view.getByText('National parks'));
  expect(names(view)).toEqual([
    'Parc national de la Jacques-Cartier',
    'Parc national de la Gaspésie',
  ]);
  await fireEvent.press(view.getByText('Nearest first'));
  expect(names(view)).toHaveLength(3);
});

it("opens the park's page on the publisher's site", async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  const view = await screen();
  await fireEvent.press(view.getByText('Parc national de la Jacques-Cartier'));
  expect(open).toHaveBeenCalledWith('https://www.sepaq.com/pq/jac/');
});

it('sorts A to Z without a position', async () => {
  useSettingsStore.setState({ lastKnownPosition: null });
  const view = await screen();
  expect(view.getByText('A to Z')).toBeTruthy();
  expect(names(view)[0]).toBe('Parc national de la Gaspésie');
});

it('says the collection is unavailable when collections.json is not there', async () => {
  collectionsMock.mockResolvedValue(null);
  const view = await screen();
  expect(view.getByText('This collection isn’t available right now.')).toBeTruthy();
});
