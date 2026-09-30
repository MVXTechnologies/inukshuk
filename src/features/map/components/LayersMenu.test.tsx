import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { PaperProvider } from 'react-native-paper';
import { MAP_TYPES, MapTypePanel } from './LayersMenu';

/**
 * The #484 "Map type" panel (owner's option A): two preview cards, Map and
 * Satellite — no Relief — each previewing the user's own area.
 *
 * The preview itself is a cached tile fetch (RegionPreviewThumb, covered on
 * its own); here it is a stub that records what each card asked it to show.
 */
const mockThumbs: { basemap: string; bbox: unknown }[] = [];
jest.mock('../RegionPreviewThumb', () => ({
  RegionPreviewThumb: (props: { basemap: string; bbox: unknown }) => {
    mockThumbs.push({ basemap: props.basemap, bbox: props.bbox });
    return null;
  },
}));

async function renderPanel(onClose = jest.fn(), dark = false): Promise<jest.Mock> {
  mockThumbs.length = 0;
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <MapTypePanel onClose={onClose} />
    </PaperProvider>,
  );
  return onClose;
}

const MAP = 'Map, Trails, contours, names';
const SATELLITE = 'Satellite, Aerial imagery';

afterEach(async () => {
  await act(async () => {
    useMapStore.setState({ basemap: 'map' });
    useSettingsStore.setState({ lastKnownPosition: null });
  });
});

describe('MapTypePanel', () => {
  it('offers exactly Map and Satellite — Relief is retired', async () => {
    await renderPanel();
    expect(MAP_TYPES.map((t) => t.key)).toEqual(['map', 'satellite']);
    expect(screen.getByText('Map type')).toBeTruthy();
    expect(screen.getByLabelText(MAP)).toBeTruthy();
    expect(screen.getByLabelText(SATELLITE)).toBeTruthy();
    expect(screen.queryByText('Relief')).toBeNull();
  });

  it.each([false, true])('marks the current base map as selected (dark: %s)', async (dark) => {
    useMapStore.setState({ basemap: 'satellite' });
    await renderPanel(jest.fn(), dark);
    expect(screen.getByLabelText(SATELLITE).props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(screen.getByLabelText(MAP).props.accessibilityState).toMatchObject({
      selected: false,
    });
    // One check badge, on the selected card only.
    expect(screen.getAllByTestId('map-type-check')).toHaveLength(1);
  });

  it('picking a card switches the base map and closes the panel', async () => {
    const onClose = await renderPanel();
    fireEvent.press(screen.getByLabelText(SATELLITE));
    expect(useMapStore.getState().basemap).toBe('satellite');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes untouched from the ✕', async () => {
    useMapStore.setState({ basemap: 'map' });
    const onClose = await renderPanel();
    fireEvent.press(screen.getByLabelText('Close map type'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useMapStore.getState().basemap).toBe('map');
  });

  it('previews each style over the user’s own last position', async () => {
    useSettingsStore.setState({ lastKnownPosition: { latitude: 46.8, longitude: -71.2 } });
    await renderPanel();
    const shown = new Set(mockThumbs.map((t) => t.basemap));
    expect(shown).toEqual(new Set(['map', 'satellite']));
    const bbox = mockThumbs[0]?.bbox as { minLat: number; maxLat: number; minLng: number };
    expect(bbox.minLat).toBeLessThan(46.8);
    expect(bbox.maxLat).toBeGreaterThan(46.8);
    expect(bbox.minLng).toBeCloseTo(-71.22);
  });

  it('falls back to the placeholder preview when never located', async () => {
    await renderPanel();
    expect(mockThumbs.every((t) => t.bbox === null)).toBe(true);
  });
});

describe('mapStore base map (#484 relief → map migration)', () => {
  it('lands a stale relief on map', () => {
    useMapStore.getState().setBasemap('relief' as unknown as 'map');
    expect(useMapStore.getState().basemap).toBe('map');
    useMapStore.getState().setBasemap('satellite');
    expect(useMapStore.getState().basemap).toBe('satellite');
  });
});
