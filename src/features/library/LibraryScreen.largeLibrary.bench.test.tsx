/**
 * Large-library Library benchmark: first render and a full scroll with
 * 400 and 2,000 trails (in memory). Skipped unless BENCH=1:
 *
 *   BENCH=1 npx jest src/features/library/LibraryScreen.largeLibrary.bench
 *
 * Prints timings, rows mounted and thumbnail hook calls; the CI-sized
 * regression guards live in `LibraryScreen.largeLibrary.test.tsx`.
 */
import type { TrackSummary } from '@core/models';
import { LibraryScreen } from '@features/library/LibraryScreen';
import { useLibraryStore } from '@state/libraryStore';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { layoutList, scrollListTo } from './virtualListTestUtils';

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

const track = (i: number): TrackSummary => ({
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
});

async function show(tracks: TrackSummary[]): Promise<RenderResult> {
  useLibraryStore.setState({
    hydrated: true,
    maps: [],
    tracks,
    folders: [],
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
const ROW_PX = 77;

const d = process.env.BENCH ? describe : describe.skip;
jest.setTimeout(600_000);

d('Library with a large library', () => {
  it.each([400, 2000])('N=%i: first render, then scroll to the end', async (n) => {
    const tracks = Array.from({ length: n }, (_, i) => track(i));
    mockThumbnailCalls.mockClear();
    let t0 = performance.now();
    const view = await show(tracks);
    const firstMs = performance.now() - t0;
    const firstRows = trailRows(view);
    const firstThumbs = mockThumbnailCalls.mock.calls.length;

    const list = view.getByTestId('library-list');
    const geometry = { viewportPx: 760, itemCount: n + 1, cellPx: ROW_PX };
    await layoutList(view, list, geometry);
    mockThumbnailCalls.mockClear();
    let maxRows = firstRows;
    let steps = 0;
    t0 = performance.now();
    // Scroll top to bottom one screen at a time, like a long fling session.
    for (let y = 0; y < n * ROW_PX; y += geometry.viewportPx) {
      steps++;
      await scrollListTo(view, list, y, geometry);
      maxRows = Math.max(maxRows, trailRows(view));
    }
    const scrollMs = performance.now() - t0;
    const thumbsDuringScroll = mockThumbnailCalls.mock.calls.length;

    // An unrelated re-render (a card menu, a selection) after the scroll.
    mockThumbnailCalls.mockClear();
    t0 = performance.now();
    await act(async () => {
      fireEvent.press(view.getByLabelText('Search trails'));
    });
    const rerenderMs = performance.now() - t0;
    const rerenderThumbs = mockThumbnailCalls.mock.calls.length;
    (globalThis as { gc?: () => void }).gc?.();
    const heapMb = process.memoryUsage().heapUsed / 1e6;

    console.log(
      `[Library N=${n}] first render ${firstMs.toFixed(0)} ms, rows mounted ${firstRows}, ` +
        `thumbnail hook calls ${firstThumbs}; scroll ${steps} screens ${scrollMs.toFixed(0)} ms, ` +
        `max rows mounted ${maxRows}, final rows ${trailRows(view)}, thumbnail hook calls ` +
        `${thumbsDuringScroll}; re-render after scroll ${rerenderMs.toFixed(0)} ms ` +
        `(${rerenderThumbs} row renders); heap ${heapMb.toFixed(0)} MB`,
    );
    await view.unmount();
  });
});
