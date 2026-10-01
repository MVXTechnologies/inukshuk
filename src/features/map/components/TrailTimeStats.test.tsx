import { render, screen } from '@testing-library/react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';
import { useSettingsStore } from '@state/settingsStore';
import { TrailTimeStats } from './TrailTimeStats';

/**
 * #504: the trail summary shows elapsed time + average next to moving time +
 * moving pace (foot) or moving speed (bike/ski), stops excluded.
 */
const STATS = {
  distanceM: 10_000,
  durationS: 3_600, // 1:00:00 elapsed → 6:00/km
  movingTimeS: 3_000, // 50:00 moving → 5:00/km at 3.333 m/s
  avgSpeedMps: 10_000 / 3_000,
};

async function mount(
  props: Partial<Parameters<typeof TrailTimeStats>[0]> = {},
  theme = MD3LightTheme,
): Promise<void> {
  await render(
    <PaperProvider theme={theme}>
      <TrailTimeStats stats={STATS} category="hike" {...props} />
    </PaperProvider>,
  );
}

beforeEach(() => {
  useSettingsStore.setState({ units: 'metric' });
});

it('shows elapsed and moving time with their paces for a hike', async () => {
  await mount();
  expect(screen.getByLabelText('Time 1:00:00')).toBeOnTheScreen();
  expect(screen.getByLabelText('Moving time 50:00')).toBeOnTheScreen();
  expect(screen.getByLabelText('Avg pace 6:00/km')).toBeOnTheScreen();
  expect(screen.getByLabelText('Moving pace 5:00/km')).toBeOnTheScreen();
});

it('shows speeds for a bike ride', async () => {
  await mount({ category: 'bike' });
  expect(screen.getByLabelText('Avg speed 10.0 km/h')).toBeOnTheScreen();
  expect(screen.getByLabelText('Moving speed 12.0 km/h')).toBeOnTheScreen();
  expect(screen.queryByText('Moving pace')).toBeNull();
});

it('follows the unit setting', async () => {
  useSettingsStore.setState({ units: 'imperial' });
  await mount();
  expect(screen.getByLabelText('Moving pace 8:03/mi')).toBeOnTheScreen();
});

it('treats uncategorized trails as on foot', async () => {
  await mount({ category: undefined });
  expect(screen.getByText('Moving pace')).toBeOnTheScreen();
});

it('renders nothing for an untimed trail', async () => {
  await mount({ stats: { ...STATS, durationS: 0, movingTimeS: 0, avgSpeedMps: 0 } });
  expect(screen.queryByTestId('trail-time-stats')).toBeNull();
});

it('uses the theme for the labels in dark mode', async () => {
  await mount({}, MD3DarkTheme);
  const label = screen.getByText('Moving time');
  expect(label).toHaveStyle({ color: MD3DarkTheme.colors.onSurfaceVariant });
});
