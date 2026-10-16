import type { TrackStats } from '@core/models';
import { render, screen } from '@testing-library/react-native';
import { Animated, StyleSheet, View } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  BOTTOM_LAYER,
  FLOATING_CARD_GAP,
  liftedSnackbarStyle,
  rowLiftAboveColumnBottom,
  snackbarWrapperStyle,
  TEAM_FAB_GAP,
  teamFabBottom,
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
    // Over the drawing panel too, whose ✕ warns through a snackbar (QA 2.6.1).
    expect(snackbarWrapperStyle(false, 240, 310)).toMatchObject({ bottom: 310 });
    expect(snackbarWrapperStyle(true, 240, 310)).toMatchObject({ bottom: 310 });
  });

  it('lifts the EDIT / UNDO bar above the whole bottom column (chip, scale row, compass)', () => {
    // Column at the edge, 120 dp tall: the bar starts where the column ends.
    expect(liftedSnackbarStyle(0, 120)).toEqual({ ...BOTTOM_LAYER.snackbar, bottom: 120 });
    // Column riding on the 240 dp recording panel.
    expect(liftedSnackbarStyle(240, 120)).toMatchObject({ bottom: 360 });
    // Not measured yet: it at least clears what the column sits on.
    expect(liftedSnackbarStyle(240, null)).toMatchObject({ bottom: 240 });
    expect(liftedSnackbarStyle(0, 120).zIndex).toBe(BOTTOM_LAYER.snackbar.zIndex);
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

/**
 * The bottom column's two orders (owner 2026-10-13, #672). Measured numbers
 * as the column reports them: paddingBottom 10, gap 12, the ⓘ + scale row
 * 40 tall, the compass tape 44 (NAV_COMPASS_H).
 */
describe('what sits above the ⓘ + scale row, in either column order', () => {
  const PAD = 10;
  const GAP = 12;
  const ROW = 40;
  const TAPE = 44;

  it('no tape: the row is the bottom of the column', () => {
    const columnH = ROW + PAD;
    const rowY = 0;
    expect(rowLiftAboveColumnBottom(columnH, rowY)).toBe(ROW + PAD);
  });

  it('tape showing: the tape is under the row, and everything above the row rises by it', () => {
    const columnH = ROW + GAP + TAPE + PAD;
    const rowY = 0;
    expect(rowLiftAboveColumnBottom(columnH, rowY)).toBe(ROW + GAP + TAPE + PAD);
  });

  it('with other blocks above the row (toasts, photo chip), only what is below counts', () => {
    const above = 30 + GAP;
    expect(rowLiftAboveColumnBottom(above + ROW + PAD, above)).toBe(ROW + PAD);
    expect(rowLiftAboveColumnBottom(above + ROW + GAP + TAPE + PAD, above)).toBe(
      ROW + GAP + TAPE + PAD,
    );
  });

  it('never goes negative on a stale layout', () => {
    expect(rowLiftAboveColumnBottom(20, 40)).toBe(0);
  });

  it('the 8 s EDIT / UNDO bar clears the whole column in both orders', () => {
    expect(liftedSnackbarStyle(0, ROW + PAD).bottom).toBe(ROW + PAD);
    expect(liftedSnackbarStyle(0, ROW + GAP + TAPE + PAD).bottom).toBe(ROW + GAP + TAPE + PAD);
  });
});

describe('the team button and the bottom column (2.5.2 QA)', () => {
  it('sits above the whole column, compass tape included, wherever the column sits', () => {
    // At rest: a 56 dp row → the button's bottom edge 8 dp above it, the rail's
    // own gap (#756: the SOS is a button of the rail's column).
    expect(TEAM_FAB_GAP).toBe(8);
    expect(teamFabBottom(0, 56)).toBe(64);
    // Following a trail: the tape under the row makes the column 150 dp tall.
    expect(teamFabBottom(0, 150)).toBe(150 + TEAM_FAB_GAP);
    // On the recording panel.
    expect(teamFabBottom(240, 150)).toBe(240 + 150 + TEAM_FAB_GAP);
    // Before the column's first layout.
    expect(teamFabBottom(0, null)).toBe(64);
  });
});
