import { useRecorderStore } from '@state/recorderStore';
import { act, renderHook } from '@testing-library/react-native';
import {
  LOCATION_LOST_PAUSE_DELAY_MS,
  useAutoPauseOnLocationLoss,
} from './useAutoPauseOnLocationLoss';

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

describe('useAutoPauseOnLocationLoss', () => {
  const showSnack = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    useRecorderStore.getState().discard();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const render = (lost: boolean) =>
    renderHook(
      ({ locationLost }: { locationLost: boolean }) =>
        useAutoPauseOnLocationLoss(locationLost, showSnack),
      { initialProps: { locationLost: lost } },
    );

  it('pauses the recording only after a SUSTAINED loss, and says why', async () => {
    useRecorderStore.getState().start('Hike');
    await render(true);

    // Not yet — a blip must not pause.
    await act(async () => jest.advanceTimersByTime(LOCATION_LOST_PAUSE_DELAY_MS - 1));
    expect(useRecorderStore.getState().status).toBe('recording');
    expect(showSnack).not.toHaveBeenCalled();

    await act(async () => jest.advanceTimersByTime(1));
    expect(useRecorderStore.getState().status).toBe('paused');
    expect(showSnack).toHaveBeenCalledWith(expect.stringContaining('recording paused'));
  });

  it('a transient loss (watch re-subscription / AppState churn) never pauses', async () => {
    // Regression: v1.0.2 paused INSTANTLY on `locationLost`, which flips true
    // transiently while the position watch is torn down and re-established —
    // e.g. the AppState churn caused by the background-permission settings
    // round-trip right after the user starts a recording.
    useRecorderStore.getState().start('Hike');
    const { rerender } = await render(true);

    await act(async () => jest.advanceTimersByTime(LOCATION_LOST_PAUSE_DELAY_MS - 1000));
    await rerender({ locationLost: false }); // location came back — timer must cancel
    await act(async () => jest.advanceTimersByTime(LOCATION_LOST_PAUSE_DELAY_MS * 2));

    expect(useRecorderStore.getState().status).toBe('recording');
    expect(showSnack).not.toHaveBeenCalled();
  });

  it('does nothing while idle or already paused', async () => {
    await render(true);
    await act(async () => jest.advanceTimersByTime(LOCATION_LOST_PAUSE_DELAY_MS * 2));
    expect(useRecorderStore.getState().status).toBe('idle');

    useRecorderStore.getState().start('Hike');
    useRecorderStore.getState().pause();
    await render(true);
    await act(async () => jest.advanceTimersByTime(LOCATION_LOST_PAUSE_DELAY_MS * 2));
    expect(useRecorderStore.getState().status).toBe('paused');
    expect(showSnack).not.toHaveBeenCalled();
  });

  it('re-arms after a manual resume while the loss persists (debounced re-pause)', async () => {
    useRecorderStore.getState().start('Hike');
    await render(true);
    await act(async () => jest.advanceTimersByTime(LOCATION_LOST_PAUSE_DELAY_MS));
    expect(useRecorderStore.getState().status).toBe('paused');

    // The user resumes while location is still lost: they get the full grace
    // window again (time to recover), not an instant re-pause.
    await act(async () => useRecorderStore.getState().resume());
    expect(useRecorderStore.getState().status).toBe('recording');
    await act(async () => jest.advanceTimersByTime(LOCATION_LOST_PAUSE_DELAY_MS - 1));
    expect(useRecorderStore.getState().status).toBe('recording');
    await act(async () => jest.advanceTimersByTime(1));
    expect(useRecorderStore.getState().status).toBe('paused');
  });
});
