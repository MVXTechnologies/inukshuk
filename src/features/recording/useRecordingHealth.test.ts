import type { TrackPoint } from '@core/models';
import { isApproximateLocation } from '@lib/recordingReadiness';
import { useRecorderStore } from '@state/recorderStore';
import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { FOREGROUND_REVIEW_DELAY_MS, useRecordingHealth } from './useRecordingHealth';

jest.mock('@lib/recordingReadiness', () => ({ isApproximateLocation: jest.fn() }));
jest.mock('@data/storage', () => ({
  newId: () => 'id_test',
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  writeTrackGpx: jest.fn(() => 'file://tracks/test.gpx'),
}));
jest.mock('@data/recorderCheckpoint', () => ({
  writeCheckpoint: jest.fn(() => true),
  maybeWriteCheckpoint: jest.fn(),
  readCheckpoint: jest.fn(async () => null),
  clearCheckpoint: jest.fn(),
  readBackgroundPoints: jest.fn(async () => []),
}));

const listeners = new Set<(s: AppStateStatus) => void>();
const appState = (s: AppStateStatus) => listeners.forEach((l) => l(s));

const T0 = Date.parse('2026-10-07T10:00:00Z');
const at = (sec: number, dLat: number): TrackPoint => ({
  latitude: 46.8 + dLat,
  longitude: -71.2,
  time: T0 + sec * 1000,
  accuracy: 5,
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  listeners.clear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'change') listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  });
  jest.mocked(isApproximateLocation).mockResolvedValue(false);
  useRecorderStore.getState().discard();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function startSession() {
  const onIssue = jest.fn();
  const view = await renderHook(() => useRecordingHealth({ onIssue }));
  await act(async () => {
    useRecorderStore.getState().start('Hike');
  });
  return { onIssue, view };
}

it('approximate location at start is left to the start gate, then explained after Stop', async () => {
  jest.mocked(isApproximateLocation).mockResolvedValue(true);
  const { onIssue, view } = await startSession();
  expect(onIssue).not.toHaveBeenCalled();
  const diag = view.result.current.capture();
  expect(diag?.preciseLocation).toBe(false);
  view.result.current.reviewStopped(diag!, []);
  expect(onIssue).toHaveBeenCalledWith(expect.stringContaining('Precise location is off'));
});

it('stays quiet for a healthy start', async () => {
  const { onIssue } = await startSession();
  expect(onIssue).not.toHaveBeenCalled();
});

it('after the screen comes back on, explains a screen-off gap once', async () => {
  const { onIssue } = await startSession();
  await act(async () => {
    useRecorderStore.getState().addPoint(at(0, 0));
  });
  // Pocket: screen off for 12 min, no fixes delivered.
  await act(async () => {
    appState('background');
  });
  jest.setSystemTime(T0 + 720_000);
  await act(async () => {
    appState('active');
  });
  // The first fresh fix lands 1 km on.
  jest.setSystemTime(T0 + 725_000);
  await act(async () => {
    useRecorderStore.getState().addPoint(at(725, 0.01));
  });
  expect(onIssue).not.toHaveBeenCalled(); // waits for fresh fixes first
  await act(async () => {
    jest.advanceTimersByTime(FOREGROUND_REVIEW_DELAY_MS);
  });
  expect(onIssue).toHaveBeenCalledTimes(1);
  expect(onIssue).toHaveBeenCalledWith(
    expect.stringMatching(/GPS updates stopped for 12 min while the screen was off/),
  );

  // A second spell in the same recording does not nag again live.
  await act(async () => {
    appState('background');
  });
  jest.setSystemTime(T0 + 1_500_000);
  await act(async () => {
    appState('active');
  });
  await act(async () => {
    useRecorderStore.getState().addPoint(at(1_500, 0.02));
  });
  await act(async () => {
    jest.advanceTimersByTime(FOREGROUND_REVIEW_DELAY_MS);
  });
  expect(onIssue).toHaveBeenCalledTimes(1);
});

it('does not blame the screen for a stationary rest', async () => {
  const { onIssue } = await startSession();
  await act(async () => {
    useRecorderStore.getState().addPoint(at(0, 0));
  });
  await act(async () => {
    appState('background');
  });
  jest.setSystemTime(T0 + 720_000);
  await act(async () => {
    appState('active');
  });
  await act(async () => {
    useRecorderStore.getState().addPoint(at(725, 0.0002));
  });
  await act(async () => {
    jest.advanceTimersByTime(FOREGROUND_REVIEW_DELAY_MS);
  });
  expect(onIssue).not.toHaveBeenCalled();
});

it('reviews the whole recording after Stop, using diagnostics captured before the reset', async () => {
  const { onIssue, view } = await startSession();
  await act(async () => {
    useRecorderStore.getState().addPoint(at(0, 0));
  });
  await act(async () => {
    appState('background');
  });
  jest.setSystemTime(T0 + 900_000);
  await act(async () => {
    useRecorderStore.getState().addPoint(at(900, 0.012));
  });
  // Stopped from the notification shade / lock screen: still in background.
  const diag = view.result.current.capture();
  expect(diag?.backgroundIntervals).toEqual([{ from: T0, to: T0 + 900_000 }]);
  const points = useRecorderStore.getState().points;
  const health = view.result.current.reviewStopped(diag!, points);
  expect(health.kind).toBe('background-gap');
  expect(onIssue).toHaveBeenCalledWith(expect.stringContaining('15 min'));
});

it('the post-Stop review explains an EMPTY approximate-location recording', async () => {
  const { onIssue, view } = await startSession();
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      useRecorderStore.getState().addPoint({ ...at(i * 5, 0), accuracy: 1_800 });
    }
  });
  expect(useRecorderStore.getState().points).toHaveLength(0);
  expect(useRecorderStore.getState().approximateFixes).toBe(10);
  const diag = view.result.current.capture();
  view.result.current.reviewStopped(diag!, []);
  expect(onIssue).toHaveBeenCalledWith(expect.stringContaining('Precise location is off'));
});

it('capture is null while idle', async () => {
  const view = await renderHook(() => useRecordingHealth({ onIssue: jest.fn() }));
  expect(view.result.current.capture()).toBeNull();
});
