import type { TrackStats } from '@core/models';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Animated } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useSettingsStore } from '@state/settingsStore';
import { RecordingPanel } from './RecordingPanel';

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
});
