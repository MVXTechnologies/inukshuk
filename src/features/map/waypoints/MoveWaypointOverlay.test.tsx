import { useMapStore } from '@state/mapStore';
import { useWaypointMoveStore } from '@state/waypointMoveStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import type { ReactNode } from 'react';
import { BackHandler, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { MoveWaypointLayers } from './MoveWaypointLayers';
import { MoveWaypointOverlay } from './MoveWaypointOverlay';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockSources: Props[] = [];
const mockLayers: Props[] = [];
jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => {
    mockSources.push(props);
    return props.children ?? null;
  },
  Layer: (props: Props) => {
    mockLayers.push(props);
    return null;
  },
}));

const FROM = { latitude: 46.81394, longitude: -71.20761 };
const TARGET = { id: 'w1', label: 'Camp lac', from: FROM, icon: 'camp' as const };

type Back = () => boolean;
let backHandlers: Back[] = [];
beforeEach(() => {
  mockSources.length = 0;
  mockLayers.length = 0;
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
    backHandlers.push(h as Back);
    return { remove: () => (backHandlers = backHandlers.filter((x) => x !== h)) };
  });
  useWaypointMoveStore.setState({ moving: null });
  useMapStore.setState({ mapCenter: null });
});
afterEach(() => jest.restoreAllMocks());

async function setup(dark = false, zoom: number | null = null) {
  const handlers = { onCancel: jest.fn(), onConfirm: jest.fn(), onLocate: jest.fn() };
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <MoveWaypointOverlay units="metric" zoom={zoom} {...handlers} />
      <MoveWaypointLayers topLayerId="top" />
    </PaperProvider>,
  );
  return handlers;
}

describe('MoveWaypointOverlay (#676)', () => {
  it('is absent outside move mode', async () => {
    await setup();
    expect(screen.queryByTestId('move-waypoint')).toBeNull();
    expect(mockSources).toHaveLength(0);
  });

  it('names the pin, shows a crosshair, Locate, Cancel and Confirm', async () => {
    useWaypointMoveStore.setState({ moving: TARGET });
    const h = await setup();
    expect(screen.getByText('Moving “Camp lac” · drag the map')).toBeOnTheScreen();
    expect(screen.getByTestId('move-crosshair')).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('My location'));
    expect(h.onLocate).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText('Confirm move'));
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText('Cancel move'));
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the settled centre and how far the pin moved', async () => {
    useWaypointMoveStore.setState({ moving: TARGET });
    await setup();
    expect(screen.getByTestId('move-coords')).toHaveTextContent('46.81394, -71.20761');
    expect(screen.getByText('Pan the map to put the pin in its new place')).toBeOnTheScreen();
    await act(async () =>
      useMapStore.setState({ mapCenter: { latitude: 46.81418, longitude: -71.20726 } }),
    );
    expect(screen.getByTestId('move-coords')).toHaveTextContent('46.81418, -71.20726');
    // No scale known: no zoom hint.
    expect(screen.getByText('Moved 38 m NE')).toBeOnTheScreen();
  });

  it.each([
    // ≈ 2.4 m/px at z16 here: a 200 m scale bar — worth zooming in.
    [16, 'Moved 38 m NE · zoom in for precision'],
    // ≈ 0.15 m/px at z20: a 20 m scale bar — finer than GPS, no hint (2.5.1 QA).
    [20, 'Moved 38 m NE'],
  ])('at zoom %s says "%s"', async (zoom, text) => {
    useWaypointMoveStore.setState({ moving: TARGET });
    await setup(false, zoom);
    await act(async () =>
      useMapStore.setState({ mapCenter: { latitude: 46.81418, longitude: -71.20726 } }),
    );
    expect(screen.getByText(text)).toBeOnTheScreen();
  });

  it('draws the dashed line from the old spot to the settled centre', async () => {
    useWaypointMoveStore.setState({ moving: TARGET });
    await setup();
    await act(async () =>
      useMapStore.setState({ mapCenter: { latitude: 46.815, longitude: -71.2 } }),
    );
    const data = mockSources[mockSources.length - 1]?.data as {
      features: { geometry: { type: string; coordinates: unknown } }[];
    };
    expect(data.features[0]?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [FROM.longitude, FROM.latitude],
        [-71.2, 46.815],
      ],
    });
    const line = mockLayers.find((l) => l.id === 'waypoint-move-line');
    expect((line?.paint as Record<string, unknown>)['line-dasharray']).toEqual([3, 3]);
  });

  it('Android Back cancels', async () => {
    useWaypointMoveStore.setState({ moving: TARGET });
    const h = await setup();
    await act(async () => {
      backHandlers[backHandlers.length - 1]?.();
    });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['light', false],
    ['dark', true],
  ])('paints its bar with the %s theme', async (_n, dark) => {
    useWaypointMoveStore.setState({ moving: TARGET });
    await setup(dark);
    const coords = screen.getByTestId('move-coords');
    const color = (StyleSheet.flatten(coords.props.style) as { color?: string }).color;
    expect(color).toBe((dark ? darkTheme : lightTheme).colors.onSurface);
  });
});
