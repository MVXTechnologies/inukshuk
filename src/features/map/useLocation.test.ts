import { LAST_POSITION_WRITE_INTERVAL_MS } from '@core/geo/lastKnownPosition';
import {
  FIX_STALE_MS,
  SIGNAL_PROBE_TIMEOUT_MS,
  WATCHDOG_TICK_MS,
} from '@core/recording/locationWatchdog';
import * as storage from '@data/storage';
import { isBackgroundFeedConfirmed } from '@lib/backgroundLocation';
import { reportError } from '@lib/errorReporting';
import { useGnssStore } from '@state/gnssStore';
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
  Accuracy: { BestForNavigation: 6, High: 4, Balanced: 3, Low: 2 },
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  watchPositionAsync: jest.fn(),
  getProviderStatusAsync: jest.fn(async () => ({ locationServicesEnabled: true })),
  getCurrentPositionAsync: jest.fn(),
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
  jest
    .mocked(Location.getProviderStatusAsync)
    .mockResolvedValue({ locationServicesEnabled: true } as Location.LocationProviderStatus);
  // A probe that never answers: no fix to be had.
  jest.mocked(Location.getCurrentPositionAsync).mockImplementation(() => new Promise(() => {}));
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

describe('location loss while the watch stays subscribed (#324)', () => {
  const settingsRefusal = () =>
    new Error('Location request failed due to unsatisfied device settings');
  const servicesEnabled = (on: boolean) =>
    jest
      .mocked(Location.getProviderStatusAsync)
      .mockResolvedValue({ locationServicesEnabled: on } as Location.LocationProviderStatus);
  /** Let the silent watch go stale and the watchdog run its probes. */
  const silence = async (ms: number) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  };

  it('reports location off when a live watch goes silent with location switched off', async () => {
    const { result } = await renderHook(useLocationTracking);
    await act(async () => deliver(fix()));
    servicesEnabled(false);
    await silence(FIX_STALE_MS + WATCHDOG_TICK_MS);
    expect(result.current.unavailableKind).toBe('off');
    expect(result.current.unavailableReason).toMatch(/turned off/);
    // The silence is not judged by a fix probe: location off is the answer.
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('reports no signal while recording when location is on but no fix can be had', async () => {
    const { result } = await renderHook(useLocationTracking);
    await act(async () => deliver(fix()));
    await silence(FIX_STALE_MS + WATCHDOG_TICK_MS);
    expect(result.current.unavailableKind).toBeNull(); // still probing
    await silence(SIGNAL_PROBE_TIMEOUT_MS);
    expect(result.current.unavailableKind).toBe('no-signal');
    // The next fix ends the dropout.
    await act(async () => deliver(fix(46.81)));
    expect(result.current.unavailableKind).toBeNull();
  });

  it('leaves a stationary recorder alone: the probe gets a fresh fix', async () => {
    jest
      .mocked(Location.getCurrentPositionAsync)
      .mockImplementation(async () => ({ ...fix(), timestamp: Date.now() }));
    const { result } = await renderHook(useLocationTracking);
    await act(async () => deliver(fix()));
    await silence(FIX_STALE_MS * 3);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalled();
    expect(result.current.unavailableKind).toBeNull();
    // The probe's fix only proves the signal; it is not recorded.
    expect(useRecorderStore.getState().points).toHaveLength(1);
  });

  it('never probes for a fix when not recording (a silent idle map is a still user)', async () => {
    useRecorderStore.getState().discard();
    const { result } = await renderHook(useLocationTracking);
    await act(async () => deliver(fix()));
    await silence(FIX_STALE_MS * 3);
    expect(Location.getProviderStatusAsync).toHaveBeenCalled();
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
    expect(result.current.unavailableKind).toBeNull();
  });

  it('does not probe while the app is in the background', async () => {
    await renderHook(useLocationTracking);
    await act(async () => deliver(fix()));
    await act(async () => changeAppState?.('background'));
    servicesEnabled(false);
    await silence(FIX_STALE_MS * 3);
    expect(Location.getProviderStatusAsync).not.toHaveBeenCalled();
  });

  it('re-establishes the watch once location is switched back on', async () => {
    const { result } = await renderHook(useLocationTracking);
    await act(async () => deliver(fix()));
    servicesEnabled(false);
    await silence(FIX_STALE_MS + WATCHDOG_TICK_MS);
    expect(result.current.unavailableKind).toBe('off');
    const watches = jest.mocked(Location.watchPositionAsync).mock.calls.length;
    servicesEnabled(true);
    await silence(WATCHDOG_TICK_MS);
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(watches + 1);
    expect(result.current.unavailableKind).toBeNull();
  });

  it('Play-services dialog churn: a superseded refusal still reports location off', async () => {
    // Run 1 raises the "turn on device location" dialog and waits on it.
    let refuse!: (err: Error) => void;
    jest.mocked(Location.watchPositionAsync).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    servicesEnabled(false);
    const { result } = await renderHook(useLocationTracking);
    expect(jest.mocked(Location.watchPositionAsync).mock.calls[0]?.[0]).toMatchObject({
      mayShowUserSettingsDialog: true,
    });
    // The dialog churns AppState: `active` re-runs the watch effect…
    await act(async () => changeAppState?.('background'));
    await act(async () => changeAppState?.('active'));
    // …whose watch must not raise the dialog again; it subscribes silently.
    expect(jest.mocked(Location.watchPositionAsync).mock.calls[1]?.[0]).toMatchObject({
      mayShowUserSettingsDialog: false,
    });
    expect(result.current.unavailableKind).toBeNull();
    // The user declines: run 1's refusal lands after it was superseded.
    await act(async () => refuse(settingsRefusal()));
    expect(result.current.unavailableKind).toBe('off');
  });

  it('a refused dialog falls back without raising it again, and says location is off', async () => {
    jest.mocked(Location.watchPositionAsync).mockRejectedValueOnce(settingsRefusal());
    servicesEnabled(false);
    const { result } = await renderHook(useLocationTracking);
    await act(async () => {});
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2);
    expect(jest.mocked(Location.watchPositionAsync).mock.calls[1]?.[0]).toMatchObject({
      accuracy: Location.Accuracy.Balanced,
      mayShowUserSettingsDialog: false,
    });
    expect(result.current.unavailableKind).toBe('off');
  });

  it('a refusal on a device that cannot do high accuracy, location on, is no loss', async () => {
    jest.mocked(Location.watchPositionAsync).mockRejectedValueOnce(settingsRefusal());
    const { result } = await renderHook(useLocationTracking);
    await act(async () => {});
    expect(result.current.unavailableKind).toBeNull();
  });
});

describe('an external GNSS receiver as the position source (#588)', () => {
  const live = {
    state: 'fixed' as const,
    freshness: 'live' as const,
    correction: 'ok' as const,
    reportedState: 'fixed' as const,
    correctionAgeS: 1,
    lastFixAtMs: 1_000_000,
    sinceMs: 1_000_000,
  };
  const map = {
    lat: 46.80123,
    lon: -71.21234,
    result: {
      ok: false as const,
      refusal: { code: 'bad-input' as const, message: '' },
      plan: null,
    },
  };

  afterEach(() => useGnssStore.getState().resetLive());

  it('location is the receiver’s; the phone watch idles at low accuracy and feeds nothing', async () => {
    useGnssStore.setState({
      use: 'external',
      phone: 'standby',
      status: live,
      map,
      link: 'connected',
    });
    const { result } = await renderHook(useLocationTracking);
    expect(jest.mocked(Location.watchPositionAsync).mock.calls[0]?.[0]).toMatchObject({
      accuracy: Location.Accuracy.Low,
    });
    await act(async () => {
      deliver(fix(46.9));
    });
    expect(useRecorderStore.getState().points).toHaveLength(0);
    expect(useGnssStore.getState().phoneAccuracyM).toBe(8);
    expect(result.current.location).toEqual({ latitude: 46.80123, longitude: -71.21234 });
    expect(result.current.unavailableKind).toBeNull();
    // The receiver's later fixes reach `location` at most once a second.
    await act(async () => {
      useGnssStore.setState({ map: { ...map, lat: 46.802 } });
    });
    await act(async () => {
      useGnssStore.setState({ map: { ...map, lat: 46.803 } });
    });
    expect(result.current.location?.latitude).toBe(46.80123);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.location?.latitude).toBe(46.803);
  });

  it('a silent standby watch is never probed while the receiver is the source', async () => {
    useGnssStore.setState({ use: 'external', phone: 'standby', status: live, map });
    await renderHook(useLocationTracking);
    await act(async () => jest.advanceTimersByTime(FIX_STALE_MS + WATCHDOG_TICK_MS * 3));
    expect(Location.getProviderStatusAsync).not.toHaveBeenCalled();
  });

  it('"phone GPS off" while the receiver is good: no watch at all', async () => {
    useGnssStore.setState({ use: 'external', phone: 'off', status: live, map });
    await renderHook(useLocationTracking);
    expect(Location.watchPositionAsync).not.toHaveBeenCalled();
  });

  it('receiver lost with no fallback allowed: "no signal", which auto-pauses a recording', async () => {
    useGnssStore.setState({
      use: 'external',
      phone: 'standby',
      status: { ...live, state: 'no-fix', freshness: 'lost' },
      map,
    });
    const { result } = await renderHook(useLocationTracking);
    expect(result.current.unavailableKind).toBe('no-signal');
  });

  it('back on the phone: full accuracy, and its fixes are recorded again', async () => {
    useGnssStore.setState({ use: 'phone', phone: 'active' });
    const { result } = await renderHook(useLocationTracking);
    expect(jest.mocked(Location.watchPositionAsync).mock.calls[0]?.[0]).toMatchObject({
      accuracy: Location.Accuracy.BestForNavigation,
    });
    await act(async () => {
      deliver(fix(46.9));
    });
    expect(useRecorderStore.getState().points).toHaveLength(1);
    expect(result.current.location).toEqual({ latitude: 46.9, longitude: -71.2 });
  });
});
