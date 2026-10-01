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
 * #511 — the trail view: map + profile scrubber on top, then the remembered
 * tab (Overview · Timeline · Splits · Notes) and the sticky action bar.
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

function seed(timed: boolean, notes: TrackSummary['notes'] = []): void {
  const points = timed ? HIKE : HIKE.map((p) => ({ ...p, time: 0, hasTime: false }));
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
  // Points load, then the deferred analysis lands.
  await waitFor(() => expect(screen.getByTestId('trail-scrubber')).toBeTruthy());
  await waitFor(() => expect(screen.getByLabelText('Jump to Start')).toBeTruthy());
  return r;
}

beforeEach(() => {
  clearOutingAnalysisCache();
  mockNavigate.mockReset();
  useSettingsStore.setState({ hydrated: true, units: 'metric', trailViewTab: 'overview' });
});

it('opens on Overview with the six tiles and the photo strip, under the scrubber', async () => {
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
  expect(screen.getByTestId('trail-photo-strip')).toBeTruthy();
  expect(screen.getByTestId('trail-subtitle').props.children).toMatch(/^Hike · /);
  // The four tabs, and the bar's actions.
  for (const tab of ['overview', 'timeline', 'splits', 'notes']) {
    expect(screen.getByTestId(`trail-tab-${tab}`)).toBeTruthy();
  }
  expect(screen.getByText('Export')).toBeTruthy();
  expect(screen.getByText('Share')).toBeTruthy();
});

it('remembers the tab picked, for the next trail opened', async () => {
  seed(true);
  const first = await mount();
  await act(async () => fireEvent.press(screen.getByTestId('trail-tab-splits')));
  expect(useSettingsStore.getState().trailViewTab).toBe('splits');
  await waitFor(() => expect(screen.getAllByTestId('split-row')).toHaveLength(4));
  await act(async () => first.unmount());
  // The next trail opened starts on Splits.
  clearOutingAnalysisCache();
  useLibraryStore.setState({ tracks: [{ ...useLibraryStore.getState().tracks[0]!, id: 't2' }] });
  await mount('t2');
  expect(screen.getByTestId('trail-splits')).toBeTruthy();
});

it('tells the outing on the Timeline and moves the cursor to a tapped event', async () => {
  seed(true);
  useSettingsStore.setState({ trailViewTab: 'timeline' });
  await mount();
  await waitFor(() => expect(screen.getByTestId('trail-timeline')).toBeTruthy());
  const tl = within(screen.getByTestId('trail-timeline'));
  expect(tl.getByText('Start')).toBeTruthy();
  expect(tl.getByText('Steepest stretch')).toBeTruthy();
  // The stop on top folds into the summit.
  expect(tl.getByText(/^Summit · /)).toBeTruthy();
  expect(tl.getByText(/Stopped (9|10) min/)).toBeTruthy();
  expect(tl.getByText('Finish')).toBeTruthy();

  expect(screen.queryByTestId('scrub-time')).toBeNull();
  await act(async () => fireEvent.press(tl.getByText(/^Summit · /)));
  // Readout: distance · elevation · grade · clock time at the cursor.
  expect(screen.getByTestId('scrub-time')).toBeTruthy();
  // …and the event under the cursor (and the Summit chip) read as selected.
  expect(screen.getByLabelText(/Summit · .*Stopped/).props.accessibilityState).toMatchObject({
    selected: true,
  });
  expect(screen.getByLabelText('Jump to Summit').props.accessibilityState).toMatchObject({
    selected: true,
  });
});

it('jumps with the quick chips', async () => {
  seed(true);
  await mount();
  await waitFor(() => expect(screen.getByLabelText('Jump to Summit')).toBeTruthy());
  expect(screen.getByLabelText('Jump to Start')).toBeTruthy();
  expect(screen.getByLabelText('Jump to Steepest')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('Jump to End')));
  expect(screen.getByLabelText('Jump to End').props.accessibilityState).toMatchObject({
    selected: true,
  });
});

it('gives an untimed route no Timeline, no times and climb-only splits', async () => {
  seed(false);
  useSettingsStore.setState({ trailViewTab: 'timeline' });
  await mount();
  expect(screen.queryByTestId('trail-tab-timeline')).toBeNull();
  // The remembered Timeline falls back to Overview without overwriting it.
  expect(screen.getByTestId('trail-overview')).toBeTruthy();
  expect(useSettingsStore.getState().trailViewTab).toBe('timeline');
  expect(screen.queryByText('Moving time')).toBeNull();
  expect(screen.getByText('Lowest point')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('Jump to End')));
  expect(screen.queryByTestId('scrub-time')).toBeNull();
  await act(async () => fireEvent.press(screen.getByTestId('trail-tab-splits')));
  await waitFor(() => expect(screen.getAllByTestId('split-row').length).toBeGreaterThan(0));
  expect(screen.queryByText('pace')).toBeNull();
  expect(screen.getByText('down')).toBeTruthy();
});

it('keeps notes editable in the Notes tab', async () => {
  seed(true, [{ id: 'n1', distanceM: 1500, text: 'Spring', createdAt: 0 }]);
  useSettingsStore.setState({ trailViewTab: 'notes' });
  await mount();
  expect(screen.getByText('Notes (1)')).toBeTruthy();
  expect(screen.getByLabelText('Edit note')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('Delete note')));
  expect(useLibraryStore.getState().tracks[0]!.notes ?? []).toHaveLength(0);
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
