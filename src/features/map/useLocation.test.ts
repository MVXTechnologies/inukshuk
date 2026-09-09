import { LAST_POSITION_WRITE_INTERVAL_MS } from '@core/geo/lastKnownPosition';
import * as storage from '@data/storage';
import { isBackgroundFeedConfirmed } from '@lib/backgroundLocation';
import { reportError } from '@lib/errorReporting';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, renderHook } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState, type AppStateStatus } from 'react-native';
import { useLocationTracking } from './useLocation';

jest.mock('@data/storage', () => ({
  newId: () => 'id',
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
}));
jest.mock('@data/recorderCheckpoint', () => ({
  clearCheckpoint: jest.fn(),
  maybeWriteCheckpoint: jest.fn(),
}));
jest.mock('@lib/backgroundLocation', () => ({
  isBackgroundFeedConfirmed: jest.fn(() => false),
  toTrackPoint: (loc: Location.LocationObject) => ({
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    accuracy: loc.coords.accuracy,
    time: loc.timestamp,
  }),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6, Balanced: 3 },
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  watchPositionAsync: jest.fn(),
}));

let deliver: Location.LocationCallback;
let changeAppState: ((state: AppStateStatus) => void) | undefined;

function fix(latitude = 46.8): Location.LocationObject {
  return {
    timestamp: Date.now(),
    coords: {
      latitude,
      longitude: -71.2,
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
  jest.mocked(storage.writeJson).mockReset();
  jest.mocked(isBackgroundFeedConfirmed).mockReturnValue(false);
  useSettingsStore.setState({ hydrated: true, lastKnownPosition: null });
  useRecorderStore.getState().start('Foreground hike');
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'change') changeAppState = listener;
    return { remove: jest.fn() };
  });
  jest.mocked(Location.watchPositionAsync).mockImplementation(async (_options, callback) => {
    deliver = callback;
    return { remove: jest.fn() };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('camera persistence cannot interrupt recording (audit A22)', () => {
  it('delivers all moving fixes and backs off repeated failed settings writes', async () => {
    jest.mocked(storage.writeJson).mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    const { result } = await renderHook(useLocationTracking);

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
        expect(() => deliver(fix(46.8 + i * 0.00001))).not.toThrow();
      });
    }

    expect(useRecorderStore.getState().points).toHaveLength(3);
    expect(result.current.location?.latitude).toBeCloseTo(46.80002);
    expect(result.current.unavailableReason).toBeNull();
    expect(storage.writeJson).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('retries a failed write even when the next position is unchanged', async () => {
    jest.mocked(storage.writeJson).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    await renderHook(useLocationTracking);
    await act(async () => {
      expect(() => deliver(fix())).not.toThrow();
    });
    await act(async () => {
      jest.advanceTimersByTime(LAST_POSITION_WRITE_INTERVAL_MS);
      deliver(fix());
    });
    expect(storage.writeJson).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().lastKnownPosition).toEqual({
      latitude: 46.8,
      longitude: -71.2,
    });
    expect(useRecorderStore.getState().points).toHaveLength(2);
  });

  it('contains and backs off failed flushes across inactive/background transitions', async () => {
    await renderHook(useLocationTracking);
    await act(async () => {
      deliver(fix());
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
      deliver(fix(46.80001)); // freshest position has not been persisted yet
    });
    jest
      .mocked(storage.writeJson)
      .mockClear()
      .mockImplementation(() => {
        throw new Error('ENOSPC');
      });
    await act(async () => {
      expect(() => changeAppState?.('inactive')).not.toThrow();
      expect(() => changeAppState?.('background')).not.toThrow();
    });
    expect(storage.writeJson).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(useRecorderStore.getState().points).toHaveLength(2);
  });

  it('waits for hydrated settings without delaying the recorder or the first eligible write', async () => {
    useSettingsStore.setState({ hydrated: false });
    await renderHook(useLocationTracking);
    await act(async () => {
      deliver(fix());
    });
    expect(storage.writeJson).not.toHaveBeenCalled();
    expect(useRecorderStore.getState().points).toHaveLength(1);
    useSettingsStore.setState({ hydrated: true });
    await act(async () => {
      jest.advanceTimersByTime(1000);
      deliver(fix(46.80001));
    });
    expect(storage.writeJson).toHaveBeenCalledTimes(1);
  });

  it('still leaves the recorder feed to a confirmed background task', async () => {
    jest.mocked(isBackgroundFeedConfirmed).mockReturnValue(true);
    jest.mocked(storage.writeJson).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    const { result } = await renderHook(useLocationTracking);
    await act(async () => {
      expect(() => deliver(fix())).not.toThrow();
    });
    expect(useRecorderStore.getState().points).toHaveLength(0);
    expect(result.current.location?.latitude).toBe(46.8);
  });
});
