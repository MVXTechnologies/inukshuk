/**
 * Select mode in the Library (#711): hold a row to select it, then taps
 * toggle; the header counts and summarizes kinds; the action bar replaces the
 * tab bar (Move to…, Show on map, Share, Merge, Delete), dims what does not
 * apply and says why; Move and Delete come with Undo; a folder's header can
 * be held to select the folder itself. Both themes.
 */
import type { Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';
import { LibraryScreen, MOVED_HEADER_GAP } from '@features/library/LibraryScreen';
import { useLibraryStore } from '@state/libraryStore';
import { useScreenSheetStore } from '@state/screenSheetStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { BackHandler, FlatList, Platform, StyleSheet, Vibration } from 'react-native';
import { PaperProvider, type MD3Theme } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SELECT_TICK_MS } from './selection/useLibrarySelection';
import { sendCopy } from './share/sendCopy';

jest.useFakeTimers();

// Paper's Menu mounts through a Portal and measures its anchor: a stand-in.
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
  useIsFocused: () => true,
  useRouter: () => ({ navigate: mockNavigate, push: jest.fn() }),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
const mockDeleteFile = jest.fn();
jest.mock('@data/storage', () => ({
  newId: () => `id${Math.random().toString(36).slice(2, 8)}`,
  deleteFileAt: (uri: string) => mockDeleteFile(uri),
  writeIndex: jest.fn(),
  toDocumentPath: (uri: string) => uri,
  resolveDocumentPath: (path: string) => path,
  documentDirUri: () => 'file:///Documents',
  existingOverlayPng: () => null,
  fileSizeAt: () => 0,
}));
const mockDeletePhotos = jest.fn();
jest.mock('@data/photos/trailFolder', () => ({
  deleteTrailPhotoFolder: (id: string) => mockDeletePhotos(id),
}));
jest.mock('./share/sendCopy', () => ({
  planBytes: () => 412_000,
  sendCopy: jest.fn(async () => ({ kind: 'shared' })),
}));
jest.mock('@features/library/importMap', () => ({ pickAndImportMaps: jest.fn() }));
jest.mock('@features/library/importActivities', () => ({
  pickAndImportActivityFiles: jest.fn(),
  activityImportMessage: jest.fn(),
}));
jest.mock('./useRouteThumbnail', () => ({ useRouteThumbnail: () => undefined }));

const stats = {
  distanceM: 16_200,
  ascentM: 1090,
  descentM: 1050,
  durationS: 3600,
  movingTimeS: 3600,
  avgSpeedMps: 1,
  maxSpeedMps: 2,
  pointCount: 10,
};
const track = (id: string, name: string, over: Partial<TrackSummary> = {}): TrackSummary => ({
  id,
  name,
  fileUri: `file:///${id}.gpx`,
  startedAt: new Date(2026, 8, Number(id.replace(/\D/g, '')) || 1).getTime(),
  stats,
  ...over,
});
const map = (id: string, name: string, over: Partial<MapDocument> = {}): MapDocument => ({
  id,
  name,
  fileUri: `file:///${id}.pdf`,
  importedAt: 1,
  pageCount: 1,
  georeferences: [],
  activePages: [],
  ...over,
});
const waypoint = (id: string, label: string, over: Partial<Waypoint> = {}): Waypoint => ({
  id,
  label,
  latitude: 48.9,
  longitude: -66.2,
  createdAt: 1,
  ...over,
});

const TRAILS = [
  track('t1', 'Mont Jacques-Cartier'),
  track('t2', 'Lac-aux-Américains loop'),
  track('t3', 'Cap-Chat'),
];

async function show(
  state: {
    tracks?: TrackSummary[];
    maps?: MapDocument[];
    waypoints?: Waypoint[];
    folders?: Folder[];
  },
  theme: MD3Theme = lightTheme,
): Promise<RenderResult> {
  useLibraryStore.setState({
    hydrated: true,
    maps: state.maps ?? [],
    tracks: state.tracks ?? TRAILS,
    folders: state.folders ?? [],
    waypoints: state.waypoints ?? [],
    areas: [],
    activeTrackIds: [],
    activeMapId: null,
    visibleFolderIds: [],
    customCategories: [],
  });
  const view = await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider theme={theme}>
        <LibraryScreen />
      </PaperProvider>
    </SafeAreaProvider>,
  );
  return view;
}

// RNTL 14: events are async and wrap act themselves.
const press = (node: Parameters<typeof fireEvent.press>[0]) => fireEvent.press(node);
const hold = (node: Parameters<typeof fireEvent>[0]) => fireEvent(node, 'longPress');
const row = (view: RenderResult, name: string) => view.getByLabelText(new RegExp(`^${name}\\b`));
const folderOf = (id: string) =>
  useLibraryStore.getState().tracks.find((t) => t.id === id)?.folderId;

type Back = () => boolean | null | undefined;
let backHandlers: Back[] = [];
beforeEach(() => {
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
    backHandlers.push(h as Back);
    return { remove: () => (backHandlers = backHandlers.filter((x) => x !== h)) };
  });
  mockNavigate.mockReset();
  mockDeleteFile.mockReset();
  mockDeletePhotos.mockReset();
  jest.mocked(sendCopy).mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllTimers();
});

describe('entering and leaving select mode', () => {
  it('a hold selects the row; the header counts, and the bar replaces the tab bar', async () => {
    const view = await show({});
    expect(view.queryByTestId('library-action-bar')).toBeNull();
    await hold(row(view, 'Mont Jacques-Cartier'));
    expect(view.getByText('1 selected')).toBeOnTheScreen();
    expect(view.getByText('1 trail')).toBeOnTheScreen();
    expect(view.getByTestId('library-action-bar')).toBeOnTheScreen();
    // The tab bar hides while the bar owns the bottom edge.
    expect(useScreenSheetStore.getState().open).toBe(1);
    // Taps now toggle instead of opening the trail.
    await press(row(view, 'Lac-aux-Américains loop'));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(view.getByText('2 selected')).toBeOnTheScreen();
    expect(row(view, 'Lac-aux-Américains loop')).toHaveProp(
      'accessibilityLabel',
      'Lac-aux-Américains loop — selected, tap to deselect',
    );
    expect(row(view, 'Lac-aux-Américains loop')).toHaveProp('accessibilityState', {
      selected: true,
    });
  });

  it('deselecting the last row leaves, and so do ✕ and Back', async () => {
    const view = await show({});
    await hold(row(view, 'Cap-Chat'));
    await press(row(view, 'Cap-Chat'));
    expect(view.queryByText(/selected$/)).toBeNull();
    expect(useScreenSheetStore.getState().open).toBe(0);

    await hold(row(view, 'Cap-Chat'));
    await press(view.getByLabelText('Exit selection'));
    expect(view.queryByTestId('library-action-bar')).toBeNull();

    await hold(row(view, 'Cap-Chat'));
    await act(async () => {
      backHandlers[backHandlers.length - 1]?.();
    });
    expect(view.queryByTestId('library-action-bar')).toBeNull();
    // Out of select mode a tap opens the trail again.
    await press(row(view, 'Cap-Chat'));
    expect(mockNavigate).toHaveBeenCalledWith('/trail3d/t3');
  });

  it('mixes kinds, and dims Merge in place with the reason as tap and hint', async () => {
    const view = await show({
      maps: [map('m1', 'Mont-Albert')],
      waypoints: [waypoint('w1', 'Refuge du Mont-Albert')],
    });
    await hold(row(view, 'Mont-Albert'));
    await press(row(view, 'Mont Jacques-Cartier'));
    await press(row(view, 'Refuge du Mont-Albert'));
    expect(view.getByText('3 selected')).toBeOnTheScreen();
    expect(view.getByText('1 map · 1 trail · 1 waypoint')).toBeOnTheScreen();
    const mergeSlot = view.getByTestId('library-action-merge');
    const why =
      'Merge joins trails only. This selection also has 1 map and 1 waypoint. Select only trails to merge them.';
    expect(mergeSlot).toHaveProp('accessibilityHint', why);
    expect(mergeSlot).toHaveProp('accessibilityState', { disabled: true });
    await press(mergeSlot);
    expect(view.getByText(why)).toBeOnTheScreen();
    // The bubble goes by itself.
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(view.queryByText(why)).toBeNull();
    // The slots never reorder.
    expect(
      ['move', 'show', 'share', 'merge', 'delete'].map((id) =>
        view.getByTestId(`library-action-${id}`),
      ),
    ).toHaveLength(5);
  });

  it('Select all covers what is in view (the chip), then reads Deselect all', async () => {
    const view = await show({ maps: [map('m1', 'Mont-Albert')] });
    await press(view.getByText(/^Trails/));
    await hold(row(view, 'Cap-Chat'));
    await press(view.getByTestId('library-select-all'));
    expect(view.getByText('3 selected')).toBeOnTheScreen();
    expect(view.getByText('3 trails')).toBeOnTheScreen();
    expect(view.getByLabelText('Deselect all')).toBeOnTheScreen();
    await press(view.getByLabelText('Deselect all'));
    expect(view.queryByTestId('library-action-bar')).toBeNull();
  });
});

describe('the hold into select mode ticks (#711)', () => {
  const os = Platform.OS;
  afterEach(() => {
    Platform.OS = os;
  });

  it('one light tick on Android as a hold enters select mode, none while selecting', async () => {
    Platform.OS = 'android';
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const view = await show({});
    await hold(row(view, 'Cap-Chat'));
    expect(vibrate.mock.calls).toEqual([[SELECT_TICK_MS]]);
    // Already selecting: a hold toggles, without a tick.
    await hold(row(view, 'Mont Jacques-Cartier'));
    expect(vibrate).toHaveBeenCalledTimes(1);
    // Out and back in: a tick again.
    await press(view.getByLabelText('Exit selection'));
    await hold(row(view, 'Cap-Chat'));
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it('a folder held by its header ticks too', async () => {
    Platform.OS = 'android';
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const view = await show({
      tracks: [track('t1', 'A', { folderId: 'f1' })],
      folders: [{ id: 'f1', name: 'Gaspésie 2026', createdAt: 1 }],
    });
    await hold(view.getByText(/^Gaspésie 2026/));
    expect(vibrate.mock.calls).toEqual([[SELECT_TICK_MS]]);
  });

  it('no tick on iOS (its Vibration is a 400 ms buzz, not a tick)', async () => {
    Platform.OS = 'ios';
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const view = await show({});
    await hold(row(view, 'Cap-Chat'));
    expect(view.getByText('1 selected')).toBeOnTheScreen();
    expect(vibrate).not.toHaveBeenCalled();
  });
});

describe('Move to…', () => {
  const folders: Folder[] = [
    { id: 'f1', name: 'Gaspésie 2026', createdAt: 1 },
    { id: 'f2', name: 'Charlevoix', createdAt: 2 },
  ];

  it('files the selection in a new folder, then Undo puts each item back', async () => {
    const scrollToIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => undefined);
    const view = await show({
      tracks: [
        track('t1', 'Mont Jacques-Cartier', { folderId: 'f2' }),
        track('t2', 'Lac-aux-Américains loop'),
        track('t3', 'Cap-Chat'),
      ],
      folders,
    });
    await hold(row(view, 'Mont Jacques-Cartier'));
    await press(row(view, 'Lac-aux-Américains loop'));
    await press(view.getByTestId('library-action-move'));
    expect(view.getByText('Move 2 items to…')).toBeOnTheScreen();
    expect(view.getByText('Name it, and the 2 items go in')).toBeOnTheScreen();
    // Folders with their counts; Remove applies (t1 is in Charlevoix).
    expect(view.getByLabelText('Gaspésie 2026, 0 items')).toBeOnTheScreen();
    expect(view.getByLabelText('Charlevoix, 1 item')).toBeOnTheScreen();
    expect(view.getByLabelText('Remove from folder')).toBeOnTheScreen();

    await press(view.getByTestId('library-move-new-folder'));
    expect(view.queryByTestId('library-move-sheet')).toBeNull();
    await fireEvent.changeText(view.getByTestId('name-dialog-input'), 'Parc');
    await press(view.getByText('Create'));
    const parc = useLibraryStore.getState().folders.find((f) => f.name === 'Parc');
    expect(folderOf('t1')).toBe(parc?.id);
    expect(folderOf('t2')).toBe(parc?.id);
    expect(view.queryByTestId('library-action-bar')).toBeNull();
    expect(view.getByText('Moved 2 trails to Parc')).toBeOnTheScreen();
    expect(view.getByText('Parc (2)')).toBeOnTheScreen();
    // The destination's header lands fully below the chips, with a gap, once
    // the moved rows have laid out (QA 2.6.1: it was tucked under the chips).
    expect(scrollToIndex).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ viewPosition: 0, viewOffset: MOVED_HEADER_GAP }),
    );
    expect(MOVED_HEADER_GAP).toBeGreaterThan(0);

    await press(view.getByLabelText('Undo'));
    expect(folderOf('t1')).toBe('f2');
    expect(folderOf('t2')).toBeUndefined();
    expect(view.queryByText('Moved 2 trails to Parc')).toBeNull();
    scrollToIndex.mockRestore();
  });

  it('marks the current folder (a no-op) and leaves Remove out when nothing is filed', async () => {
    const view = await show({
      tracks: [track('t1', 'A', { folderId: 'f1' }), track('t2', 'B', { folderId: 'f1' })],
      folders,
    });
    await hold(row(view, 'A'));
    await press(row(view, 'B'));
    await press(view.getByTestId('library-action-move'));
    expect(view.getByLabelText('Gaspésie 2026, 2 items, current folder')).toBeOnTheScreen();
    expect(view.getByText('· current', { exact: false })).toBeOnTheScreen();
    await press(view.getByLabelText('Gaspésie 2026, 2 items, current folder'));
    expect(view.queryByTestId('library-move-sheet')).toBeNull();
    expect(view.getByText('2 selected')).toBeOnTheScreen();

    await press(view.getByLabelText('Exit selection'));
    await act(async () => {
      useLibraryStore.setState({ tracks: [track('t9', 'Loose')] });
    });
    await hold(row(view, 'Loose'));
    await press(view.getByTestId('library-action-move'));
    expect(view.queryByLabelText('Remove from folder')).toBeNull();
    // A tap on a folder moves it there and flashes the moved row.
    await press(view.getByLabelText('Charlevoix, 0 items'));
    expect(folderOf('t9')).toBe('f2');
    expect(view.getByText('Moved 1 trail to Charlevoix')).toBeOnTheScreen();
  });

  it('the Undo snackbar goes after 6 s', async () => {
    const view = await show({ folders });
    await hold(row(view, 'Cap-Chat'));
    await press(view.getByTestId('library-action-move'));
    await press(view.getByLabelText('Gaspésie 2026, 0 items'));
    expect(view.getByTestId('library-undo-bar')).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(5900);
    });
    expect(view.getByTestId('library-undo-bar')).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(view.queryByTestId('library-undo-bar')).toBeNull();
    expect(folderOf('t3')).toBe('f1');
  });
});

describe('Delete with Undo', () => {
  it('takes the items out at once, and deletes their files only once Undo has passed', async () => {
    const view = await show({
      waypoints: [waypoint('w1', 'Belvédère', { photoUri: 'file:///w.jpg' })],
    });
    await hold(row(view, 'Cap-Chat'));
    await press(row(view, 'Belvédère'));
    await press(view.getByTestId('library-action-delete'));
    expect(useLibraryStore.getState().tracks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(useLibraryStore.getState().waypoints).toEqual([]);
    expect(view.getByText('Deleted 2 items')).toBeOnTheScreen();
    expect(mockDeleteFile).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(6000);
    });
    expect(mockDeleteFile.mock.calls.map((c) => c[0])).toEqual(['file:///t3.gpx', 'file:///w.jpg']);
    expect(mockDeletePhotos).toHaveBeenCalledWith('t3');
  });

  it('Undo puts them back where they were, and no file is touched', async () => {
    const view = await show({});
    await act(async () => {
      useLibraryStore.setState({ activeTrackIds: ['t2'] });
    });
    await hold(row(view, 'Lac-aux-Américains loop'));
    await press(view.getByTestId('library-action-delete'));
    expect(view.getByText('Deleted 1 trail')).toBeOnTheScreen();
    await press(view.getByLabelText('Undo'));
    expect(useLibraryStore.getState().tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2']);
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });
});

describe('Show on map, Merge, Share', () => {
  it('shows the trails on the map, then the slot reads Hide from map', async () => {
    const view = await show({});
    await hold(row(view, 'Cap-Chat'));
    await press(row(view, 'Mont Jacques-Cartier'));
    await press(view.getByTestId('library-action-show'));
    expect(useLibraryStore.getState().activeTrackIds).toEqual(['t3', 't1']);
    expect(view.getByText('Showing 2 items on the map')).toBeOnTheScreen();
    expect(view.getByTestId('library-action-show')).toHaveProp(
      'accessibilityLabel',
      'Hide from map',
    );
    // It wraps rather than being cut to "Hide from m…" on a 360 dp phone (#711).
    expect(view.getByText('Hide from map')).toHaveProp('numberOfLines', 2);
    await press(view.getByTestId('library-action-show'));
    expect(useLibraryStore.getState().activeTrackIds).toEqual([]);
  });

  it('waypoints alone cannot be shown or hidden: the slot says why', async () => {
    const view = await show({ waypoints: [waypoint('w1', 'Belvédère')] });
    await hold(row(view, 'Belvédère'));
    expect(view.getByTestId('library-action-show')).toHaveProp(
      'accessibilityHint',
      'Waypoints and areas are always on the map.',
    );
  });

  it("a trail's ⋮ Share opens the sheet: the .gpx and its size, then the system sheet", async () => {
    const view = await show({ tracks: [TRAILS[0]!] });
    await press(view.getByLabelText('More options'));
    await press(view.getByText('Share'));
    expect(view.getByText('Share trail')).toBeOnTheScreen();
    expect(view.getByText('Mont Jacques-Cartier · 16.2 km')).toBeOnTheScreen();
    expect(view.getByText('Mont Jacques-Cartier.gpx')).toBeOnTheScreen();
    expect(view.getByText('412 KB')).toBeOnTheScreen();
    await press(view.getByTestId('library-share-send'));
    expect(sendCopy).toHaveBeenCalledWith(
      { kind: 'gpx', fileName: 'Mont Jacques-Cartier.gpx', sourceUri: 'file:///t1.gpx' },
      'Share trail',
    );
    expect(view.queryByTestId('library-share-sheet')).toBeNull();
  });

  it('a selection with a catalog map shares a zip and names the map as a link', async () => {
    const view = await show({
      maps: [
        map('c1', 'Rivière du Berger', {
          sourceItemId: 'cpa-1',
          sourceCredit: 'André Faubert',
          sourceFreeAt: 'cartespleinair.org',
          sourcePageUrl: 'https://cartespleinair.org/carte/1',
        }),
      ],
    });
    await hold(row(view, 'Rivière du Berger'));
    await press(row(view, 'Cap-Chat'));
    await press(view.getByTestId('library-action-share'));
    expect(view.getByText('Share 2 items')).toBeOnTheScreen();
    expect(view.getByText('Inukshuk · 2 items.zip')).toBeOnTheScreen();
    expect(view.getByText('Cap-Chat.gpx')).toBeOnTheScreen();
    expect(view.getByText('Catalog maps.txt (1 link)')).toBeOnTheScreen();
    expect(
      view.getByText(
        'Rivière du Berger goes as a link. Catalog maps are shared as their page on cartespleinair.org, with the author credit, never as the file.',
      ),
    ).toBeOnTheScreen();
  });

  it('Merge joins two or more trails, and leaves select mode', async () => {
    const view = await show({});
    await hold(row(view, 'Cap-Chat'));
    expect(view.getByTestId('library-action-merge')).toHaveProp(
      'accessibilityHint',
      'Select 2 or more trails to merge them.',
    );
    await press(row(view, 'Mont Jacques-Cartier'));
    expect(view.getByTestId('library-action-merge')).toHaveProp('accessibilityState', {
      disabled: false,
    });
  });
});

describe('a folder held by its header', () => {
  const folders: Folder[] = [{ id: 'f1', name: 'Gaspésie 2026', createdAt: 1 }];

  it('selects the folder itself: its bar, Rename, and Delete with Undo', async () => {
    const view = await show({
      tracks: [track('t1', 'A', { folderId: 'f1' }), track('t2', 'B', { folderId: 'f1' })],
      folders,
    });
    await hold(view.getByText(/^Gaspésie 2026/));
    expect(view.getByText('Folder · 2 items')).toBeOnTheScreen();
    expect(view.queryByTestId('library-select-all')).toBeNull();
    expect(
      ['share', 'show', 'rename', 'delete'].map(
        (id) => view.getByTestId(`library-folder-action-${id}`).props.accessibilityLabel,
      ),
    ).toEqual(['Share folder', 'Show on map', 'Rename', 'Delete']);

    await press(view.getByTestId('library-folder-action-rename'));
    expect(view.getByText('Rename folder')).toBeOnTheScreen();
    await press(view.getByText('Cancel'));

    await press(view.getByTestId('library-folder-action-delete'));
    expect(useLibraryStore.getState().folders).toEqual([]);
    expect(folderOf('t1')).toBeUndefined();
    expect(view.getByText('Deleted folder "Gaspésie 2026"')).toBeOnTheScreen();
    await press(view.getByLabelText('Undo'));
    expect(useLibraryStore.getState().folders.map((f) => f.name)).toEqual(['Gaspésie 2026']);
    expect(folderOf('t1')).toBe('f1');
    expect(folderOf('t2')).toBe('f1');
  });

  it('holding a row switches to item selection; Share folder zips it under its name', async () => {
    const view = await show({ tracks: [track('t1', 'A', { folderId: 'f1' })], folders });
    await hold(view.getByText(/^Gaspésie 2026/));
    await press(view.getByTestId('library-folder-action-share'));
    expect(view.getByText('Share “Gaspésie 2026”')).toBeOnTheScreen();
    expect(view.getByText('Gaspésie 2026.zip')).toBeOnTheScreen();
    await press(view.getAllByLabelText('Close').at(-1)!);
    await hold(row(view, 'A'));
    expect(view.getByText('1 selected')).toBeOnTheScreen();
  });
});

describe('themes', () => {
  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)(
    '%s: the selected row takes the sage fill, the primary slot its pill',
    async (_n, theme) => {
      const view = await show({}, theme);
      await hold(row(view, 'Cap-Chat'));
      // Some ancestor of the row's Pressable (its frame) carries the fill.
      const fills: unknown[] = [];
      for (let n = row(view, 'Cap-Chat').parent; n; n = n.parent) {
        fills.push(StyleSheet.flatten(n.props.style ?? {})?.backgroundColor);
      }
      expect(fills).toContain(theme.colors.secondaryContainer);
      // …and an unselected row does not.
      const other: unknown[] = [];
      for (let n = row(view, 'Mont Jacques-Cartier').parent; n; n = n.parent) {
        other.push(StyleSheet.flatten(n.props.style ?? {})?.backgroundColor);
      }
      expect(other).not.toContain(theme.colors.secondaryContainer);
      const bar = view.getByTestId('library-action-bar');
      expect(StyleSheet.flatten(bar.props.style).backgroundColor).toBe(
        theme.colors.elevation.level2,
      );
      await press(view.getByTestId('library-action-delete'));
      const undo = view.getByTestId('library-undo-bar');
      expect(StyleSheet.flatten(undo.props.style).backgroundColor).toBe(
        theme.colors.inverseSurface,
      );
    },
  );
});
