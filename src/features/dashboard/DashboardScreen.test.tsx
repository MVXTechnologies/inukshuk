import { computeTrackStats } from '@core/geo/track';
import type { TrackSummary } from '@core/models';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { MD3LightTheme, PaperProvider } from 'react-native-paper';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DashboardScreen } from './DashboardScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@data/storage', () => ({}));
jest.mock('../library/useRouteThumbnail', () => ({
  useRouteThumbnail: (t: { id: string }) => ({
    path: `M4 4L50 ${t.id.length}`,
    start: { x: 4, y: 4 },
  }),
}));

function track(id: string, name: string, daysAgo: number, category: string): TrackSummary {
  const startedAt = new Date(2026, 8, 23 - daysAgo, 10).getTime();
  return {
    id,
    name,
    fileUri: `${id}.gpx`,
    startedAt,
    category,
    stats: {
      ...computeTrackStats([]),
      distanceM: 11_240,
      movingTimeS: 3 * 3600 + 31 * 60,
      ascentM: 1068,
    },
  };
}

async function show(tracks: TrackSummary[]) {
  useLibraryStore.setState({ tracks, customCategories: [] });
  useSettingsStore.setState({ units: 'metric' });
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <DashboardScreen />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 8, 23, 15));
  mockPush.mockReset();
});
afterEach(() => jest.useRealTimers());

it('keeps the empty state when nothing was recorded', async () => {
  await show([]);
  expect(screen.getByText('No activities yet')).toBeTruthy();
  expect(screen.getByLabelText('Settings')).toBeTruthy();
});

it('shows lifetime totals, the weekly chart, type counts and the Recent rows', async () => {
  await show([
    track('a', 'Les Loups — Jacques-Cartier', 25, 'hike'),
    track('b', 'Mont-Sainte-Anne — La Crête', 2, 'run'),
  ]);

  expect(screen.getByLabelText(/^Lifetime totals: 22 km, 7 h, 2,136 m climbed$/)).toBeTruthy();
  expect(screen.getByText('Distance per week')).toBeTruthy();
  expect(screen.getByLabelText('Hike, 1 activity')).toBeTruthy();
  expect(screen.getByLabelText('Run, 1 activity')).toBeTruthy();
  expect(screen.getByLabelText('Ski, 0 activities')).toBeTruthy();
  expect(screen.getByLabelText('Bike, 0 activities')).toBeTruthy();

  // Recent: newest first, with the board's stats line and caption.
  const rows = screen.getAllByLabelText(/— .*, 11\.2 km · 3:31 · ↑1068 m, /);
  expect(rows.map((r) => r.props.accessibilityLabel)).toEqual([
    'Mont-Sainte-Anne — La Crête, 11.2 km · 3:31 · ↑1068 m, Sep 21 · Run',
    'Les Loups — Jacques-Cartier, 11.2 km · 3:31 · ↑1068 m, Aug 29 · Hike',
  ]);
  await fireEvent.press(rows[0]!);
  expect(mockPush).toHaveBeenCalledWith('/trail3d/b');
});

it('filters by type from the chips, and says so when a type has nothing', async () => {
  await show([track('a', 'Hike one', 3, 'hike')]);
  expect(screen.queryByText('No activities')).toBeNull();

  await fireEvent.press(screen.getByLabelText('Ski, 0 activities'));
  expect(screen.getByText('No activities')).toBeTruthy();
  expect(screen.getByText('No Ski activities yet.')).toBeTruthy();

  // Tapping the selected chip again clears the filter.
  await fireEvent.press(screen.getByLabelText('Ski, 0 activities'));
  expect(screen.queryByText('No activities')).toBeNull();
});

it('switches the chart to months', async () => {
  await show([track('a', 'Hike one', 3, 'hike')]);
  await fireEvent.press(screen.getByText('Month'));
  expect(screen.getByText('Distance per month')).toBeTruthy();
  expect(screen.getByText(/^Last 12 months · /)).toBeTruthy();
});

it('draws the lifetime units in the card ink, not the page ink', async () => {
  await show([track('a', 'Mont Albert', 1, 'hike')]);
  // The innermost match is the unit span nested in the value ("11 km").
  const unit = screen
    .getAllByText(/km$/)
    .find((t) => JSON.stringify(t.props.children) === JSON.stringify([' ', 'km']));
  expect(unit).toBeDefined();
  expect(StyleSheet.flatten(unit?.props.style).color).toBe(MD3LightTheme.colors.inverseOnSurface);
});

it('shows each recent activity with its route thumbnail', async () => {
  await show([track('abc', 'Mont Albert', 1, 'hike')]);
  expect(JSON.stringify(screen.toJSON())).toContain('M4 4L50 3');
});
