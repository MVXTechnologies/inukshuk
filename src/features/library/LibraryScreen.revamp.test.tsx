/**
 * The revamped Library (revamp §5): the first-run empty state, the type chips,
 * Organize mode, and the trail row's spoken label (decision 7: the activity
 * type is never colour alone).
 */
import type { Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';
import { LibraryScreen } from '@features/library/LibraryScreen';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

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

const track = (over: Partial<TrackSummary> = {}): TrackSummary => ({
  id: 't1',
  name: 'Les Loups',
  fileUri: 'file:///t1.gpx',
  startedAt: new Date(2026, 7, 29, 6).getTime(),
  stats: {
    distanceM: 11190,
    ascentM: 1068,
    descentM: 1050,
    durationS: 3 * 3600 + 31 * 60,
    movingTimeS: 0,
    avgSpeedMps: 0,
    maxSpeedMps: 0,
    pointCount: 10,
  },
  ...over,
});

const map: MapDocument = {
  id: 'm1',
  name: 'Charlevoix',
  fileUri: 'file:///m1.pdf',
  importedAt: 1,
  pageCount: 1,
  georeferences: [],
  activePages: [],
};

const waypoint: Waypoint = {
  id: 'w1',
  label: 'Belvédère',
  latitude: 47,
  longitude: -71,
  createdAt: 1,
};

async function show(state: {
  tracks?: TrackSummary[];
  maps?: MapDocument[];
  waypoints?: Waypoint[];
  folders?: Folder[];
}): Promise<RenderResult> {
  useLibraryStore.setState({
    hydrated: true,
    maps: state.maps ?? [],
    tracks: state.tracks ?? [],
    folders: state.folders ?? [],
    waypoints: state.waypoints ?? [],
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

async function press(view: RenderResult, node: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(node);
  });
}

beforeEach(() => {
  mockNavigate.mockReset();
  useMapStore.setState({ recordRequested: false });
});

describe('empty library', () => {
  it('shows the first-run state instead of empty sections', async () => {
    const view = await show({});
    expect(view.getByText('No trails yet')).toBeOnTheScreen();
    expect(
      view.getByText('Record one on the map, or import a GPX file you already have.'),
    ).toBeOnTheScreen();
    expect(view.queryByText(/Recorded trails/)).toBeNull();
    // Import stays in the header; there is nothing to organize or filter yet.
    expect(view.getByLabelText('Import')).toBeOnTheScreen();
    expect(view.getByLabelText('Settings')).toBeOnTheScreen();
    expect(view.queryByText('Organize')).toBeNull();
  });

  it('"Record a trail" asks the map for its record-start sheet', async () => {
    const view = await show({});
    await press(view, view.getByText('Record a trail'));
    expect(useMapStore.getState().recordRequested).toBe(true);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('"Browse maps near you" opens the Maps tab', async () => {
    const view = await show({});
    await press(view, view.getByText('Browse maps near you'));
    expect(mockNavigate).toHaveBeenCalledWith('/maps');
  });
});

describe('trail row', () => {
  it('names the type in the caption and in the spoken label', async () => {
    const view = await show({ tracks: [track({ category: 'hike' })] });
    expect(view.getByText('11.2 km · 3:31 · ↑1068 m')).toBeOnTheScreen();
    expect(view.getByText(/ · Hike$/)).toBeOnTheScreen();
    const row = view.getByLabelText(/^Les Loups, Hike, .* — open 3D view, long-press to select$/);
    expect(row).toBeOnTheScreen();
  });

  it('keeps the section count form the e2e flows read', async () => {
    const view = await show({ tracks: [track()] });
    expect(view.getByText('Recorded trails (1)')).toBeOnTheScreen();
  });
});

describe('type chips', () => {
  it('narrow the list to one kind, with counts', async () => {
    const view = await show({ tracks: [track()], maps: [map], waypoints: [waypoint] });
    expect(view.getByText('All 3')).toBeOnTheScreen();
    expect(view.getByText('Recorded trails (1)')).toBeOnTheScreen();
    expect(view.getByText('Maps (1)')).toBeOnTheScreen();

    await press(view, view.getByText('Maps 1'));
    expect(view.queryByText('Recorded trails (1)')).toBeNull();
    expect(view.getByText('Maps (1)')).toBeOnTheScreen();
    expect(view.queryByText('Waypoints (1)')).toBeNull();

    await press(view, view.getByText('Waypoints 1'));
    expect(view.getByText('Waypoints (1)')).toBeOnTheScreen();
    expect(view.queryByText('Maps (1)')).toBeNull();
  });
});

describe('Organize mode', () => {
  const folder: Folder = { id: 'f1', name: 'TripA', createdAt: 1 };

  it('shows grips and folder rename/delete only while organizing', async () => {
    const view = await show({ tracks: [track({ folderId: 'f1' })], folders: [folder] });
    expect(view.getByText('TripA (1)')).toBeOnTheScreen();
    expect(view.queryByLabelText('Delete folder')).toBeNull();
    expect(view.queryByLabelText('Rename folder')).toBeNull();
    expect(view.queryByLabelText('Drag Les Loups to a folder')).toBeNull();

    await press(view, view.getByText('Organize'));
    expect(view.getByLabelText('Delete folder')).toBeOnTheScreen();
    expect(view.getByLabelText('Rename folder')).toBeOnTheScreen();
    expect(view.getByLabelText('Drag Les Loups to a folder')).toBeOnTheScreen();

    await press(view, view.getByText('Done'));
    expect(view.queryByLabelText('Delete folder')).toBeNull();
  });
});

describe('imported trails (#432)', () => {
  const imported = track({
    id: 's1',
    name: 'Crête',
    origin: { source: 'strava', externalId: '1' },
  });

  it('carry a source mark and get a "From Strava" chip that narrows to them', async () => {
    const view = await show({ tracks: [imported, track()], maps: [map] });
    expect(view.getByLabelText('Imported from Strava')).toBeOnTheScreen();
    expect(view.getByLabelText(/^Crête, .*, from Strava — open 3D view/)).toBeOnTheScreen();

    await press(view, view.getByText('From Strava 1'));
    expect(view.getByText('Recorded trails (1/2)')).toBeOnTheScreen();
    expect(view.queryByText('Les Loups')).toBeNull();
    expect(view.queryByText('Maps (1)')).toBeNull();

    // Tapping it again (or a type chip) goes back.
    await press(view, view.getByText('From Strava 1'));
    expect(view.getByText('Recorded trails (2)')).toBeOnTheScreen();
    await press(view, view.getByText('From Strava 1'));
    await press(view, view.getByText('All 3'));
    expect(view.getByText('Maps (1)')).toBeOnTheScreen();
  });

  it('shows no source chip or mark without imported trails', async () => {
    const view = await show({ tracks: [track()] });
    expect(view.queryByText(/^From /)).toBeNull();
    expect(view.queryByLabelText(/^Imported from/)).toBeNull();
  });

  it('opens the Import sheet when Settings asks for it, and closes it', async () => {
    useImportStore.setState({ sheetRequest: { source: 'files' } });
    const view = await show({ tracks: [track()] });
    expect(view.getByRole('header', { name: 'Import activities' })).toBeOnTheScreen();
    expect(view.getByText('FIT · GPX · TCX · export zip')).toBeOnTheScreen();
    await press(view, view.getByText('Cancel'));
    expect(useImportStore.getState().sheetRequest).toBeNull();
    expect(view.queryByRole('header', { name: 'Import activities' })).toBeNull();
  });
});
