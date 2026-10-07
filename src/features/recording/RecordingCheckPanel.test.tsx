/** The Recording check overlay and its record-start gate. */
import type { ReadinessSnapshot } from '@core/recording/recordingReadiness';
import { suppressBackgroundRationaleThisSession } from '@lib/backgroundLocation';
import { applyReadinessFix, readReadinessSnapshot } from '@lib/recordingReadiness';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RecordingCheckPanel } from './RecordingCheckPanel';
import { useRecordingCheck } from './useRecordingCheck';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));
jest.mock('@lib/recordingReadiness', () => ({
  readReadinessSnapshot: jest.fn(),
  applyReadinessFix: jest.fn(async () => undefined),
}));
jest.mock('@lib/backgroundLocation', () => ({
  suppressBackgroundRationaleThisSession: jest.fn(),
}));

const snapshot = (over: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => ({
  platform: 'android',
  osVersion: 34,
  manufacturer: 'samsung',
  location: 'granted',
  locationCanAskAgain: true,
  precise: true,
  background: 'denied',
  backgroundCanAskAgain: true,
  notifications: 'granted',
  notificationsCanAskAgain: true,
  batteryReviewed: false,
  ...over,
});

beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});

beforeEach(() => {
  jest.mocked(readReadinessSnapshot).mockResolvedValue(snapshot());
  jest.mocked(applyReadinessFix).mockClear();
});

afterEach(() => {
  useSettingsStore.getState().reset();
});

const wrap = (ui: React.ReactElement) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    }}
  >
    <PaperProvider>{ui}</PaperProvider>
  </SafeAreaProvider>
);

describe('RecordingCheckPanel', () => {
  it('renders nothing while hidden', async () => {
    const r = await render(
      wrap(<RecordingCheckPanel visible={false} mode="settings" onClose={jest.fn()} />),
    );
    expect(r.queryByTestId('recording-check')).toBeNull();
  });

  it('lists the rows, with Samsung battery guidance and a fix per open row', async () => {
    const r = await render(
      wrap(<RecordingCheckPanel visible mode="settings" onClose={jest.fn()} />),
    );
    expect(await r.findByText('Precise location on')).toBeTruthy();
    expect(r.getByText('Allow location all the time')).toBeTruthy();
    expect(r.getByText(/Never sleeping apps/)).toBeTruthy();
    expect(r.queryByText(/All set/)).toBeNull();

    await act(async () => {
      fireEvent.press(r.getByLabelText('Open: Let GPS run with the screen off'));
    });
    expect(applyReadinessFix).toHaveBeenCalledWith('open-battery-settings');
    expect(useSettingsStore.getState().recordingBatteryReviewed).toBe(true);
  });

  it('shows the incident and says when everything is ready', async () => {
    jest
      .mocked(readReadinessSnapshot)
      .mockResolvedValue(snapshot({ background: 'granted', batteryReviewed: true }));
    const r = await render(
      wrap(
        <RecordingCheckPanel
          visible
          mode="review"
          incident="GPS updates stopped for 12 min while the screen was off."
          onClose={jest.fn()}
        />,
      ),
    );
    expect(r.getByTestId('recording-check-incident')).toBeTruthy();
    expect(await r.findByText(/All set/)).toBeTruthy();
  });

  it('an approximate-location problem offers the precise upgrade', async () => {
    jest.mocked(readReadinessSnapshot).mockResolvedValue(snapshot({ precise: false }));
    const r = await render(
      wrap(<RecordingCheckPanel visible mode="settings" onClose={jest.fn()} />),
    );
    await act(async () => {
      fireEvent.press(await r.findByLabelText('Use precise: Only approximate location allowed'));
    });
    expect(applyReadinessFix).toHaveBeenCalledWith('request-precise');
  });

  it('preflight: Start proceeds, Cancel closes', async () => {
    const onStart = jest.fn();
    const onClose = jest.fn();
    const r = await render(
      wrap(<RecordingCheckPanel visible mode="preflight" onStart={onStart} onClose={onClose} />),
    );
    expect(r.getByText('Before you record')).toBeTruthy();
    await fireEvent.press(r.getByLabelText('Continue to recording'));
    expect(onStart).toHaveBeenCalled();
    await fireEvent.press(r.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('useRecordingCheck', () => {
  it('first recording ever: the check shows before starting, synchronously', async () => {
    const view = await renderHook(() => useRecordingCheck());
    const start = jest.fn();
    await act(async () => view.result.current.requestStart(start));
    expect(view.result.current.panel.visible).toBe(true);
    expect(view.result.current.panel.mode).toBe('preflight');
    expect(start).not.toHaveBeenCalled();

    await act(async () => view.result.current.panel.onStart());
    expect(start).toHaveBeenCalledTimes(1);
    expect(suppressBackgroundRationaleThisSession).toHaveBeenCalled();
    expect(useSettingsStore.getState().recordingCheckShown).toBe(true);
    expect(view.result.current.panel.visible).toBe(false);
  });

  it('afterwards: starts directly when nothing is broken', async () => {
    useSettingsStore.getState().set('recordingCheckShown', true);
    const view = await renderHook(() => useRecordingCheck());
    const start = jest.fn();
    await act(async () => view.result.current.requestStart(start));
    expect(start).toHaveBeenCalledTimes(1);
    expect(view.result.current.panel.visible).toBe(false);
  });

  it('afterwards: a problem (approximate location) brings the check back', async () => {
    useSettingsStore.getState().set('recordingCheckShown', true);
    jest.mocked(readReadinessSnapshot).mockResolvedValue(snapshot({ precise: false }));
    const view = await renderHook(() => useRecordingCheck());
    const start = jest.fn();
    await act(async () => view.result.current.requestStart(start));
    expect(start).not.toHaveBeenCalled();
    expect(view.result.current.panel.mode).toBe('preflight');
  });

  it('cancelling the first check still marks it shown; review mode never starts', async () => {
    const view = await renderHook(() => useRecordingCheck());
    const start = jest.fn();
    await act(async () => view.result.current.requestStart(start));
    await act(async () => view.result.current.panel.onClose());
    expect(useSettingsStore.getState().recordingCheckShown).toBe(true);

    await act(async () => view.result.current.openReview('GPS stopped'));
    expect(view.result.current.panel).toMatchObject({
      visible: true,
      mode: 'review',
      incident: 'GPS stopped',
    });
    await act(async () => view.result.current.panel.onStart());
    expect(start).not.toHaveBeenCalled();
  });
});
