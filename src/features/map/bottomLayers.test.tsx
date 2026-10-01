import type { TrackStats } from '@core/models';
import { render, screen } from '@testing-library/react-native';
import { Animated, StyleSheet, View } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  BOTTOM_LAYER,
  FLOATING_CARD_GAP,
  snackbarWrapperStyle,
  waypointCardDockStyle,
} from './bottomLayers';
import { RecordingPanel } from './components/RecordingPanel';
import { WaypointViewerCard } from './components/WaypointViewerCard';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

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

describe('waypoint card vs recording panel stacking (#505)', () => {
  beforeEach(() => {
    jest.spyOn(Animated, 'timing').mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
    } as unknown as Animated.CompositeAnimation);
  });
  afterEach(() => jest.restoreAllMocks());

  it('the card layer sits above the recording panel layer', () => {
    expect(BOTTOM_LAYER.waypointCard.zIndex).toBeGreaterThan(BOTTOM_LAYER.recordingPanel.zIndex);
  });

  it('snackbars sit above every dock and clear the recording panel', () => {
    expect(BOTTOM_LAYER.snackbar.zIndex).toBeGreaterThan(BOTTOM_LAYER.waypointCard.zIndex);
    expect(snackbarWrapperStyle(true, 240)).toMatchObject({ bottom: 240 });
    expect(snackbarWrapperStyle(false, 240).bottom).toBeUndefined();
  });

  it('docks flush with the bottom edge when not recording', () => {
    expect(waypointCardDockStyle(false, 240)).toMatchObject({ bottom: 0, left: 0, right: 0 });
  });

  it('floats above the recording panel while recording', () => {
    expect(waypointCardDockStyle(true, 240)).toMatchObject({
      bottom: 240 + FLOATING_CARD_GAP,
      zIndex: BOTTOM_LAYER.waypointCard.zIndex,
    });
  });

  it('recording + open waypoint: the card renders in a dock above the panel', async () => {
    // The map screen's bottom edge in miniature: the panel's dock, then the
    // card's dock, both built from the same layer table MapScreen uses.
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <PaperProvider>
          <View style={StyleSheet.absoluteFill}>
            <View
              testID="panel-dock"
              style={{ position: 'absolute', bottom: 0, ...BOTTOM_LAYER.recordingPanel }}
            >
              <RecordingPanel
                status="recording"
                stats={stats}
                elapsedS={3734}
                liveSpeedMps={1.2}
                gpsQuality="good"
                onPause={jest.fn()}
                onResume={jest.fn()}
                onStop={jest.fn()}
                onMark={jest.fn()}
                gloveLocked={false}
                onGloveLockChange={jest.fn()}
              />
            </View>
            <View testID="card-dock" style={waypointCardDockStyle(true, 220)}>
              <WaypointViewerCard
                waypoint={{ label: 'Waypoint 1', latitude: 46.8, longitude: -71.2, note: 'Hi' }}
                floating
                onCopyCoords={jest.fn()}
                onCopyNote={jest.fn()}
                onSharePhoto={jest.fn()}
                onEdit={jest.fn()}
                onDelete={jest.fn()}
                onClose={jest.fn()}
              />
            </View>
          </View>
        </PaperProvider>
      </SafeAreaProvider>,
    );
    const panel = StyleSheet.flatten(screen.getByTestId('panel-dock').props.style);
    const card = StyleSheet.flatten(screen.getByTestId('card-dock').props.style);
    expect(card.zIndex).toBeGreaterThan(panel.zIndex ?? 0);
    expect(card.bottom).toBe(220 + FLOATING_CARD_GAP);
    // Neither dock may carry an elevation: on Android that would outrank zIndex.
    expect(panel.elevation).toBeUndefined();
    expect(card.elevation).toBeUndefined();
    expect(screen.getByLabelText('Delete waypoint')).toBeTruthy();
  });
});
