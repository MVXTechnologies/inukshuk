import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { schemeTokens } from '@ui/tokens';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import type { VisiblePin } from './pinHit';
import { WaypointClusterSheet } from './WaypointClusterSheet';
import { useWaypointClusterSheet } from './waypointTap';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const PINS: VisiblePin[] = [
  { source: 'saved', id: 'a', label: 'Trailhead', latitude: 46.81394, longitude: -71.20761 },
  {
    source: 'saved',
    id: 'b',
    label: 'First-aid kit',
    latitude: 46.81394,
    longitude: -71.20761,
    icon: 'camp',
    color: '#D32F2F',
    size: 'L',
  },
  { source: 'live', id: 'c', label: 'Tent spot', latitude: 46.81394, longitude: -71.20761 },
  { source: 'saved', id: 'd', label: 'Elsewhere', latitude: 47, longitude: -71 },
] as unknown as VisiblePin[];

async function renderSheet(
  opts: { dark?: boolean; suppressed?: boolean; onOpen?: (p: VisiblePin) => void } = {},
) {
  await render(
    <PaperProvider theme={opts.dark ? darkTheme : lightTheme}>
      <WaypointClusterSheet
        pins={PINS}
        onOpen={opts.onOpen ?? (() => undefined)}
        suppressed={opts.suppressed ?? false}
      />
    </PaperProvider>,
  );
}

beforeEach(() => {
  useSettingsStore.setState({ coordinateFormat: 'dd' });
  useWaypointClusterSheet.setState({ keys: null });
});

describe('the cluster list sheet (#685)', () => {
  it('renders nothing while closed', async () => {
    await renderSheet();
    expect(screen.queryByTestId('waypoint-cluster-sheet')).toBeNull();
  });

  it.each([['light'], ['dark']])('lists the cluster’s pins by name, themed (%s)', async (theme) => {
    const dark = theme === 'dark';
    useWaypointClusterSheet.setState({ keys: ['saved-a', 'saved-b', 'live-c'] });
    await renderSheet({ dark });
    expect(screen.getByText('3 waypoints here')).toBeOnTheScreen();
    for (const name of ['Trailhead', 'First-aid kit', 'Tent spot']) {
      expect(screen.getByLabelText(`Open ${name}`)).toBeOnTheScreen();
    }
    expect(screen.queryByText('Elsewhere')).toBeNull();
    expect(screen.getAllByText('46.81394, -71.20761')).toHaveLength(3);
    const t = schemeTokens(dark);
    const card = StyleSheet.flatten(screen.getByTestId('waypoint-cluster-sheet').props.style) as {
      backgroundColor?: string;
    };
    expect(card.backgroundColor).toBe(t.elevation.level2);
    const title = StyleSheet.flatten(screen.getByText('3 waypoints here').props.style) as {
      color?: string;
    };
    expect(title.color).toBe(t.ink);
  });

  it('a row closes the sheet and opens that pin’s card', async () => {
    useWaypointClusterSheet.setState({ keys: ['saved-a', 'saved-b'] });
    const onOpen = jest.fn();
    await renderSheet({ onOpen });
    await act(async () => {
      fireEvent.press(screen.getByTestId('waypoint-cluster-row-saved-b'));
    });
    expect(onOpen).toHaveBeenCalledWith(PINS[1]);
    expect(useWaypointClusterSheet.getState().keys).toBeNull();
    expect(screen.queryByTestId('waypoint-cluster-sheet')).toBeNull();
  });

  it('✕ closes it', async () => {
    useWaypointClusterSheet.setState({ keys: ['saved-a', 'saved-b'] });
    await renderSheet();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Close the waypoint list'));
    });
    expect(useWaypointClusterSheet.getState().keys).toBeNull();
  });

  it('closes for good when another card takes the slot', async () => {
    useWaypointClusterSheet.setState({ keys: ['saved-a', 'saved-b'] });
    await renderSheet({ suppressed: true });
    expect(screen.queryByTestId('waypoint-cluster-sheet')).toBeNull();
    expect(useWaypointClusterSheet.getState().keys).toBeNull();
  });

  it('skips pins that are gone, and hides when none is left', async () => {
    useWaypointClusterSheet.setState({ keys: ['saved-a', 'saved-gone'] });
    await renderSheet();
    expect(screen.getByText('1 waypoint here')).toBeOnTheScreen();
    await act(async () => useWaypointClusterSheet.setState({ keys: ['saved-gone'] }));
    expect(screen.queryByTestId('waypoint-cluster-sheet')).toBeNull();
  });
});
