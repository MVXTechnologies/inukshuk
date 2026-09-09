import { buildGpx } from '@core/geo/gpx';
import { computeTrackStats } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import { useLibraryStore } from '@state/libraryStore';
import { act, fireEvent, render } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LibraryScreen } from './LibraryScreen';

// Native press dispatch does not await async event-handler return values.
jest.mock('react-native-paper', () => {
  const paper = jest.requireActual('react-native-paper');
  const { Pressable } = jest.requireActual('react-native');
  return {
    ...paper,
    IconButton: ({
      onPress,
      ...props
    }: {
      onPress?: () => unknown;
      accessibilityLabel?: string;
    }) => (
      <Pressable
        {...props}
        onPress={() => {
          void onPress?.();
        }}
      />
    ),
  };
});

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }) }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('@data/storage', () => ({
  newId: () => 'id',
  readFileText: jest.fn(),
  deleteFileAt: jest.fn(),
  writeIndex: jest.fn(),
  toDocumentPath: (uri: string) => uri,
  resolveDocumentPath: (path: string) => path,
  documentDirUri: () => 'file:///Documents',
}));
jest.mock('@features/library/importMap', () => ({ pickAndImportMaps: jest.fn() }));
jest.mock('@features/library/importGpx', () => ({ pickAndImportGpxFiles: jest.fn() }));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('../common/components/ElevationProfile', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    ElevationProfile: ({ points }: { points: TrackPoint[] }) => (
      <Text testID="elevation-points">{points.map((point) => point.altitude).join(',')}</Text>
    ),
  };
});

const points = (altitudes: number[]): TrackPoint[] =>
  altitudes.map((altitude, i) => ({
    latitude: 45 + i / 1000,
    longitude: -73,
    altitude,
    time: 1000 * i,
  }));
const summary = (id: string, pts: TrackPoint[]): TrackSummary => ({
  id,
  name: id,
  fileUri: `file:///${id}.gpx`,
  startedAt: 1000,
  stats: computeTrackStats(pts),
});
async function show(tracks: TrackSummary[]) {
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

beforeEach(() => {
  jest.mocked(storage.readFileText).mockReset();
});

it('refreshes an expanded elevation profile after overwrite with the same id and URI', async () => {
  const before = points([100, 200, 300]);
  const after = before.slice(1);
  jest
    .mocked(storage.readFileText)
    .mockResolvedValueOnce(buildGpx({ points: before }))
    .mockResolvedValueOnce(buildGpx({ points: after }));
  const track = summary('trail', before);
  const view = await show([track]);
  await fireEvent.press(view.getByLabelText('Elevation profile'));
  expect(view.getByTestId('elevation-points').props.children).toBe('100,200,300');
  await act(() =>
    useLibraryStore.setState({ tracks: [{ ...track, stats: computeTrackStats(after) }] }),
  );
  expect(view.getByTestId('elevation-points').props.children).toBe('200,300');
  expect(storage.readFileText).toHaveBeenCalledTimes(2);
});

it('ignores a failed obsolete read after another profile has been expanded', async () => {
  let rejectOld: ((error: Error) => void) | undefined;
  jest
    .mocked(storage.readFileText)
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    )
    .mockResolvedValueOnce(buildGpx({ points: points([400, 500]) }));
  const view = await show([summary('a', points([100, 200])), summary('b', points([400, 500]))]);
  const actions = view.getAllByLabelText('Elevation profile');
  await fireEvent.press(actions[0]!);
  await fireEvent.press(actions[1]!);
  expect(view.getByTestId('elevation-points').props.children).toBe('400,500');
  await act(() => rejectOld?.(new Error('old read failed')));
  expect(view.getByTestId('elevation-points').props.children).toBe('400,500');
  expect(view.queryByText('Could not load elevation')).toBeNull();
});

it('lets a failed current preview be retried without replaying its old error', async () => {
  let finishRetry: ((text: string) => void) | undefined;
  jest
    .mocked(storage.readFileText)
    .mockRejectedValueOnce(new Error('temporarily unavailable'))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetry = resolve;
        }),
    );
  const pts = points([500, 600]);
  const view = await show([summary('retry', pts)]);
  await fireEvent.press(view.getByLabelText('Elevation profile'));
  expect(view.getByText('Could not load elevation')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('Elevation profile'));
  await act(() => finishRetry?.(buildGpx({ points: pts })));
  expect(view.getByTestId('elevation-points').props.children).toBe('500,600');
});

it('ignores an old successful read that finishes after a revised profile has loaded', async () => {
  let finishOld: ((text: string) => void) | undefined;
  const before = points([100, 200, 300]);
  const after = before.slice(1);
  jest
    .mocked(storage.readFileText)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(buildGpx({ points: after }));
  const track = summary('trail', before);
  const view = await show([track]);
  await fireEvent.press(view.getByLabelText('Elevation profile'));
  await act(() =>
    useLibraryStore.setState({ tracks: [{ ...track, stats: computeTrackStats(after) }] }),
  );
  expect(view.getByTestId('elevation-points').props.children).toBe('200,300');
  await act(() => finishOld?.(buildGpx({ points: before })));
  expect(view.getByTestId('elevation-points').props.children).toBe('200,300');
});

it('reuses a cached profile when the same summary is collapsed and reopened', async () => {
  const pts = points([100, 200]);
  jest.mocked(storage.readFileText).mockResolvedValue(buildGpx({ points: pts }));
  const view = await show([summary('same', pts)]);
  await fireEvent.press(view.getByLabelText('Elevation profile'));
  await fireEvent.press(view.getByLabelText('Elevation profile'));
  await fireEvent.press(view.getByLabelText('Elevation profile'));
  expect(view.getByTestId('elevation-points').props.children).toBe('100,200');
  expect(storage.readFileText).toHaveBeenCalledTimes(1);
});
