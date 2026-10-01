/**
 * A 2,000-trail Library (#465, #494): the list is virtualized, so only rows
 * near the screen are mounted (and only they load route thumbnails), however
 * far the user scrolls; an unrelated re-render (a menu, the search field)
 * re-renders no trail row; an import flush landing while the Library is open
 * re-renders a window, not the library; the search filters once typing
 * pauses. The detailed numbers live in `LibraryScreen.largeLibrary.bench`.
 */
import type { Folder, TrackSummary } from '@core/models';
import { LibraryScreen } from '@features/library/LibraryScreen';
import { useLibraryStore } from '@state/libraryStore';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { layoutList, scrollListTo, type ListGeometry } from './virtualListTestUtils';

jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }),
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
const mockThumbnailCalls = jest.fn();
jest.mock('./useRouteThumbnail', () => ({
  useRouteThumbnail: (t: { id: string }) => {
    mockThumbnailCalls(t.id);
    return undefined;
  },
}));

const N = 2000;
/** What a phone shows: ~10 rows. Rows mounted must stay within a window of that. */
const MAX_MOUNTED_ROWS = 100;

const track = (i: number, folderId?: string): TrackSummary => ({
  id: `t${i}`,
  name: `Run ${i}`,
  fileUri: `file:///t${i}.gpx`,
  startedAt: Date.UTC(2025, 0, 1) + i * 86_400_000,
  category: 'run',
  stats: {
    distanceM: 5000 + i,
    ascentM: 10,
    descentM: 10,
    durationS: 1800,
    movingTimeS: 1800,
    avgSpeedMps: 3,
    maxSpeedMps: 4,
    pointCount: 1800,
  },
  ...(folderId ? { folderId } : {}),
});

const library = (n: number, folderOf?: (i: number) => string | undefined) =>
  Array.from({ length: n }, (_, i) => track(i, folderOf?.(i)));

async function show(tracks: TrackSummary[], folders: Folder[] = []): Promise<RenderResult> {
  useLibraryStore.setState({
    hydrated: true,
    maps: [],
    tracks,
    folders,
    waypoints: [],
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

const trailRows = (view: RenderResult) => view.queryAllByLabelText(/open trail view/).length;
const rowNamed = (view: RenderResult, name: string) =>
  view.queryByLabelText(new RegExp(`^${name},.*open trail view`));
const geometry: ListGeometry = { viewportPx: 760, itemCount: N + 1, cellPx: 77 };

beforeEach(() => mockThumbnailCalls.mockClear());
// Newly mounted rows start paper Menu animations; let them end inside act.
afterEach(async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
});

jest.setTimeout(60_000);

it(`mounts a screenful of the ${N} trails (and loads only their thumbnails)`, async () => {
  const view = await show(library(N));
  const rows = trailRows(view);
  expect(rows).toBeGreaterThan(5);
  expect(rows).toBeLessThanOrEqual(20);
  expect(new Set(mockThumbnailCalls.mock.calls.map((c) => c[0])).size).toBe(rows);
  // The section still counts every trail; there is no paging button.
  expect(view.getByText(`(${N})`)).toBeOnTheScreen();
  expect(view.queryByLabelText('Show more trails')).toBeNull();
});

it('keeps the mounted rows within a window wherever the list is scrolled', async () => {
  const view = await show(library(N));
  const list = view.getByTestId('library-list');
  await layoutList(view, list, geometry);
  // Newest first: "Run 1999" opens the list, "Run 0" ends it.
  expect(rowNamed(view, 'Run 1999')).not.toBeNull();
  expect(rowNamed(view, 'Run 1000')).toBeNull();

  for (const y of [5000, 40_000, 77_000, 120_000, N * 77 - 760]) {
    await scrollListTo(view, list, y, geometry);
    expect(trailRows(view)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
  }
  // At the end: the last trails are mounted, the middle ones are not.
  expect(rowNamed(view, 'Run 0')).not.toBeNull();
  expect(rowNamed(view, 'Run 1000')).toBeNull();
  // Thumbnails were only ever asked for rows that were mounted at some point.
  expect(new Set(mockThumbnailCalls.mock.calls.map((c) => c[0])).size).toBeLessThan(N / 2);
});

it('re-renders no trail row for a change elsewhere on the screen', async () => {
  const view = await show(library(N));
  mockThumbnailCalls.mockClear();
  await act(async () => {
    fireEvent.press(view.getByLabelText('Search trails'));
  });
  expect(view.getByLabelText('Search trails by name or folder')).toBeOnTheScreen();
  expect(mockThumbnailCalls).not.toHaveBeenCalled();
  // Opening one row's ⋮ menu re-renders that row only.
  await act(async () => {
    fireEvent.press(view.getAllByLabelText('More options')[0]!);
  });
  expect(new Set(mockThumbnailCalls.mock.calls.map((c) => c[0]))).toEqual(new Set(['t1999']));
});

it('re-renders a window when an import flush adds trails while the Library is open', async () => {
  const view = await show(library(N));
  mockThumbnailCalls.mockClear();
  await act(async () => {
    useLibraryStore.setState({
      tracks: [
        ...library(10).map((t) => ({ ...t, id: `new${t.id}`, startedAt: t.startedAt + 1e13 })),
        ...useLibraryStore.getState().tracks,
      ],
    });
  });
  expect(trailRows(view)).toBeLessThanOrEqual(20);
  expect(mockThumbnailCalls.mock.calls.length).toBeLessThanOrEqual(2 * 20);
  expect(view.getByText(`(${N + 10})`)).toBeOnTheScreen();
});

it('filters on the search once typing pauses', async () => {
  const view = await show(library(N));
  await act(async () => {
    fireEvent.press(view.getByLabelText('Search trails'));
  });
  const field = view.getByLabelText('Search trails by name or folder');
  await act(async () => {
    fireEvent.changeText(field, 'Run 1234');
  });
  // Still the whole library on this keystroke…
  expect(view.getByText(`(${N})`)).toBeOnTheScreen();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  // …and the match once typing has paused.
  expect(view.getByText(`(1/${N})`)).toBeOnTheScreen();
  expect(rowNamed(view, 'Run 1234')).not.toBeNull();
});

it('lists folders in order; a collapsed folder mounts no rows', async () => {
  const folders: Folder[] = [
    { id: 'f1', name: 'Commutes', createdAt: 1 },
    { id: 'f2', name: 'Long runs', createdAt: 2 },
  ];
  const tracks = library(N, (i) => (i < 800 ? 'f1' : i < 1600 ? 'f2' : undefined));
  const view = await show(tracks, folders);
  expect(trailRows(view)).toBeLessThanOrEqual(20);
  // The first folder's header keeps its full count; later sections are not
  // mounted yet.
  expect(view.getByText(/^Commutes/)).toBeOnTheScreen();
  expect(view.getByText('(800)')).toBeOnTheScreen();
  expect(view.queryByText(/^Long runs/)).toBeNull();
  expect(rowNamed(view, 'Run 799')).not.toBeNull();

  // Collapse the first folder: the next folder (and its rows) come up.
  await act(async () => {
    fireEvent.press(view.getByText(/^Commutes/));
  });
  expect(rowNamed(view, 'Run 799')).toBeNull();
  expect(view.getByText(/^Long runs/)).toBeOnTheScreen();
  expect(view.getAllByText('(800)')).toHaveLength(2);
  expect(rowNamed(view, 'Run 1599')).not.toBeNull();
  expect(trailRows(view)).toBeLessThanOrEqual(20);
});
