/**
 * The map's tap-a-trail sheet: the drawing panel's elevation strip (not the
 * old axis-and-pace chart), the trail view's stat tiles, scrubbing that moves
 * the map marker, and "Edit route" only on a route drawn on the map.
 */
import type { TrackPoint, TrackSummary } from '@core/models';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { TrailInspectPanel } from './TrailInspectPanel';

const METRICS = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

// ~1.1 km north, climbing 10 m every 111 m.
const N = 11;
const POINTS: TrackPoint[] = Array.from({ length: N }, (_, i) => ({
  latitude: 47 + i * 0.001,
  longitude: -70.9,
  altitude: 200 + i * 10,
  time: 1_700_000_000_000 + i * 60_000,
}));

const RECORDED: TrackSummary = {
  id: 't1',
  name: 'Morning hike',
  startedAt: 1_700_000_000_000,
  fileUri: 'tracks/t1.gpx',
  category: 'hike',
  stats: {
    distanceM: 1112,
    ascentM: 100,
    descentM: 0,
    durationS: 600,
    movingTimeS: 540,
    avgSpeedMps: 2,
    maxSpeedMps: 3,
    pointCount: 11,
  },
};

const DRAWN: TrackSummary = {
  ...RECORDED,
  id: 'r1',
  name: 'Ridge loop',
  category: undefined,
  stats: { ...RECORDED.stats, durationS: 0, movingTimeS: 0, avgSpeedMps: 0 },
  plan: {
    mode: 'freehand',
    vertices: [
      [-70.9, 47],
      [-70.9, 47.01],
    ],
  },
};

/** A responder event at `x` px (PanResponder reads the touch history too). */
const touch = (x: number) => ({
  nativeEvent: { locationX: x, locationY: 10, pageX: x, pageY: 10, touches: [], timestamp: 1 },
  touchHistory: {
    numberActiveTouches: 1,
    indexOfSingleActiveTouch: 0,
    mostRecentTimeStamp: 1,
    touchBank: [
      {
        touchActive: true,
        startPageX: x,
        startPageY: 10,
        startTimeStamp: 1,
        currentPageX: x,
        currentPageY: 10,
        currentTimeStamp: 1,
        previousPageX: x,
        previousPageY: 10,
        previousTimeStamp: 1,
      },
    ],
  },
});

async function mount(track: TrackSummary, points: TrackPoint[] = POINTS) {
  const handlers = {
    onScrub: jest.fn(),
    onClose: jest.fn(),
    onView: jest.fn(),
    onEditRoute: jest.fn(),
  };
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider>
        <TrailInspectPanel track={track} points={points} units="metric" {...handlers} />
      </PaperProvider>
    </SafeAreaProvider>,
  );
  return handlers;
}

describe('TrailInspectPanel', () => {
  it('shows the trail view tiles and the drawing panel strip for a recorded trail', async () => {
    await mount(RECORDED);
    expect(screen.getByText('Morning hike')).toBeOnTheScreen();
    // The C2 Overview's first row: Distance, Climb / descent, Moving time.
    expect(screen.getByLabelText(/^Distance 1\.11 km$/)).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Climb \/ descent ↑ 100 m, ↓ 0 m$/)).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Moving time 9:00/)).toBeOnTheScreen();
    // The shared strip (min / max on paper chips), not the old chart.
    expect(screen.getByTestId('trail-inspect-profile')).toBeOnTheScreen();
    expect(screen.getByText('300 m')).toBeOnTheScreen();
    expect(screen.getByText('200 m')).toBeOnTheScreen();
    expect(screen.queryByText(/Elevation gain/i)).toBeNull();
    expect(screen.queryByLabelText('Edit route')).toBeNull();
  });

  it('scrubbing the strip moves the map marker; releasing clears it', async () => {
    const { onScrub } = await mount(RECORDED);
    const strip = screen.getByTestId('trail-inspect-profile');
    await fireEvent(strip, 'layout', { nativeEvent: { layout: { width: 300, height: 68 } } });
    await fireEvent(strip, 'responderGrant', touch(150));
    const at = onScrub.mock.calls.at(-1)?.[0] as {
      latitude: number;
      longitude: number;
      distanceM: number;
      elevation: number;
    };
    expect(at.longitude).toBe(-70.9);
    expect(at.latitude).toBeCloseTo(47.005, 5);
    expect(at.elevation).toBeCloseTo(250, 3);
    expect(screen.getByTestId('trail-inspect-profile-readout')).toHaveTextContent(
      '556 m · 250 m · +9 %',
    );

    await fireEvent(strip, 'responderRelease', touch(150));
    expect(onScrub).toHaveBeenLastCalledWith(null);
  });

  it('a drawn route says so, shows its highest point, and offers Edit route', async () => {
    const { onEditRoute } = await mount(DRAWN);
    expect(screen.getByText('Planned route')).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Highest point 300 m$/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('Edit route'));
    expect(onEditRoute).toHaveBeenCalledTimes(1);
  });

  it('View and close keep working', async () => {
    const { onView, onClose } = await mount(RECORDED);
    await fireEvent.press(screen.getByLabelText('View trail'));
    await fireEvent.press(screen.getByLabelText('Close trail inspector'));
    expect(onView).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an imported GPX without elevation says so instead of charting', async () => {
    await mount(
      RECORDED,
      POINTS.map(({ altitude: _a, ...p }) => p),
    );
    expect(screen.queryByTestId('trail-inspect-profile')).toBeNull();
    expect(screen.getByText('No elevation data')).toBeOnTheScreen();
  });
});
