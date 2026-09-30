/** Support Inukshuk entry points (#476): the Settings card, the Library nudge, the thank-you. */
import { SUPPORT_NUDGE_ENABLED } from '@core/features/flags';
import type { TrackSummary } from '@core/models';
import { NUDGE_INTERVAL_MS } from '@core/support/nudge';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SupportNudgeCard } from './SupportNudgeCard';
import { SupportSettingsRow } from './SupportSettingsRow';
import { SupportThanksScreen } from './SupportThanksScreen';

const mockPush = jest.fn();
const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, dismissTo: mockDismissTo }),
  useLocalSearchParams: () => ({}),
}));

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  readJson: jest.fn(async () => null),
}));

async function mount(node: ReactNode) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>{node}</PaperProvider>
    </SafeAreaProvider>,
  );
}

async function press(text: string) {
  await act(async () => {
    fireEvent.press(screen.getByText(text));
  });
}

const trail = (i: number, imported = false): TrackSummary => ({
  id: `t${i}`,
  name: `t${i}`,
  startedAt: new Date(new Date().getFullYear(), 0, 1 + i, 9).getTime(),
  fileUri: `file:///Documents/tracks/t${i}.gpx`,
  stats: {
    distanceM: 0,
    ascentM: 0,
    descentM: 0,
    durationS: 0,
    movingTimeS: 0,
    avgSpeedMps: 0,
    maxSpeedMps: 0,
    pointCount: 1,
  },
  ...(imported ? { origin: { source: 'strava' as const, externalId: `s${i}` } } : {}),
});

const trails = (n: number, imported = false) =>
  Array.from({ length: n }, (_, i) => trail(i, imported));

beforeEach(async () => {
  useSettingsStore.getState().reset();
  await useSettingsStore.getState().hydrate();
  useLibraryStore.setState({ tracks: [] });
});

describe('Settings › Support Inukshuk', () => {
  it('opens the Support screen', async () => {
    await mount(<SupportSettingsRow />);
    expect(screen.getByText('Free, no ads. Kept alive by donations.')).toBeTruthy();
    await press('Support Inukshuk');
    expect(mockPush).toHaveBeenCalledWith('/support');
  });
});

describe('Library nudge', () => {
  it('ships switched off', () => {
    expect(SUPPORT_NUDGE_ENABLED).toBe(false);
  });

  it('renders nothing with the flag off, whatever the Library holds', async () => {
    useLibraryStore.setState({ tracks: trails(40) });
    await mount(<SupportNudgeCard />);
    expect(screen.queryByTestId('support-nudge')).toBeNull();
  });

  it('shows from 10 recorded outings this year, not counting imports', async () => {
    useLibraryStore.setState({
      tracks: [...trails(9), ...trails(30, true).map((t) => ({ ...t, id: `i${t.id}` }))],
    });
    const view = await mount(<SupportNudgeCard enabled />);
    expect(screen.queryByTestId('support-nudge')).toBeNull();

    await act(async () => {
      useLibraryStore.setState({ tracks: trails(10) });
    });
    view.rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 400, height: 800 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <PaperProvider>
          <SupportNudgeCard enabled />
        </PaperProvider>
      </SafeAreaProvider>,
    );
    expect(screen.getByText('You recorded 10 outings with Inukshuk this year.')).toBeTruthy();
  });

  it('"Not now" hides it for 12 months', async () => {
    useLibraryStore.setState({ tracks: trails(12) });
    await mount(<SupportNudgeCard enabled />);
    await press('Not now');
    expect(screen.queryByTestId('support-nudge')).toBeNull();
    const answered = useSettingsStore.getState().supportNudgeAnsweredAt;
    expect(Date.now() - answered).toBeLessThan(5000);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('"Support" opens the Support screen and also counts as the yearly answer', async () => {
    useLibraryStore.setState({ tracks: trails(12) });
    await mount(<SupportNudgeCard enabled />);
    await press('Support');
    expect(mockPush).toHaveBeenCalledWith('/support');
    expect(useSettingsStore.getState().supportNudgeAnsweredAt).toBeGreaterThan(0);
  });

  it('comes back a year after the last answer', async () => {
    useLibraryStore.setState({ tracks: trails(12) });
    useSettingsStore.getState().set('supportNudgeAnsweredAt', Date.now() - NUDGE_INTERVAL_MS - 1);
    await mount(<SupportNudgeCard enabled />);
    expect(screen.getByTestId('support-nudge')).toBeTruthy();
  });
});

describe('Thank-you screen', () => {
  it('thanks and returns to the map', async () => {
    await mount(<SupportThanksScreen />);
    expect(screen.getByText('Thank you')).toBeTruthy();
    await press('Back to the map');
    expect(mockDismissTo).toHaveBeenCalledWith('/');
  });
});
