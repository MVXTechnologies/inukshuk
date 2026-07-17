import { BACKGROUND_FEED_FRESH_MS } from '@core/geo/track/backgroundFeed';
import { useRecorderStore } from '@state/recorderStore';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  isBackgroundFeedConfirmed,
  resetBackgroundLocationForTests,
  startBackgroundLocationUpdates,
  stopBackgroundLocationUpdates,
} from './backgroundLocation';

jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));

jest.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  LocationActivityType: { Fitness: 3 },
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getBackgroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
}));

jest.mock('@data/storage', () => ({
  newId: () => 'id_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  writeTrackGpx: jest.fn(() => 'file://tracks/test.gpx'),
}));

jest.mock('@data/recorderCheckpoint', () => {
  let stored: unknown = null;
  let bgStored: unknown[] = [];
  return {
    writeCheckpoint: jest.fn((cp: unknown) => {
      stored = cp;
    }),
    maybeWriteCheckpoint: jest.fn((cp: unknown) => {
      stored = cp;
    }),
    readCheckpoint: jest.fn(async () => stored),
    clearCheckpoint: jest.fn(() => {
      stored = null;
      bgStored = [];
    }),
    appendBackgroundPoints: jest.fn(async (points: unknown[]) => {
      bgStored.push(...points);
    }),
    readBackgroundPoints: jest.fn(async () => bgStored.slice()),
    clearBackgroundPoints: jest.fn(() => {
      bgStored = [];
    }),
  };
});

// The task handler is registered once, at module import — capture it before
// jest's clearMocks wipes the call record ahead of the first test.
type TaskBody = { data: unknown; error: unknown };
const taskHandler = (TaskManager.defineTask as jest.Mock).mock.calls[0]?.[1] as (
  body: TaskBody,
) => Promise<void>;

const bgFix = (time: number, over: Partial<{ latitude: number; accuracy: number }> = {}) => ({
  coords: {
    latitude: over.latitude ?? 46.8,
    longitude: -71.2,
    altitude: null,
    accuracy: over.accuracy ?? 8,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: time,
});

const deliver = (times: number[]) =>
  taskHandler({ data: { locations: times.map((t) => bgFix(t)) }, error: null });

beforeEach(() => {
  resetBackgroundLocationForTests();
  useRecorderStore.getState().discard();
  (Location.startLocationUpdatesAsync as jest.Mock).mockResolvedValue(undefined);
  (Location.hasStartedLocationUpdatesAsync as jest.Mock).mockResolvedValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('registers the background task at module scope (headless relaunch contract)', () => {
  expect(typeof taskHandler).toBe('function');
});

describe('feeder handoff — isBackgroundFeedConfirmed', () => {
  it('a resolved start alone does NOT confirm the feed (v1.0.2 no-points regression)', async () => {
    // startLocationUpdatesAsync resolving proves the OS accepted the request,
    // not that the task will ever fire (Samsung FGS deferral / battery
    // management). The foreground watch must keep feeding until a delivery.
    await expect(startBackgroundLocationUpdates(5)).resolves.toBe(true);
    expect(isBackgroundFeedConfirmed()).toBe(false);
  });

  it('an actual delivery feeds the recorder AND confirms the feed', async () => {
    useRecorderStore.getState().start('Hike');
    await startBackgroundLocationUpdates(5);
    await deliver([1_000_000, 1_002_000]);
    expect(useRecorderStore.getState().points.map((p) => p.time)).toEqual([1_000_000, 1_002_000]);
    expect(isBackgroundFeedConfirmed()).toBe(true);
  });

  it('confirmation decays once deliveries stop — the foreground watch feeds again', async () => {
    useRecorderStore.getState().start('Hike');
    await startBackgroundLocationUpdates(5);
    await deliver([1_000_000]);
    expect(isBackgroundFeedConfirmed()).toBe(true);

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + BACKGROUND_FEED_FRESH_MS + 1);
    expect(isBackgroundFeedConfirmed()).toBe(false);
  });

  it('a failed start leaves the feed unconfirmed', async () => {
    (Location.startLocationUpdatesAsync as jest.Mock).mockRejectedValue(
      new Error('Foreground service start not allowed'),
    );
    await expect(startBackgroundLocationUpdates(5)).resolves.toBe(false);
    expect(isBackgroundFeedConfirmed()).toBe(false);
  });

  it('stop clears confirmation immediately', async () => {
    useRecorderStore.getState().start('Hike');
    await startBackgroundLocationUpdates(5);
    await deliver([1_000_000]);
    expect(isBackgroundFeedConfirmed()).toBe(true);

    await stopBackgroundLocationUpdates();
    expect(isBackgroundFeedConfirmed()).toBe(false);
  });

  it('a fresh start invalidates the previous session’s deliveries', async () => {
    useRecorderStore.getState().start('Hike');
    await startBackgroundLocationUpdates(5);
    await deliver([1_000_000]);
    expect(isBackgroundFeedConfirmed()).toBe(true);

    // Pause/resume restarts the task: confirmation must again wait for a
    // delivery from the NEW task instance.
    await startBackgroundLocationUpdates(5);
    expect(isBackgroundFeedConfirmed()).toBe(false);
  });

  it('deliveries while paused add no points but keep the task confirmed', async () => {
    useRecorderStore.getState().start('Hike');
    await startBackgroundLocationUpdates(5);
    await deliver([1_000_000]);
    useRecorderStore.getState().pause();

    await deliver([1_002_000]);
    expect(useRecorderStore.getState().points).toHaveLength(1);
    expect(isBackgroundFeedConfirmed()).toBe(true);
  });
});
