import { buildGpx } from '@core/geo/gpx';
import { computeSegmentedTrackStats } from '@core/geo/track';
import { walk } from '@core/geo/track/__fixtures__/walk';
import type { TrackSummary } from '@core/models';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Trail3DGLScreen } from './Trail3DGLScreen';
import { clearOutingAnalysisCache } from './trailView/useOutingAnalysis';

/**
 * #511 (board C2) — the trail view: a fixed map on top with a cursor readout,
 * then the remembered tab (Overview · Charts · Timeline · Splits) and the
 * sticky action bar.
 * MapLibre, the DEM fetch and the file read are stubbed; everything the
 * tabs show is computed from a synthetic outing.
 */
type Props = Record<string, unknown> & { children?: ReactNode };
jest.mock('@maplibre/maplibre-react-native', () => {
  const { forwardRef } = jest.requireActual<typeof import('react')>('react');
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Map: forwardRef((props: Props, _ref) => props.children ?? null),
    Camera: forwardRef(() => null),
    GeoJSONSource: passthrough,
    Marker: passthrough,
    Layer: () => null,
  };
});
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mockNavigate, push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
const mockGpx: { current: string } = { current: '' };
jest.mock('@data/storage', () => ({
  ...jest.requireActual<object>('@data/storage'),
  readFileText: jest.fn(async () => mockGpx.current),
  writeJson: jest.fn(),
}));
// The dormant three.js branch (#480): never mounted here, but imported.
jest.mock('expo-gl', () => ({ GLView: jest.requireActual('react-native').View }));
jest.mock('expo-three', () => ({ Renderer: jest.fn() }));
jest.mock('./dem', () => ({
  fetchHeightmap: jest.fn(() => Promise.reject(new Error('offline'))),
}));
jest.mock('../common/exportTrailPdf', () => ({
  exportTrailPdf: jest.fn(async () => undefined),
  SharingUnavailableError: class extends Error {},
}));

// Climb 1.2 km, a steep 400 m wall, a 10-minute stop on top, then down.
const HIKE = walk(
  [
    { m: 1200, s: 1200, rise: 30 },
    { m: 400, s: 600, rise: 100 },
    { m: 0, s: 600 },
    { m: 1600, s: 1300, rise: -130 },
  ],
  { stepS: 5 },
);

function seed(
  timed: boolean,
  notes: TrackSummary['notes'] = [],
  opts: { heartRate?: boolean } = {},
): void {
  let points = timed ? HIKE : HIKE.map((p) => ({ ...p, time: 0, hasTime: false }));
  if (opts.heartRate) points = points.map((p, i) => ({ ...p, heartRateBpm: 110 + (i % 40) }));
  mockGpx.current = buildGpx({ points });
  const stats = computeSegmentedTrackStats(points, [], { category: 'hike' });
  const track: TrackSummary = {
    id: 't1',
    name: 'Mont Sainte-Anne loop',
    startedAt: timed ? points[0]!.time : 0,
    ...(timed ? { endedAt: points[points.length - 1]!.time } : {}),
    stats,
    fileUri: 'file:///t1.gpx',
    category: 'hike',
    notes,
  };
  useLibraryStore.setState({ tracks: [track], customCategories: [] });
}

async function mount(trackId = 't1'): Promise<Awaited<ReturnType<typeof render>>> {
  const r = await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <Trail3DGLScreen trackId={trackId} />
      </PaperProvider>
    </SafeAreaProvider>,
  );
  // Points load, then the deferred analysis lands (no "…" placeholder left).
  await waitFor(() => expect(screen.getByTestId('trail-tab-content')).toBeTruthy());
  await waitFor(() => expect(screen.queryByText(/…$/)).toBeNull());
  if (useSettingsStore.getState().trailViewTab === 'overview') {
    await waitFor(() => expect(screen.getByLabelText('Jump to Start')).toBeTruthy());
  }
  return r;
}

beforeEach(() => {
  clearOutingAnalysisCache();
  mockNavigate.mockReset();
  useSettingsStore.setState({ hydrated: true, units: 'metric', trailViewTab: 'overview' });
});

it('opens on Overview: tiles, compact elevation chart, jump chips, photo strip', async () => {
  seed(true, [{ id: 'n1', distanceM: 1500, text: 'Spring\nWater is good', createdAt: 0 }]);
  await mount();
  expect(screen.getByTestId('trail-overview')).toBeTruthy();
  for (const label of [
    'Distance',
    'Climb / descent',
    'Moving time',
    'Moving pace',
    'Highest point',
    'Total time',
  ]) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.getByTestId('overview-elevation')).toBeTruthy();
  expect(screen.getByTestId('trail-photo-strip')).toBeTruthy();
  expect(screen.getByTestId('trail-subtitle').props.children).toMatch(/^Hike · /);
  for (const tab of ['overview', 'charts', 'timeline', 'splits']) {
    expect(screen.getByTestId(`trail-tab-${tab}`)).toBeTruthy();
  }
  expect(screen.queryByTestId('trail-tab-notes')).toBeNull();
  expect(screen.getByText('Export')).toBeTruthy();
  expect(screen.getByText('Share')).toBeTruthy();
});

it('shows the average heart rate when the trail has one', async () => {
  seed(true, [], { heartRate: true });
  await mount();
  expect(screen.getByText('Avg heart rate')).toBeTruthy();
  expect(screen.queryByText('Total time')).toBeNull();
});

it('remembers the tab picked, for the next trail opened', async () => {
  seed(true);
  const first = await mount();
  await act(async () => fireEvent.press(screen.getByTestId('trail-tab-splits')));
  expect(useSettingsStore.getState().trailViewTab).toBe('splits');
  await waitFor(() => expect(screen.getAllByTestId('split-row')).toHaveLength(4));
  await act(async () => first.unmount());
  clearOutingAnalysisCache();
  useLibraryStore.setState({ tracks: [{ ...useLibraryStore.getState().tracks[0]!, id: 't2' }] });
  await mount('t2');
  expect(screen.getByTestId('trail-splits')).toBeTruthy();
});

it('jumps with the chips: the map readout and every chart follow', async () => {
  seed(true, [], { heartRate: true });
  await mount();
  expect(screen.queryByTestId('map-readout')).toBeNull();
  await act(async () => fireEvent.press(screen.getByLabelText('Jump to Summit')));
  expect(screen.getByTestId('map-readout')).toBeTruthy();
  expect(screen.getByText(/ · summit$/)).toBeTruthy();
  expect(screen.getByLabelText('Jump to Summit').props.accessibilityState).toMatchObject({
    selected: true,
  });
  // Same cursor on the Charts tab: the summit is the stop, HR has a value.
  await act(async () => fireEvent.press(screen.getByTestId('trail-tab-charts')));
  expect(screen.getByTestId('chart-elevation-value').props.children).toMatch(/ m$/);
  expect(screen.getByTestId('chart-pace-value').props.children).toBe('stopped');
  expect(screen.getByTestId('chart-hr-value').props.children).toMatch(/^\d+ bpm$/);
});

it('scrubs every chart from a drag on any one of them', async () => {
  seed(true, [], { heartRate: true });
  useSettingsStore.setState({ trailViewTab: 'charts' });
  await mount();
  expect(screen.getByTestId('chart-hr')).toBeTruthy();
  const surface = screen.getByLabelText('Heart rate chart');
  await act(async () =>
    fireEvent(surface, 'layout', { nativeEvent: { layout: { width: 300, height: 80 } } }),
  );
  const pace = screen.getByLabelText('Pace chart');
  await act(async () =>
    fireEvent(pace, 'layout', { nativeEvent: { layout: { width: 300, height: 80 } } }),
  );
  // The stop on top is labelled on the pace chart, where its line breaks.
  // (SVG text isn't a host <Text>, so read it off the rendered tree.)
  expect(JSON.stringify(screen.toJSON())).toMatch(/stop (9|10) min/);
  const touch = { locationX: 30, pageX: 30, pageY: 0, identifier: 0, timestamp: 1 };
  await act(async () =>
    fireEvent(surface, 'responderGrant', {
      nativeEvent: { ...touch, touches: [touch], changedTouches: [touch] },
      touchHistory: {
        numberActiveTouches: 1,
        indexOfSingleActiveTouch: 0,
        mostRecentTimeStamp: 1,
        touchBank: [
          {
            touchActive: true,
            startPageX: 30,
            startPageY: 0,
            startTimeStamp: 1,
            currentPageX: 30,
            currentPageY: 0,
            currentTimeStamp: 1,
            previousPageX: 30,
            previousPageY: 0,
            previousTimeStamp: 1,
          },
        ],
      },
    }),
  );
  // 10 % along: walking uphill, so all three charts and the map read a value.
  expect(screen.getByTestId('chart-pace-value').props.children).toMatch(/\/km$/);
  expect(screen.getByTestId('chart-elevation-value').props.children).toMatch(/ m$/);
  expect(screen.getByTestId('map-readout')).toBeTruthy();
});

it('hides the heart-rate chart without heart rate', async () => {
  seed(true);
  useSettingsStore.setState({ trailViewTab: 'charts' });
  await mount();
  expect(screen.getByTestId('chart-elevation')).toBeTruthy();
  expect(screen.getByTestId('chart-pace')).toBeTruthy();
  expect(screen.queryByTestId('chart-hr')).toBeNull();
});

it('tells the outing on the Timeline and moves the cursor to a tapped event', async () => {
  seed(true);
  useSettingsStore.setState({ trailViewTab: 'timeline' });
  await mount();
  const tl = within(screen.getByTestId('trail-timeline'));
  expect(tl.getByText('Start')).toBeTruthy();
  expect(tl.getByText('Steepest climb')).toBeTruthy();
  expect(tl.getByText(/^Summit · /)).toBeTruthy();
  expect(tl.getByText(/Stopped (9|10) min/)).toBeTruthy();
  expect(tl.getByText('Finish')).toBeTruthy();
  await act(async () => fireEvent.press(tl.getByText(/^Summit · /)));
  expect(screen.getByLabelText(/Summit · .*Stopped/).props.accessibilityState).toMatchObject({
    selected: true,
  });
  expect(screen.getByTestId('map-readout')).toBeTruthy();
});

it('keeps notes in the Timeline: add at the cursor, edit, hold to delete', async () => {
  seed(true, [{ id: 'n1', distanceM: 1500, text: 'Spring', createdAt: 0 }]);
  useSettingsStore.setState({ trailViewTab: 'timeline' });
  await mount();
  const tl = within(screen.getByTestId('trail-timeline'));
  // No cursor yet: the add button waits for one.
  expect(screen.getByText('Add a note here')).toBeTruthy();
  await act(async () => fireEvent.press(tl.getByText('Spring')));
  expect(screen.getByText(/^Add a note at /)).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText(/^Add a note at /)));
  expect(screen.getByText('New note')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText('Cancel')));
  await act(async () => fireEvent.press(screen.getByLabelText('Edit note 1')));
  expect(screen.getByText('Edit note')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText('Cancel')));
  const del = screen.getByLabelText('Delete note 1');
  expect(del.props.accessibilityHint).toBe('Press and hold to delete');
  await act(async () =>
    fireEvent(del, 'accessibilityAction', { nativeEvent: { actionName: 'delete' } }),
  );
  expect(useLibraryStore.getState().tracks[0]!.notes ?? []).toHaveLength(0);
});

it('gives an untimed route no times, an elevation-only Charts tab and climb-only splits', async () => {
  seed(false, [{ id: 'n1', distanceM: 1500, text: 'Bridge', createdAt: 0 }]);
  await mount();
  expect(screen.queryByText('Moving time')).toBeNull();
  expect(screen.getByText('Lowest point')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('Jump to End')));
  expect(screen.getByTestId('map-readout')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByTestId('trail-tab-charts')));
  expect(screen.getByTestId('chart-elevation')).toBeTruthy();
  expect(screen.queryByTestId('chart-pace')).toBeNull();
  expect(screen.queryByTestId('chart-hr')).toBeNull();
  // The Timeline stays (it holds the notes), with no clock times.
  await act(async () => fireEvent.press(screen.getByTestId('trail-tab-timeline')));
  const tl = within(screen.getByTestId('trail-timeline'));
  expect(tl.getByText('Bridge')).toBeTruthy();
  expect(tl.queryByText(/\d:\d\d/)).toBeNull();
  await act(async () => fireEvent.press(screen.getByTestId('trail-tab-splits')));
  await waitFor(() => expect(screen.getAllByTestId('split-row').length).toBeGreaterThan(0));
  expect(screen.queryByText('pace')).toBeNull();
  expect(screen.getByText('down')).toBeTruthy();
});

it('opens a note from the photo strip in the waypoint card', async () => {
  seed(true, [{ id: 'n1', distanceM: 1500, text: 'Spring', createdAt: 0 }]);
  await mount();
  await act(async () => fireEvent.press(screen.getByLabelText('Note 1: Spring')));
  expect(screen.getByText(/^Note 1 · /)).toBeTruthy();
  expect(screen.getByTestId('waypoint-note').props.children).toBe('Spring');
});

it('shows the trail on the main map from the bar', async () => {
  seed(true);
  await mount();
  await act(async () => fireEvent.press(screen.getByText('On map')));
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t1']);
  expect(mockNavigate).toHaveBeenCalledWith('/');
});
