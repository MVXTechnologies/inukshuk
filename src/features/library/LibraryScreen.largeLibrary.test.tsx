/**
 * A 400-trail Library (#465): only a page of trail rows (and so of route
 * thumbnails) mounts, more follow on demand, and an import flush landing
 * while the Library is open re-renders a page, not the whole library.
 */
import type { Folder, TrackSummary } from '@core/models';
import { LIBRARY_ROW_PAGE } from '@core/library/rowBudget';
import { LibraryScreen } from '@features/library/LibraryScreen';
import { useLibraryStore } from '@state/libraryStore';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

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

const trailRows = (view: RenderResult) => view.queryAllByLabelText(/open 3D view/).length;

beforeEach(() => mockThumbnailCalls.mockClear());
// Newly mounted rows start paper Menu animations; let them end inside act.
afterEach(async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
});

it('mounts one page of rows (and thumbnails) for 400 trails, more on demand', async () => {
  const view = await show(library(400));
  expect(trailRows(view)).toBe(LIBRARY_ROW_PAGE);
  expect(new Set(mockThumbnailCalls.mock.calls.map((c) => c[0])).size).toBe(LIBRARY_ROW_PAGE);
  // The section still counts every trail.
  expect(view.getByText('(400)')).toBeOnTheScreen();

  await act(async () => {
    fireEvent.press(view.getByLabelText('Show more trails'));
  });
  expect(trailRows(view)).toBe(2 * LIBRARY_ROW_PAGE);
});

it('mounts the next page when the list is scrolled near its end', async () => {
  const view = await show(library(400));
  const list = view.getByTestId('library-list');
  await act(async () => {
    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 4000 },
        layoutMeasurement: { height: 800 },
        contentSize: { height: 5000 },
      },
    });
  });
  expect(trailRows(view)).toBe(2 * LIBRARY_ROW_PAGE);
});

it('keeps a small library whole (no "show more")', async () => {
  const view = await show(library(12));
  expect(trailRows(view)).toBe(12);
  expect(view.queryByLabelText('Show more trails')).toBeNull();
});

it('spends the budget top to bottom across folders; a collapsed folder spends none', async () => {
  const folders: Folder[] = [
    { id: 'f1', name: 'Commutes', createdAt: 1 },
    { id: 'f2', name: 'Long runs', createdAt: 2 },
  ];
  const tracks = library(400, (i) => (i < 150 ? 'f1' : i < 300 ? 'f2' : undefined));
  const view = await show(tracks, folders);
  expect(trailRows(view)).toBe(LIBRARY_ROW_PAGE);
  // Headers keep their full counts.
  expect(view.getAllByText('(150)')).toHaveLength(2);
  expect(view.getByText('(100)')).toBeOnTheScreen();

  // Collapse the first folder: the page moves on to the next one.
  await act(async () => {
    fireEvent.press(view.getByText(/^Commutes/));
  });
  expect(trailRows(view)).toBe(LIBRARY_ROW_PAGE);
  expect(view.queryByText('Run 0')).toBeNull();
});

it('re-renders one page when an import flush adds trails while the Library is open', async () => {
  const view = await show(library(400));
  mockThumbnailCalls.mockClear();
  await act(async () => {
    useLibraryStore.setState({
      tracks: [
        ...library(10).map((t) => ({ ...t, id: `new${t.id}` })),
        ...useLibraryStore.getState().tracks,
      ],
    });
  });
  expect(trailRows(view)).toBe(LIBRARY_ROW_PAGE);
  // Rows re-rendered by the flush: at most a page, never the whole library.
  expect(mockThumbnailCalls.mock.calls.length).toBeLessThanOrEqual(LIBRARY_ROW_PAGE);
});
