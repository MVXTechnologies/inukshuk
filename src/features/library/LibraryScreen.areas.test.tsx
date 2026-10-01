/**
 * Drawn routes and areas in the Library (#502/#503): the Areas section and
 * chip with their counts, an area row opening its card on the map, and a
 * drawn route's "Planned route" caption and "Edit route" menu item.
 */
import type { Area, TrackSummary, Waypoint } from '@core/models';
import { LibraryScreen } from '@features/library/LibraryScreen';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Paper's Menu measures its anchor and mounts its items through a Portal —
// unreliable under Jest (see LibraryScreen.mapCard.test): a plain stand-in.
jest.mock('react-native-paper', () => {
  const paper = jest.requireActual('react-native-paper');
  const { View } = jest.requireActual('react-native');
  const Menu = ({
    visible,
    anchor,
    children,
  }: {
    visible: boolean;
    anchor: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <View>
      {anchor}
      {visible ? children : null}
    </View>
  );
  Menu.Item = paper.Menu.Item;
  return { ...paper, Menu };
});
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mockNavigate, push: jest.fn() }),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('@data/storage', () => ({
  newId: () => 'id',
  deleteFileAt: jest.fn(),
  writeIndex: jest.fn(),
  toDocumentPath: (uri: string) => uri,
  resolveDocumentPath: (path: string) => path,
  documentDirUri: () => 'file:///Documents',
  existingOverlayPng: () => null,
  fileSizeAt: () => 0,
}));
jest.mock('@features/library/importMap', () => ({ pickAndImportMaps: jest.fn() }));
jest.mock('@features/library/importActivities', () => ({
  pickAndImportActivityFiles: jest.fn(),
  activityImportMessage: jest.fn(),
}));
jest.mock('./useRouteThumbnail', () => ({ useRouteThumbnail: () => undefined }));

const area = (id: string, over: Partial<Area> = {}): Area => ({
  id,
  name: `Area ${id}`,
  ring: [
    [-71.2, 46.8],
    [-71.19, 46.8],
    [-71.19, 46.81],
    [-71.2, 46.81],
  ],
  color: '#2563EB',
  createdAt: new Date(2026, 8, 30).getTime(),
  ...over,
});

const route: TrackSummary = {
  id: 'r1',
  name: 'Montmorency loop',
  fileUri: 'file:///r1.gpx',
  startedAt: new Date(2026, 9, 1).getTime(),
  category: 'hike',
  stats: {
    distanceM: 6900,
    ascentM: 610,
    descentM: 600,
    durationS: 0,
    movingTimeS: 0,
    avgSpeedMps: 0,
    maxSpeedMps: 0,
    pointCount: 230,
  },
  plan: {
    mode: 'freehand',
    vertices: [
      [-71.2, 46.8],
      [-71.19, 46.81],
    ],
  },
};

async function show(state: {
  tracks?: TrackSummary[];
  areas?: Area[];
  waypoints?: Waypoint[];
}): Promise<RenderResult> {
  useLibraryStore.setState({
    hydrated: true,
    maps: [],
    tracks: state.tracks ?? [],
    folders: [],
    waypoints: state.waypoints ?? [],
    areas: state.areas ?? [],
    activeTrackIds: [],
    customCategories: [],
  });
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <LibraryScreen />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

async function press(node: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(node);
  });
}

beforeEach(() => {
  mockNavigate.mockReset();
  useMapStore.setState({ drawRequest: null });
});

describe('areas in the Library (#503)', () => {
  it('lists drawn areas in their own section, newest first, with a count', async () => {
    const view = await show({
      areas: [
        area('old', { createdAt: 1, name: 'Old field' }),
        area('new', { name: 'Blueberry slope', note: 'Mid-August', tags: ['Berries'] }),
      ],
    });
    expect(view.getByText('Areas (2)')).toBeOnTheScreen();
    expect(view.getByText('Areas 2')).toBeOnTheScreen(); // the type chip
    const rows = view.getAllByLabelText(/, area .* — show on map/);
    expect(rows[0]).toHaveProp('accessibilityLabel', expect.stringMatching(/^Blueberry slope/));
    expect(view.getByText(/km² · Mid-August$/)).toBeOnTheScreen();
    expect(view.getByText(/ · Berries$/)).toBeOnTheScreen();
  });

  it('the Areas chip narrows the list to areas', async () => {
    const view = await show({ tracks: [route], areas: [area('a1')] });
    expect(view.getByText('Recorded trails (1)')).toBeOnTheScreen();
    await press(view.getByText('Areas 1'));
    expect(view.queryByText('Recorded trails (1)')).toBeNull();
    expect(view.getByText('Areas (1)')).toBeOnTheScreen();
  });

  it('an areas-only library is not the first-run empty state', async () => {
    const view = await show({ areas: [area('a1')] });
    expect(view.queryByText('Record a trail')).toBeNull();
    expect(view.getByText('Areas (1)')).toBeOnTheScreen();
  });

  it('a row opens the area on the map', async () => {
    const view = await show({ areas: [area('a1')] });
    await press(view.getByLabelText(/^Area a1, area .* — show on map/));
    expect(useMapStore.getState().drawRequest).toEqual({ kind: 'show-area', areaId: 'a1' });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('its menu offers Edit shape and Delete (through the shared confirm)', async () => {
    const view = await show({ areas: [area('a1')] });
    await press(view.getByLabelText('Area options'));
    await press(await view.findByText('Edit shape'));
    expect(useMapStore.getState().drawRequest).toEqual({
      kind: 'edit-area-shape',
      areaId: 'a1',
    });
    await press(view.getByLabelText('Area options'));
    await press(await view.findByText('Delete area'));
    expect(
      view.getByText('Delete area "Area a1"? Its note and photos are permanently deleted.'),
    ).toBeOnTheScreen();
    await press(view.getByText('Delete'));
    expect(useLibraryStore.getState().areas).toEqual([]);
  });
});

describe('drawn routes in the Library (#502)', () => {
  it('reads as a planned route, with no duration', async () => {
    const view = await show({ tracks: [route] });
    expect(view.getByText(/ · Planned route · Hike$/)).toBeOnTheScreen();
    expect(view.getByText('6.9 km · ↑610 m')).toBeOnTheScreen();
  });

  it('"Edit route" reopens it in the map\'s drawing tool', async () => {
    const view = await show({ tracks: [route] });
    await press(view.getByLabelText('More options'));
    await press(await view.findByText('Edit route'));
    expect(useMapStore.getState().drawRequest).toEqual({ kind: 'edit-route', trackId: 'r1' });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('a recorded trail has no "Edit route"', async () => {
    const { plan: _plan, ...recorded } = route;
    const view = await show({
      tracks: [{ ...recorded, stats: { ...route.stats, durationS: 60 } }],
    });
    await press(view.getByLabelText('More options'));
    expect(view.queryByText('Edit route')).toBeNull();
  });
});
