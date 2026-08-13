import { GPS_LOST_MS, GPS_WEAK_MS } from '@core/geo/track/gpsQuality';
import type { TrackPoint } from '@core/models';
import { useRecorderStore } from '@state/recorderStore';
import { act, renderHook } from '@testing-library/react-native';
import { useRecordingSession } from './useRecordingSession';

jest.mock('@data/storage', () => ({
  newId: () => 'id_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  writeTrackGpx: jest.fn(() => 'file://tracks/test.gpx'),
}));

jest.mock('@data/recorderCheckpoint', () => ({
  writeCheckpoint: jest.fn(),
  maybeWriteCheckpoint: jest.fn(),
  readCheckpoint: jest.fn(async () => null),
  clearCheckpoint: jest.fn(),
  appendBackgroundPoints: jest.fn(),
  readBackgroundPoints: jest.fn(async () => []),
  clearBackgroundPoints: jest.fn(),
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));

// The OS background-location feed is a separate concern with its own permission
// state machine; this suite is about the elapsed-time / GPS-quality ticker.
jest.mock('./useBackgroundRecording', () => ({
  useBackgroundRecording: () => ({ bgRationaleVisible: false, respondToBgRationale: jest.fn() }),
}));

const showSnack = jest.fn();

/**
 * A fix ~1 m from the last one, timestamped now. Well inside the recorder's
 * gpsFilter gates (accuracy, 40 m/s teleport cap, 250 ms duplicate window) so
 * every call actually reaches the store.
 */
let fixCount = 0;
function fix(overrides: Partial<TrackPoint> = {}): TrackPoint {
  fixCount += 1;
  return {
    latitude: 46.8 + fixCount * 0.00001,
    longitude: -71.2,
    time: Date.now(),
    accuracy: 5,
    ...overrides,
  };
}

describe('useRecordingSession — the elapsed/GPS-quality ticker', () => {
  let setIntervalSpy: jest.SpyInstance;
  let clearIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-13T10:00:00Z'));
    fixCount = 0;
    useRecorderStore.getState().discard();
    setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
  });

  afterEach(() => {
    // Restore BEFORE handing the timers back: uninstalling the fake timers
    // rewrites the global timer properties, and a live spy on top of them ends
    // up deleting `clearInterval` outright for the RTL cleanup that follows.
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    jest.useRealTimers();
  });

  const mount = () => renderHook(() => useRecordingSession({ showSnack }));

  it('advances once per second with NO fixes at all (out of signal, phone in pocket)', async () => {
    const view = await mount();
    await act(async () => {
      useRecorderStore.getState().start('Hike');
    });
    expect(view.result.current.elapsedS).toBe(0);

    await act(async () => jest.advanceTimersByTime(1000));
    expect(view.result.current.elapsedS).toBe(1);

    await act(async () => jest.advanceTimersByTime(3000));
    expect(view.result.current.elapsedS).toBe(4);

    // 4 s of wall time, 4 ticks — no double-firing, no drift.
    await act(async () => jest.advanceTimersByTime(56_000));
    expect(view.result.current.elapsedS).toBe(60);
  });

  it('keeps ticking under 5 fixes/second — the interval is not torn down per fix', async () => {
    const view = await mount();
    await act(async () => {
      useRecorderStore.getState().start('Bike');
    });
    const intervalsAfterStart = setIntervalSpy.mock.calls.length;

    // 3 s at 5 Hz. The 250 ms duplicate gate means fixes land 300 ms apart.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(300);
        useRecorderStore.getState().addPoint(fix());
      });
    }
    expect(useRecorderStore.getState().points.length).toBe(10);
    expect(view.result.current.elapsedS).toBe(3);

    // The regression this guards: with lastFixAt/lastAccuracyM as deps of the
    // ticker effect, every accepted fix cleared and recreated the interval, so
    // above 1 Hz it never survived long enough to fire.
    expect(setIntervalSpy.mock.calls.length).toBe(intervalsAfterStart);
  });

  it('runs a single interval across pause → resume, and excludes the paused time', async () => {
    const view = await mount();
    await act(async () => {
      useRecorderStore.getState().start('Hike');
    });
    await act(async () => jest.advanceTimersByTime(5000));
    expect(view.result.current.elapsedS).toBe(5);

    const before = setIntervalSpy.mock.calls.length;
    await act(async () => {
      useRecorderStore.getState().pause();
    });
    // Paused: the interval is torn down and the display freezes.
    expect(clearIntervalSpy).toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(30_000));
    expect(view.result.current.elapsedS).toBe(5);

    await act(async () => {
      useRecorderStore.getState().resume();
    });
    // Exactly one interval was (re)created for the resumed leg — not one per
    // render, and the 30 s pause is not credited to the trail.
    expect(setIntervalSpy.mock.calls.length).toBe(before + 1);
    expect(view.result.current.elapsedS).toBe(5);

    await act(async () => jest.advanceTimersByTime(2000));
    expect(view.result.current.elapsedS).toBe(7);
  });

  it('clears its interval on unmount — no leak, no setState after teardown', async () => {
    const view = await mount();
    await act(async () => {
      useRecorderStore.getState().start('Hike');
    });
    await act(async () => jest.advanceTimersByTime(1000));

    const timerIds = setIntervalSpy.mock.results.map((r) => r.value);
    clearIntervalSpy.mockClear();
    await act(async () => {
      await view.unmount();
    });
    expect(clearIntervalSpy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(timerIds));

    // Nothing left running: advancing time must not throw an update-after-
    // unmount warning or resurrect the ticker.
    await act(async () => jest.advanceTimersByTime(10_000));
  });

  it('degrades to weak then lost while fixes stop arriving, on the clock alone', async () => {
    const view = await mount();
    await act(async () => {
      useRecorderStore.getState().start('Hike');
      useRecorderStore.getState().addPoint(fix());
    });
    expect(view.result.current.gpsQuality).toBe('good');

    await act(async () => jest.advanceTimersByTime(GPS_WEAK_MS));
    expect(view.result.current.gpsQuality).toBe('weak');

    await act(async () => jest.advanceTimersByTime(GPS_LOST_MS - GPS_WEAK_MS));
    expect(view.result.current.gpsQuality).toBe('lost');
  });

  it('recovers to good the instant a fix lands, without waiting for the next tick', async () => {
    const view = await mount();
    await act(async () => {
      useRecorderStore.getState().start('Hike');
      useRecorderStore.getState().addPoint(fix());
    });
    await act(async () => jest.advanceTimersByTime(GPS_LOST_MS));
    expect(view.result.current.gpsQuality).toBe('lost');

    // No timer advance between the fix and the assertion: a signal-recovered
    // indicator that lags a second is a worse HUD than one that doesn't.
    await act(async () => {
      useRecorderStore.getState().addPoint(fix());
    });
    expect(view.result.current.gpsQuality).toBe('good');
  });
});
