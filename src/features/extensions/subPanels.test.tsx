/**
 * Map layers › Extensions sub-panels (#668): every installed extension's row
 * carries the same accessory (a chevron in a round tonal well, badged when
 * there is something to say) that opens its own page in the sheet — the
 * extension's switch first, then its options, which are the Settings options
 * themselves. Drawn in both themes where colour matters.
 */
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import type { AnyExtensionKey } from '@core/extensions/keys';
import type { ExtensionPrefs } from '@core/extensions/types';
import { DEFAULT_GNSS_CONFIG } from '@core/gnss/config';
import { OverlaysPanel } from '@features/map/components/MapOverlaysMenu';
import { useGnssStore } from '@state/gnssStore';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import { schemeTokens } from '@ui/tokens';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { PaperProvider } from 'react-native-paper';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@data/gnss/link', () => ({
  ...jest.requireActual('@data/gnss/link'),
  gnssLinkAvailable: () => true,
}));
jest.mock('../map/RegionPreviewThumb', () => ({ RegionPreviewThumb: () => null }));
jest.mock('./tides/coverage', () => ({ fetchTideCoverage: jest.fn(async () => null) }));
// A build that can run Team mode, with a team session the panel writes to.
const mockUpdateRecord = jest.fn();
jest.mock('@data/team/appTeam', () => ({
  teamAvailability: () => 'ok',
  appTeamService: () => ({ active: { updateRecord: mockUpdateRecord } }),
}));

const noop = (): void => undefined;

/** Install these extensions (the rest at defaults, not installed). */
function install(p: Partial<Record<AnyExtensionKey, Partial<ExtensionPrefs>>>): void {
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    overlaysTab: 'extensions',
    extensions: {
      geodetic: { ...d.geodetic, ...p.geodetic },
      tides: { ...d.tides, ...p.tides },
      gnss: { ...d.gnss, ...p.gnss },
      team: { ...d.team, ...p.team },
    },
  });
}

async function renderSheet(dark = false, onClose: () => void = noop): Promise<void> {
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <OverlaysPanel onSlopeEnabled={noop} onOpenFolders={noop} onClose={onClose} />
    </PaperProvider>,
  );
}

const checked = (label: string): unknown =>
  screen.getByLabelText(label).props.accessibilityState?.checked;
const flat = (style: unknown): ViewStyle => StyleSheet.flatten(style as StyleProp<ViewStyle>) ?? {};

/** A team open on this phone, as the store's view and record hold it. */
function openTeam(over: { unread?: number; isAdmin?: boolean; teams?: number } = {}): void {
  useTeamStore.setState({
    view: {
      name: 'Ridge crew',
      activeCount: 4,
      isAdmin: over.isAdmin ?? true,
      readOnly: false,
    } as never,
    record: { prefs: { sharePosition: false } } as never,
    unread: over.unread ?? 0,
    teams: Array.from({ length: over.teams ?? 1 }, (_, i) => ({ id: `t${i}` })) as never,
    peers: [],
    meshRunning: true,
  });
}

beforeEach(() => {
  mockPush.mockClear();
  mockUpdateRecord.mockClear();
});

afterEach(async () => {
  await act(async () => {
    useSettingsStore.getState().reset();
    useTeamStore.setState({ view: null, record: null, unread: 0, teams: [] });
    useGnssStore.setState({ hydrated: true, config: DEFAULT_GNSS_CONFIG });
    useGnssStore.getState().resetLive();
  });
});

describe('the shared accessory', () => {
  it('is on every installed extension’s row, on or off', async () => {
    install({
      geodetic: { installedAt: 1, show: false },
      tides: { installedAt: 1, show: false },
      gnss: { installedAt: 1, show: false },
      team: { installedAt: 1, show: false },
    });
    await renderSheet();
    for (const label of [
      'Geodetic points',
      'Tide stations',
      'External GNSS receiver',
      'Team mode',
    ]) {
      const button = screen.getByLabelText(`Options for ${label}`);
      expect(button.props.accessibilityRole).toBe('button');
      expect(button.props.accessibilityState?.disabled).not.toBe(true);
    }
  });

  it.each([false, true])(
    'is a tonal well, badged in the accent with the unread count (dark: %s)',
    async (dark) => {
      install({ team: { installedAt: 1, show: true } });
      openTeam({ unread: 3 });
      await renderSheet(dark);
      const t = schemeTokens(dark);
      const theme = dark ? darkTheme : lightTheme;
      const well = screen.getByLabelText('Options for Team mode, 3 unread');
      expect(flat(well.props.style).backgroundColor).toBe(t.surfaceVariant);
      expect(flat(well.props.style).borderRadius).toBe(18);
      const badge = screen.getByTestId('sub-panel-badge');
      expect(flat(badge.props.style).backgroundColor).toBe(theme.colors.secondary);
      expect(screen.getByText('3')).toBeTruthy();
    },
  );
});

describe('Tide stations sub-panel', () => {
  it('has the switch, the gauge symbols and the sources; Back returns to the tab', async () => {
    install({ tides: { installedAt: 1, show: false } });
    await renderSheet();
    expect(screen.queryByLabelText('Gauge symbols legend')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Options for Tide stations'));
    expect(screen.queryByLabelText('Extensions tab')).toBeNull();
    expect(screen.getByLabelText('Gauge symbols legend')).toBeTruthy();
    expect(screen.getByText('COVERAGE & SOURCES')).toBeTruthy();
    expect(screen.getByText(/Not for navigation/)).toBeTruthy();
    // Without Geodetic points, no way to its tidal benchmarks.
    expect(screen.queryByLabelText('Tidal benchmarks')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Show tide stations'));
    expect(useSettingsStore.getState().extensions.tides.show).toBe(true);
    await fireEvent.press(screen.getByLabelText('Back to extensions'));
    expect(checked('Tide stations')).toBe(true);
  });

  it('leads to the tidal benchmarks: Geodetic points’ own sub-panel', async () => {
    install({ tides: { installedAt: 1 }, geodetic: { installedAt: 1 } });
    await renderSheet();
    await fireEvent.press(screen.getByLabelText('Options for Tide stations'));
    await fireEvent.press(screen.getByLabelText('Tidal benchmarks'));
    expect(screen.getByLabelText('Show geodetic points')).toBeTruthy();
    expect(screen.getByLabelText('Tidal')).toBeTruthy();
  });
});

describe('External GNSS receiver sub-panel', () => {
  beforeEach(() => {
    install({ gnss: { installedAt: 1, show: true } });
    useGnssStore.setState({
      hydrated: true,
      config: {
        ...DEFAULT_GNSS_CONFIG,
        receiver: { id: 'r1', name: 'simpleRTK2B', transport: 'ble' },
      },
      link: 'connected',
    });
  });

  it('shows the receiver’s chip and opens Live view (the receiver sheet), closing this one', async () => {
    const onClose = jest.fn();
    await renderSheet(false, onClose);
    await fireEvent.press(screen.getByLabelText('Options for External GNSS receiver'));
    expect(screen.getByTestId('gnss-panel-chip')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Live view'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useGnssStore.getState().sheetOpen).toBe(true);
  });

  it('has the same options as Settings, each writing the same config', async () => {
    await renderSheet();
    await fireEvent.press(screen.getByLabelText('Options for External GNSS receiver'));
    expect(checked('Use the external receiver')).toBe(true);
    const fallback = useGnssStore.getState().config.fallbackToPhone;
    await fireEvent.press(screen.getByLabelText('Use the phone GPS when the receiver drops'));
    expect(useGnssStore.getState().config.fallbackToPhone).toBe(!fallback);
    const standby = useGnssStore.getState().config.phoneWhileGood === 'standby';
    await fireEvent.press(screen.getByLabelText('Phone GPS in standby'));
    expect(useGnssStore.getState().config.phoneWhileGood === 'standby').toBe(!standby);
    await fireEvent.press(screen.getByLabelText('Use the external receiver'));
    expect(useSettingsStore.getState().extensions.gnss.show).toBe(false);
  });

  it.each([
    ['Receiver: simpleRTK2B', '/gnss/pair'],
    ['RTK corrections (NTRIP)', '/gnss/corrections'],
    ['Project datum', '/gnss/datum'],
  ])('%s closes the sheet, then opens %s', async (label, href) => {
    const onClose = jest.fn();
    await renderSheet(false, onClose);
    await fireEvent.press(screen.getByLabelText('Options for External GNSS receiver'));
    await fireEvent.press(screen.getByLabelText(label));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(href);
  });

  it('says so when the receiver is off: no chip, no Live view', async () => {
    install({ gnss: { installedAt: 1, show: false } });
    await renderSheet();
    await fireEvent.press(screen.getByLabelText('Options for External GNSS receiver'));
    expect(screen.getAllByText('Off · the phone’s own GPS').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Live view')).toBeNull();
  });
});

describe('Team mode sub-panel', () => {
  it('with a team: the card into the hub, Invite, sharing, taps, then the Settings rows', async () => {
    install({ team: { installedAt: 1, show: true } });
    openTeam({ teams: 2 });
    const onClose = jest.fn();
    await renderSheet(false, onClose);
    await fireEvent.press(screen.getByLabelText('Options for Team mode'));
    expect(screen.getByText('Ridge crew')).toBeTruthy();
    expect(screen.getByText(/4 members/)).toBeTruthy();
    expect(screen.getByLabelText('Your teams')).toBeTruthy();
    expect(screen.getByLabelText('Create a team')).toBeTruthy();
    expect(screen.getByLabelText('Join a team')).toBeTruthy();
    expect(screen.getByText(/shared only while you turn sharing on/)).toBeTruthy();

    expect(checked('Share my position with the team')).toBe(false);
    await fireEvent.press(screen.getByLabelText('Share my position with the team'));
    expect(mockUpdateRecord).toHaveBeenCalledWith({ prefs: { sharePosition: true } });

    expect(checked('Taps signal the team')).toBe(true);
    await fireEvent.press(screen.getByLabelText('Taps signal the team'));
    expect(useSettingsStore.getState().extensions.team.show).toBe(false);

    await fireEvent.press(screen.getByText('Open team hub'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenLastCalledWith('/team');
    await fireEvent.press(screen.getByText('Invite'));
    expect(mockPush).toHaveBeenLastCalledWith('/team/invite');
    await fireEvent.press(screen.getByLabelText('Join a team'));
    expect(mockPush).toHaveBeenLastCalledWith('/team/join');
  });

  it('Invite is for the team’s admins only', async () => {
    install({ team: { installedAt: 1 } });
    openTeam({ isAdmin: false });
    await renderSheet();
    await fireEvent.press(screen.getByLabelText('Options for Team mode'));
    expect(screen.getByText('Open team hub')).toBeTruthy();
    expect(screen.queryByText('Invite')).toBeNull();
  });

  it('with no team: says so, Create and Join first, no sharing switch', async () => {
    install({ team: { installedAt: 1 } });
    await renderSheet();
    expect(screen.getByText('No team yet · create or join one')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Options for Team mode'));
    expect(screen.getByText('No team yet')).toBeTruthy();
    expect(screen.queryByText('Open team hub')).toBeNull();
    expect(screen.queryByLabelText('Share my position with the team')).toBeNull();
    expect(screen.queryByLabelText('Your teams')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Create a team'));
    expect(mockPush).toHaveBeenCalledWith('/team/create');
  });
});
