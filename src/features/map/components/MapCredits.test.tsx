/**
 * The map's credits (2.1.1): a small ⓘ left of the scale bar opens a sheet
 * of every source on screen, with "Report a map error". It replaced the
 * "© OpenStreetMap · Protomaps" caption (#476) and the draw panel's footer.
 */
import { mapCredits, type MapCreditsInput } from '@core/map/mapCredits';
import { MAP_DATA_CREDITS } from '@features/settings/mapDataCredits';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { MapCreditsButton, MapCreditsSheet } from './MapCredits';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const MAP: MapCreditsInput = {
  basemap: 'map',
  vector: true,
  osmLabels: false,
  terrain: true,
  pdfMaps: ['Mont-Sainte-Anne'],
  routingEngines: ['BRouter'],
};

beforeEach(() => {
  mockPush.mockClear();
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

async function mountSheet(input: MapCreditsInput = MAP) {
  const onClose = jest.fn();
  await render(
    <PaperProvider>
      <MapCreditsSheet lines={mapCredits(input)} bottom={60} onClose={onClose} />
    </PaperProvider>,
  );
  return onClose;
}

it('is a small labelled button, not a text caption', async () => {
  const onPress = jest.fn();
  await render(
    <PaperProvider>
      <MapCreditsButton onPress={onPress} />
    </PaperProvider>,
  );
  const button = screen.getByRole('button', { name: 'Map data credits' });
  expect(screen.queryByText(/OpenStreetMap/)).toBeNull();
  await act(async () => {
    fireEvent.press(button);
  });
  expect(onPress).toHaveBeenCalledTimes(1);
});

it('lists every source on screen with its © line', async () => {
  await mountSheet();
  for (const id of ['base', 'terrain', 'peaks', 'pdf', 'routing']) {
    expect(screen.getByTestId(`map-credit-${id}`)).toBeOnTheScreen();
  }
  expect(screen.getByText('© OpenStreetMap contributors · Protomaps')).toBeOnTheScreen();
  expect(screen.getByText('BRouter · © OpenStreetMap contributors')).toBeOnTheScreen();
  expect(screen.getByText(/Mont-Sainte-Anne/)).toBeOnTheScreen();
  // Section labels render as small caps.
  expect(screen.getByText('ROUTING')).toBeOnTheScreen();
});

it('shows Esri on satellite, and no routing line without a routed route', async () => {
  await mountSheet({ ...MAP, basemap: 'satellite', vector: false, routingEngines: null });
  expect(screen.getByText('© Esri, Maxar, Earthstar Geographics')).toBeOnTheScreen();
  expect(screen.queryByTestId('map-credit-routing')).toBeNull();
  expect(screen.queryByTestId('map-credit-base')).toBeNull();
});

it('opens the licence links and "Report a map error"', async () => {
  await mountSheet();
  await act(async () => {
    fireEvent.press(screen.getByRole('link', { name: 'openstreetmap.org/copyright' }));
  });
  expect(Linking.openURL).toHaveBeenLastCalledWith('https://www.openstreetmap.org/copyright');
  await act(async () => {
    fireEvent.press(screen.getByRole('link', { name: 'Report a map error' }));
  });
  expect(Linking.openURL).toHaveBeenLastCalledWith('https://www.openstreetmap.org/fixthemap');
});

it('links to the full roll in Settings, closing itself', async () => {
  const onClose = await mountSheet();
  await act(async () => {
    fireEvent.press(screen.getByRole('link', { name: 'All data credits, in Settings' }));
  });
  expect(onClose).toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith('/settings');
});

it('closes on a tap anywhere (backdrop) and on its ✕', async () => {
  const onClose = await mountSheet();
  await act(async () => {
    fireEvent.press(screen.getByTestId('map-credits-backdrop'));
  });
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Close map credits' }));
  });
  expect(onClose).toHaveBeenCalledTimes(2);
});

it('every base-map provider it can name is also in the full roll in Settings', () => {
  for (const input of [
    MAP,
    { ...MAP, vector: false },
    { ...MAP, basemap: 'satellite' as const, osmLabels: true },
  ]) {
    for (const line of mapCredits(input).filter((l) =>
      ['base', 'imagery', 'labels'].includes(l.id),
    )) {
      const providers = line.credit
        .replace(/©/g, '')
        .replace('contributors', '')
        .split(/[,·]/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const provider of providers) expect(MAP_DATA_CREDITS).toContain(provider);
    }
  }
});
