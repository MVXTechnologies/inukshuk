import { BACKGROUND_FEED_FRESH_MS } from '@core/geo/track/backgroundFeed';
import * as checkpoint from '@data/recorderCheckpoint';
import { useLibraryStore } from '@state/libraryStore';
import {
  initRecorderRecovery,
  resetRecorderRecoveryForTests,
  useRecorderStore,
} from '@state/recorderStore';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  isBackgroundFeedConfirmed,
  cleanupBackgroundLocationAtLaunch,
  mergeJournaledBackgroundPoints,
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
      return true;
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
    acknowledgeBackgroundPoints: jest.fn((points: unknown[]) => {
      const acknowledged = new Set(points);
      bgStored = bgStored.filter((point) => !acknowledged.has(point));
    }),
  };
});

describe('foreground journal durability', () => {
  const point = (time: number) => ({ latitude: 46.8, longitude: -71.2, time });

  it('retains fixes on checkpoint failure and retries without needing new fixes', async () => {
    useRecorderStore.getState().discard();
    useRecorderStore.getState().start('Current');
    useRecorderStore.getState().addPoint(point(1000));
    await checkpoint.appendBackgroundPoints([point(2000)]);
    jest.mocked(checkpoint.writeCheckpoint).mockReturnValueOnce(false);
    await mergeJournaledBackgroundPoints();
    await expect(checkpoint.readBackgroundPoints()).resolves.toEqual([point(2000)]);
    await mergeJournaledBackgroundPoints();
    await expect(checkpoint.readBackgroundPoints()).resolves.toEqual([]);
    expect((await checkpoint.readCheckpoint())?.points).toEqual([point(1000), point(2000)]);
  });

  it('does not merge an old journal into a newly started session', async () => {
    useRecorderStore.getState().discard();
    useRecorderStore.getState().start('Old');
    let finish!: (points: ReturnType<typeof point>[]) => void;
    jest.mocked(checkpoint.readBackgroundPoints).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const merging = mergeJournaledBackgroundPoints();
    useRecorderStore.getState().start('New');
    const expected = useRecorderStore.getState();
    finish([point(1000)]);
    await merging;
    expect(useRecorderStore.getState()).toBe(expected);
  });
});

describe('background task ownership', () => {
  it.each([true, false])(
    'preserves a batch delivered during matching recovery (checkpoint durable: %s)',
    async (durable) => {
      const saved: checkpoint.RecorderCheckpoint = {
        status: 'recording',
        name: 'Recovered',
        startedAt: 1000,
        pausedMs: 0,
        points: [{ latitude: 46.8, longitude: -71.2, time: 1000 }],
        waypoints: [],
      };
      checkpoint.writeCheckpoint(saved);
      let finish!: (cp: checkpoint.RecorderCheckpoint) => void;
      jest.mocked(checkpoint.readCheckpoint).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = deliver([2000]);
      useLibraryStore.setState({ hydrated: true, tracks: [] });
      await expect(initRecorderRecovery()).resolves.toBe(true);
      if (durable) {
        finish(saved);
        await pending;
      } else {
        await jest.mocked(checkpoint.writeCheckpoint).withImplementation(
          () => false,
          async () => {
            finish(saved);
            await pending;
          },
        );
      }
      expect(useRecorderStore.getState().status).toBe('paused');
      expect(useRecorderStore.getState().points.map((point) => point.time)).toEqual([1000, 2000]);
      if (durable) {
        expect((await checkpoint.readCheckpoint())?.points.map((point) => point.time)).toEqual([
          1000, 2000,
        ]);
      } else {
        expect((await checkpoint.readBackgroundPoints()).map((point) => point.time)).toContain(
          2000,
        );
      }
    },
  );

  it.each(['different recovery', 'new session'])(
    'rejects a pending headless batch belonging to a %s',
    async (mode) => {
      const saved: checkpoint.RecorderCheckpoint = {
        status: 'recording',
        name: 'Old',
        startedAt: 1000,
        pausedMs: 0,
        points: [{ latitude: 46.8, longitude: -71.2, time: 1000 }],
        waypoints: [],
      };
      checkpoint.writeCheckpoint({ ...saved, startedAt: 500 });
      let finish!: (cp: checkpoint.RecorderCheckpoint) => void;
      jest.mocked(checkpoint.readCheckpoint).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = deliver([2000]);
      if (mode === 'new session') {
        // Even a coincident start timestamp must not defeat generation ownership.
        jest.spyOn(Date, 'now').mockReturnValue(saved.startedAt);
        useRecorderStore.getState().start('New');
      } else {
        useLibraryStore.setState({ hydrated: true, tracks: [] });
        await expect(initRecorderRecovery()).resolves.toBe(true);
      }
      const expected = useRecorderStore.getState();
      finish(saved);
      await pending;
      expect(useRecorderStore.getState()).toBe(expected);
      await expect(checkpoint.readBackgroundPoints()).resolves.toEqual([]);
    },
  );

  it.each(['headless', 'launch'])(
    'ignores stale %s checkpoint decisions after recording starts',
    async (mode) => {
      jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);
      let finish!: (cp: null) => void;
      jest.mocked(checkpoint.readCheckpoint).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = mode === 'headless' ? deliver([1000]) : cleanupBackgroundLocationAtLaunch();
      await Promise.resolve();
      useRecorderStore.getState().start('New');
      finish(null);
      await pending;
      expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
    },
  );

  it('does not let a delayed native stop cancel a newer start', async () => {
    let finish!: (started: boolean) => void;
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stopping = stopBackgroundLocationUpdates();
    await Promise.resolve();
    const starting = startBackgroundLocationUpdates(5);
    finish(true);
    await Promise.all([stopping, starting]);
    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
  });

  it('serializes native lifecycle calls so an old stop completes before a new start', async () => {
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);
    let finish!: () => void;
    jest.mocked(Location.stopLocationUpdatesAsync).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stopping = stopBackgroundLocationUpdates();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const starting = startBackgroundLocationUpdates(5);
    await Promise.resolve();
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
    finish();
    await Promise.all([stopping, starting]);
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
  });
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
  resetRecorderRecoveryForTests();
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
