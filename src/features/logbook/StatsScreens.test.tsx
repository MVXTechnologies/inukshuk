import { computeTrackStats } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import { setTrailStatsStoreForTests, TrailStatsStore } from '@data/trailStatsStore';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LogbookHeaderActions } from './LogbookHeaderActions';
import { RecordsScreen } from './RecordsScreen';
import { StatsScreen } from './StatsScreen';
import { YearReviewScreen } from './YearReviewScreen';

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: mockBack }) }));
jest.mock('@data/storage', () => ({}));

const NOW = new Date(2026, 8, 23, 15).getTime();

function track(id: string, name: string, daysAgo: number, category: string): TrackSummary {
  return {
    id,
    name,
    fileUri: `${id}.gpx`,
    startedAt: NOW - daysAgo * 86_400_000,
    category,
    stats: {
      ...computeTrackStats([]),
      distanceM: 10_000,
      movingTimeS: 3000,
      ascentM: 120,
      maxAltitudeM: 310,
      pointCount: 1500,
    },
  };
}

/** A steady 1 Hz run heading north at 3.33 m/s, heart rate 150 bpm. */
function runPoints(startMs: number, seconds: number): TrackPoint[] {
  return Array.from({ length: seconds }, (_, k) => ({
    latitude: 46.8 + (k * 3.33) / 111_320,
    longitude: -71.2,
    altitude: 50,
    time: startMs + k * 1000,
    heartRateBpm: 150,
  }));
}

let store: TrailStatsStore;

async function show(ui: React.ReactElement, tracks: TrackSummary[], maxHeartRateBpm = 0) {
  useLibraryStore.setState({ tracks, customCategories: [], hydrated: true });
  useSettingsStore.setState({ units: 'metric', maxHeartRateBpm });
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>{ui}</PaperProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(NOW));
  mockPush.mockReset();
  store = new TrailStatsStore({
    io: { read: async () => null, write: () => {} },
    loadPoints: async () => null,
  });
  setTrailStatsStoreForTests(store);
});
afterEach(() => {
  setTrailStatsStoreForTests(null);
  jest.useRealTimers();
});

describe('Statistics', () => {
  it('shows the period totals, the comparison, the streak and the links', async () => {
    await show(<StatsScreen />, [
      track('a', 'Plains loop', 1, 'run'),
      track('b', 'Ride', 9, 'bike'),
    ]);

    expect(screen.getByLabelText(/^THIS MONTH: 20 km, .* 2 outings/)).toBeTruthy();
    expect(screen.getByLabelText('Current streak 2 weeks, best 2 weeks')).toBeTruthy();
    expect(screen.getByText('Last 12 weeks')).toBeTruthy();
    // Only the activities the user has get a chip.
    expect(screen.getByLabelText('Run')).toBeTruthy();
    expect(screen.getByLabelText('Bike')).toBeTruthy();
    expect(screen.queryByLabelText('Ski')).toBeNull();
    // No heart rate cached yet.
    expect(screen.getByText('No heart-rate data in this period')).toBeTruthy();

    await fireEvent.press(
      screen.getByLabelText('Personal records, Fastest efforts and biggest outings'),
    );
    expect(mockPush).toHaveBeenCalledWith('/logbook/records');
    await fireEvent.press(screen.getByLabelText('Change max heart rate'));
    expect(mockPush).toHaveBeenCalledWith('/settings?open=training');
  });

  it('follows the activity chip and the period, and zones the cached heart rate', async () => {
    const run = track('a', 'Plains loop', 1, 'run');
    store.prime(run, runPoints(run.startedAt, 1500));
    await show(<StatsScreen />, [run, track('b', 'Ride', 9, 'bike')], 200);

    await fireEvent.press(screen.getByLabelText('Run'));
    await fireEvent.press(screen.getByText('Year'));
    expect(screen.getByLabelText(/^THIS YEAR · RUN: 10 km, .* 1 outing/)).toBeTruthy();
    expect(screen.getByText('This year, month by month')).toBeTruthy();
    expect(screen.getByText('Average pace')).toBeTruthy();
    // 150 bpm of a 200 max is Z3 (70–80 %), all of it.
    expect(screen.getByText(/Max HR 200 bpm · set by you/)).toBeTruthy();
    expect(
      screen.getByLabelText(/Heart-rate zones over 1 activity: .*zone 3 100 percent/),
    ).toBeTruthy();
  });
});

describe('Personal records', () => {
  it('lists the fastest stretches and biggest outings, and opens the trail', async () => {
    const run = track('a', 'Plains loop', 1, 'run');
    // 1500 s at 3.33 m/s ≈ 5 km: a 1 km and a 5 km effort, nothing longer.
    store.prime(run, runPoints(run.startedAt, 1510));
    await show(<RecordsScreen />, [run]);

    expect(screen.getByLabelText(/^1 km: 5:00\. Plains loop · .*\. New record$/)).toBeTruthy();
    expect(screen.getByLabelText(/^10 km: no record\. No run long enough yet$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Longest: 10(\.0+)? km\. Plains loop/)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText(/^Longest: /));
    expect(mockPush).toHaveBeenCalledWith('/trail3d/a');

    await fireEvent.press(screen.getByText('Bike'));
    expect(screen.getAllByText('No ride long enough yet')).toHaveLength(3);
  });
});

describe('Year in review', () => {
  it('summarises the year and steps to an earlier one', async () => {
    await show(<YearReviewScreen />, [
      track('a', 'Plains loop', 1, 'run'),
      track('b', 'Last year', 400, 'run'),
    ]);

    expect(screen.getByText('2026')).toBeTruthy();
    expect(screen.getByLabelText('1 outing')).toBeTruthy();
    expect(screen.getByLabelText('2026 calendar: 1 active days')).toBeTruthy();
    expect(screen.getByLabelText(/^Sep: 10(\.0+)? km, best month$/)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Show 2025'));
    expect(screen.getByText('2025')).toBeTruthy();
    expect(screen.getByLabelText(/^Aug: 10(\.0+)? km, best month$/)).toBeTruthy();
  });
});

describe('Logbook header actions', () => {
  it('shows the streak flame and the Statistics pill; both open Statistics', async () => {
    const open = jest.fn();
    await render(
      <PaperProvider>
        <LogbookHeaderActions streakWeeks={4} onOpenStats={open} />
      </PaperProvider>,
    );
    await fireEvent.press(screen.getByLabelText('4-week streak'));
    await fireEvent.press(screen.getByLabelText('Statistics'));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('hides the flame at a streak of 0', async () => {
    await render(
      <PaperProvider>
        <LogbookHeaderActions streakWeeks={0} onOpenStats={() => {}} />
      </PaperProvider>,
    );
    expect(screen.queryByLabelText(/week streak/)).toBeNull();
    expect(screen.getByLabelText('Statistics')).toBeTruthy();
  });
});
