/**
 * The map's credit (#476, round 3): quiet text on the map, the full roll in
 * Settings. OSM's attribution guideline and Esri's terms want the credit on
 * the map view itself, so this text must always render.
 */
import { MAP_DATA_CREDITS } from '@features/settings/mapDataCredits';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { basemapAttribution } from '../mapStyle';
import { MapCreditText } from './MapCreditText';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

async function mount(basemap: 'map' | 'satellite', vector = true, osmLabels = false) {
  return render(
    <PaperProvider>
      <MapCreditText basemap={basemap} vector={vector} osmLabels={osmLabels} />
    </PaperProvider>,
  );
}

it.each([
  ['map', true, false, '© OpenStreetMap · Protomaps'],
  ['map', false, false, '© OpenStreetMap'],
  // MapScreen passes vector = stoneBase, false on satellite (#493: a `true`
  // there already means OSM data rides the imagery).
  ['satellite', false, false, '© Esri, Maxar'],
  // "Labels on satellite" draws OSM data over the imagery: credit it too.
  ['satellite', true, true, '© Esri, Maxar · © OpenStreetMap'],
  // Never twice.
  ['map', true, true, '© OpenStreetMap · Protomaps'],
] as const)(
  'credits the %s basemap on the map itself (vector %p, OSM labels %p)',
  async (basemap, vector, osmLabels, text) => {
    await mount(basemap, vector, osmLabels);
    expect(screen.getByTestId('map-credit')).toHaveTextContent(text);
    // Text, not a button.
    expect(screen.queryByRole('button')).toBeNull();
  },
);

it('opens Settings, where the full credits are, when tapped', async () => {
  await mount('map');
  await act(async () => {
    fireEvent.press(screen.getByTestId('map-credit'));
  });
  expect(mockPush).toHaveBeenCalledWith('/settings');
});

it('lists in About every provider the map credit can show', () => {
  for (const basemap of ['map', 'satellite'] as const) {
    const providers = basemapAttribution(basemap, true)
      .replace('©', '')
      .split(/[,·]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const provider of providers) expect(MAP_DATA_CREDITS).toContain(provider);
  }
});
