import type { TrackStats } from '@core/models';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useSettingsStore } from '@state/settingsStore';
import { useRecorderStore } from '@state/recorderStore';
import { IMPERIAL, METRIC } from '@core/format';
import { EXPANDED_FIELDS } from '@core/recording/panel';
import { MINI_ON_STRIP_GAP, RecordingPanel } from './RecordingPanel';
import { resetStripRuntime, setStripRuntime, useStripRuntime } from '../infoStrip/stripRuntime';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const stats: TrackStats = {
  distanceM: 3420,
  ascentM: 268,
  descentM: 12,
  durationS: 3734,
  movingTimeS: 3520,
  avgSpeedMps: 1.1,
  maxSpeedMps: 2,
  pointCount: 10,
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function renderPanel(overrides: Partial<Parameters<typeof RecordingPanel>[0]> = {}) {
  const props = {
    status: 'recording' as const,
    stats,
    elapsedS: 3734,
    liveSpeedMps: 1.2,
    gpsQuality: 'good' as const,
    onPause: jest.fn(),
    onResume: jest.fn(),
    onStop: jest.fn(),
    onMark: jest.fn(),
    gloveLocked: false,
    onGloveLockChange: jest.fn(),
    ...overrides,
  };
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider>
        <RecordingPanel {...props} />
      </PaperProvider>
    </SafeAreaProvider>,
  );
  return props;
}

describe('RecordingPanel', () => {
  // The stop ring is JS-driven feedback; keep its frames out of the renderer.
  beforeEach(() => {
    jest.spyOn(Animated, 'timing').mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
    } as unknown as Animated.CompositeAnimation);
  });
  afterEach(() => jest.restoreAllMocks());

  it('opens as the strip with the Maestro labels intact', async () => {
    await renderPanel();
    expect(screen.getByLabelText('Pause')).toBeOnTheScreen();
    expect(screen.getByLabelText('Add waypoint')).toBeOnTheScreen();
    expect(screen.getByLabelText('Stop recording')).toBeOnTheScreen();
    expect(screen.getByText('REC')).toBeOnTheScreen();
    expect(screen.getByText('TIME')).toBeOnTheScreen();
    expect(screen.getByText('DISTANCE')).toBeOnTheScreen();
    expect(screen.getByText('GAIN')).toBeOnTheScreen();
  });

  it('has no Photo button unless the screen offers one', async () => {
    await renderPanel();
    expect(screen.queryByTestId('recording-photo-button')).toBeNull();
  });

  it('shows the Photo button between Mark and Stop, with its count (#587)', async () => {
    const onPhoto = jest.fn();
    await renderPanel({ onPhoto, photoCount: 7 });
    const button = screen.getByLabelText('Take a photo, 7 photos so far');
    expect(screen.getByText('Photo')).toBeOnTheScreen();
    expect(screen.getByText('7', { includeHiddenElements: true })).toBeOnTheScreen();
    await fireEvent.press(button);
    expect(onPhoto).toHaveBeenCalledTimes(1);
  });

  it('takes photos while paused, but not while one is being copied', async () => {
    const onPhoto = jest.fn();
    await renderPanel({ status: 'paused', onPhoto });
    await fireEvent.press(screen.getByLabelText('Take a photo'));
    expect(onPhoto).toHaveBeenCalledTimes(1);
    await screen.rerender(
      <SafeAreaProvider initialMetrics={METRICS}>
        <PaperProvider>
          <RecordingPanel
            status="paused"
            stats={stats}
            elapsedS={1}
            liveSpeedMps={0}
            gpsQuality="good"
            onPause={jest.fn()}
            onResume={jest.fn()}
            onStop={jest.fn()}
            onMark={jest.fn()}
            onPhoto={onPhoto}
            photoBusy
            gloveLocked={false}
            onGloveLockChange={jest.fn()}
          />
        </PaperProvider>
      </SafeAreaProvider>,
    );
    await fireEvent.press(screen.getByLabelText('Take a photo'));
    expect(onPhoto).toHaveBeenCalledTimes(1);
  });

  it('minimizes to the mini overlay and comes back', async () => {
    await renderPanel();
    await fireEvent.press(screen.getByLabelText('Minimize to a small overlay'));
    expect(screen.queryByLabelText('Stop recording')).toBeNull();
    await fireEvent.press(screen.getByLabelText(/^Recording, .*Show instruments$/));
    expect(screen.getByLabelText('Stop recording')).toBeOnTheScreen();
  });

  it("elevation so far: both ends in the user's units (#702)", async () => {
    const at = (altitude: number, time: number) => ({
      latitude: 46.8,
      longitude: -71.2,
      altitude,
      time,
    });
    const before = useRecorderStore.getState().points;
    useRecorderStore.setState({ points: [at(100, 1), at(150, 2)] });
    useSettingsStore.setState({ units: IMPERIAL });
    try {
      await renderPanel();
      await fireEvent.press(screen.getByLabelText('Show more fields'));
      // 100 m and 150 m: feet at both ends, never a bare metre figure on the left.
      expect(screen.getByText('328 ft → 492 ft')).toBeOnTheScreen();
    } finally {
      useRecorderStore.setState({ points: before });
      useSettingsStore.setState({ units: METRIC });
    }
  });

  it('expands to the second detent with more fields', async () => {
    await renderPanel();
    await fireEvent.press(screen.getByLabelText('Show more fields'));
    expect(screen.getByText('ELEVATION SO FAR')).toBeOnTheScreen();
    expect(screen.getByText('MOVING')).toBeOnTheScreen();
    expect(screen.getByText('TO SUNSET')).toBeOnTheScreen();
    await fireEvent.press(screen.getAllByLabelText('Show fewer fields')[0]!);
    expect(screen.queryByText('ELEVATION SO FAR')).toBeNull();
  });

  it('cycles a hero field on tap', async () => {
    await renderPanel();
    await fireEvent.press(screen.getByLabelText(/^Gain .*Tap to change field$/));
    expect(screen.getByText('SPEED')).toBeOnTheScreen();
    expect(screen.queryByText('GAIN')).toBeNull();
  });

  it('shows the paused state with Resume', async () => {
    const props = await renderPanel({ status: 'paused' });
    expect(screen.getByText('PAUSED')).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('Resume'));
    expect(props.onResume).toHaveBeenCalledTimes(1);
  });

  it('names a weak GPS signal in its chip', async () => {
    await renderPanel({ gpsQuality: 'weak' });
    expect(screen.getByText(/^Weak GPS/)).toBeOnTheScreen();
  });

  it('turns on glove lock from the options', async () => {
    const props = await renderPanel();
    await fireEvent.press(screen.getByLabelText('Recording options'));
    await fireEvent.press(screen.getByLabelText('Glove lock'));
    expect(props.onGloveLockChange).toHaveBeenCalledWith(true);
  });

  it('replaces the controls with hold-to-unlock while locked', async () => {
    await renderPanel({ gloveLocked: true });
    expect(screen.queryByLabelText('Pause')).toBeNull();
    expect(screen.getByLabelText('Unlock controls')).toBeOnTheScreen();
  });

  it('offers the display modes in its options (opt-in)', async () => {
    useSettingsStore.setState({ displayCondition: 'normal' });
    await renderPanel();
    await fireEvent.press(screen.getByLabelText('Recording options'));
    expect(screen.getByText('DISPLAY · OPT-IN')).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('Display Night'));
    expect(useSettingsStore.getState().displayCondition).toBe('night');
    expect(screen.getByLabelText('All display options')).toBeOnTheScreen();
  });

  describe('with the info strip (#673)', () => {
    beforeEach(() => resetStripRuntime());

    it('tells the strip which metrics it owns: the hero row, the grid too when expanded, none when minimised', async () => {
      await renderPanel();
      expect(useStripRuntime.getState().heroFields).toEqual(['time', 'distance', 'gain']);
      await fireEvent.press(screen.getByLabelText('Show more fields'));
      expect([...useStripRuntime.getState().heroFields].sort()).toEqual(
        [...new Set(['time', 'distance', 'gain', ...EXPANDED_FIELDS])].sort(),
      );
      await fireEvent.press(screen.getAllByLabelText('Show fewer fields')[0]!);
      await fireEvent.press(screen.getByLabelText('Minimize to a small overlay'));
      expect(useStripRuntime.getState().heroFields).toEqual([]);
    });

    it('cycling skips the metrics the strip already shows', async () => {
      // Speed is next after Gain, but the strip shows it: Pace comes instead.
      setStripRuntime({ stripMetrics: new Set(['speed']) });
      await renderPanel();
      await fireEvent.press(screen.getByLabelText(/^Gain .*Tap to change field$/));
      expect(screen.queryByText('SPEED')).toBeNull();
      expect(screen.getByText('PACE')).toBeOnTheScreen();
    });

    it('formats with the shared hero formatter (the strip prints the same text)', async () => {
      await renderPanel();
      expect(screen.getByLabelText(/^Distance 3\.42 km/)).toBeOnTheScreen();
      expect(screen.getByLabelText(/^Gain \+268 m/)).toBeOnTheScreen();
    });

    it('squares its top while the strip sits on it', async () => {
      await renderPanel();
      const sheet = () => screen.getByLabelText('Recording instruments');
      expect(StyleSheet.flatten(sheet().props.style).borderTopLeftRadius).toBe(24);
      await act(async () => setStripRuntime({ onPanel: true }));
      expect(StyleSheet.flatten(sheet().props.style).borderTopLeftRadius).toBe(0);
    });

    it('under the strip it leaves its status bar and shadow to the strip: one surface (QA 06a)', async () => {
      await renderPanel();
      const sheet = () => screen.getByLabelText('Recording instruments');
      expect(
        StyleSheet.flatten(screen.getByTestId('recording-status-bar').props.style),
      ).toMatchObject({ height: 4 });
      await act(async () => setStripRuntime({ onPanel: true }));
      expect(screen.queryByTestId('recording-status-bar')).toBeNull();
      expect(StyleSheet.flatten(sheet().props.style)).toMatchObject({
        elevation: 0,
        shadowOpacity: 0,
      });
    });

    it('tells the strip when it is minimised and when paused', async () => {
      await renderPanel({ status: 'paused' });
      expect(useStripRuntime.getState()).toMatchObject({ panelMini: false, panelPaused: true });
      await fireEvent.press(screen.getByLabelText('Minimize to a small overlay'));
      expect(useStripRuntime.getState().panelMini).toBe(true);
      await screen.unmount();
      expect(useStripRuntime.getState()).toMatchObject({ panelMini: false, panelPaused: false });
    });

    it('minimised on a bottom strip, the pill floats on it and reports its height without it (QA 06b)', async () => {
      setStripRuntime({ dock: 'bottom', stripH: 70 });
      const onHeightChange = jest.fn();
      await renderPanel({ onHeightChange });
      await fireEvent.press(screen.getByLabelText('Minimize to a small overlay'));
      const wrap = screen.getByTestId('recording-mini-wrap');
      expect(StyleSheet.flatten(wrap.props.style).paddingBottom).toBe(70 + MINI_ON_STRIP_GAP);
      await fireEvent(wrap, 'layout', {
        nativeEvent: { layout: { height: 70 + MINI_ON_STRIP_GAP + 52 } },
      });
      expect(onHeightChange).toHaveBeenLastCalledWith(MINI_ON_STRIP_GAP + 52);
    });
  });
});
