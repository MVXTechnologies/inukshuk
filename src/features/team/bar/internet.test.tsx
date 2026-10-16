/**
 * Team mode over the internet on the map (#705, G7 mockup screens 2–4 and
 * 10), store-only, both themes: the pill's glyph is the path, the panel's
 * connection chip opens the Connection sheet, members carry link chips, the
 * sheet holds the one encryption line, and an SOS from another team offers
 * to show it.
 */
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { METRIC } from '@core/format';
import type { MemberLink } from '@core/teamui/links';
import type { TeamView } from '@core/teamui/view';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore, type TeamNet } from '@state/teamStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { TeamSheetCard } from '../map/TeamCards';
import { useTeamSheet } from '../map/teamMode';
import { SosAlarmBanner } from './SosAlarmBanner';
import { TeamPanel } from './TeamPanel';
import { TeamStatusBar } from './TeamStatusBar';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@data/storage', () => ({
  newId: () => 'new-id',
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
  deleteFileAt: jest.fn(),
}));
jest.mock('@data/team/teamNotifications', () => ({
  buzzRally: () => undefined,
  notifyTeam: async () => undefined,
  onTeamNotificationTap: () => () => undefined,
  dismissTeamNotification: async () => undefined,
  setInAppAlarm: () => undefined,
  SOS_VIBRATION: [0, 900, 250, 900],
}));
jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const HERE = { latitude: 46.8, longitude: -71.2 };
const wrap = (children: ReactNode, dark = false) => (
  <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>{children}</PaperProvider>
);
const THEMES = [false, true] as const;

const member = (id: string, name: string, extra: Partial<TeamView['members'][number]> = {}) =>
  ({
    id,
    name,
    named: true,
    initials: name
      .split(' ')
      .map((w) => w[0])
      .join(''),
    color: '#3F8FD8',
    role: 'member',
    active: true,
    isMe: false,
    groups: [],
    joinedAt: 0,
    via: null,
    left: false,
    lastSeenAt: null,
    ...extra,
  }) as TeamView['members'][number];

const LINKS: Record<string, MemberLink> = {
  julie: 'direct',
  alex: 'relay',
  noe: 'nearby',
  lea: 'out',
};

const open = (memberId: string) => ({
  peerId: memberId,
  memberId,
  direction: 'out' as const,
  host: '',
  phase: 'open',
  joining: false,
  safetyCode: null,
  connectedAt: 0,
  lastFrameAt: 0,
  bytesIn: 0,
  bytesOut: 0,
});

function crew(net: Partial<TeamNet> = {}, peers = ['julie', 'alex', 'noe']) {
  const now = Date.now();
  useTeamStore.setState({
    activeId: 't',
    view: {
      teamId: 't',
      name: 'Chic-Chocs crew',
      me: 'me',
      active: true,
      isAdmin: false,
      members: [
        member('me', 'Marc Vigneault', { isMe: true, role: 'owner' }),
        member('julie', 'Julie Tremblay'),
        member('alex', 'Alex Lavoie'),
        member('noe', 'Noé Gagnon'),
        member('lea', 'Léa Pelletier', { lastSeenAt: now - 34 * 60_000 }),
      ],
    } as unknown as TeamView,
    positions: [],
    peers: peers.map(open),
    meshRunning: true,
    meshWanted: true,
    unread: 0,
    threadsUnread: 0,
    statuses: new Map(),
    tasks: [],
    soses: [],
    rally: null,
    sosAlarm: null,
    dataVersion: String(now),
    net: {
      on: true,
      capable: true,
      online: true,
      room: 'ready',
      provisional: false,
      links: new Map(Object.entries(LINKS)),
      ...net,
    },
  });
}

beforeEach(() => {
  mockPush.mockReset();
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    extensions: { ...d, team: { ...d.team, installedAt: Date.now() } },
    units: METRIC,
    teamAlwaysRelay: false,
  });
  useTeamSheet.getState().close();
});

describe('the pill’s glyph is the path (#705)', () => {
  it.each(THEMES)('cloud in the team’s room (dark: %s)', async (dark) => {
    crew();
    await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />, dark));
    expect(screen.getByTestId('team-bar-glyph-net')).toBeTruthy();
  });

  it('amber cloud when the relay is out of reach and a nearby phone syncs', async () => {
    crew({ room: 'failing' }, ['noe']);
    await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-bar-glyph-noNet')).toBeTruthy();
  });

  it('no amber flash while the room is still being reached; a team with it off reads as in 2.6', async () => {
    crew({ room: 'trying' });
    const r = await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-bar-glyph-lan')).toBeTruthy();
    await act(async () => crew({ on: false }));
    r.rerender(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-bar-glyph-lan')).toBeTruthy();
  });
});

describe('the panel: who is reached how (#705)', () => {
  it.each(THEMES)(
    'a connection chip into the Connection sheet, and a link chip per member (dark: %s)',
    async (dark) => {
      crew();
      await render(wrap(<TeamPanel top={8} here={HERE} />, dark));
      expect(screen.getByText('Internet + nearby')).toBeTruthy();
      expect(screen.getByTestId('team-link-direct')).toBeTruthy();
      expect(screen.getByTestId('team-link-relay')).toBeTruthy();
      expect(screen.getByTestId('team-link-nearby')).toBeTruthy();
      expect(screen.getByTestId('team-link-out')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('team-panel-connection'));
      expect(useTeamSheet.getState().sheet).toEqual({ kind: 'connection' });
    },
  );

  it('a team with the internet off keeps the 2.6 header and no chips', async () => {
    crew({ on: false });
    await render(wrap(<TeamPanel top={8} here={HERE} />));
    expect(screen.queryByTestId('team-panel-connection')).toBeNull();
    expect(screen.queryByTestId('team-link-direct')).toBeNull();
  });
});

describe('the Connection sheet (#705)', () => {
  it.each(THEMES)(
    'this phone, each teammate and why, the one E2E line (dark: %s)',
    async (dark) => {
      crew();
      await render(
        wrap(
          <TeamSheetCard sheet={{ kind: 'connection' }} here={HERE} onPointActions={jest.fn()} />,
          dark,
        ),
      );
      expect(screen.getByText('Connected')).toBeTruthy();
      expect(screen.getByText('1 phone nearby')).toBeTruthy();
      expect(screen.getByText('Phone to phone over the internet')).toBeTruthy();
      expect(screen.getByText('No direct path between your networks')).toBeTruthy();
      expect(screen.getByText('Same Wi-Fi or hotspot, no internet used')).toBeTruthy();
      expect(screen.getByText('Last seen 34 min ago')).toBeTruthy();
      expect(screen.getByText(/End-to-end encrypted, on every path/)).toBeTruthy();
      await fireEvent.press(screen.getByTestId('team-connection-settings'));
      expect(mockPush).toHaveBeenCalledWith('/team/connection');
    },
  );

  it('says why when this phone chose the relay', async () => {
    crew();
    useSettingsStore.setState({ teamAlwaysRelay: true });
    await render(
      wrap(<TeamSheetCard sheet={{ kind: 'connection' }} here={HERE} onPointActions={jest.fn()} />),
    );
    expect(screen.getByText('Through the relay, as you chose')).toBeTruthy();
    expect(screen.getByText('Relay only on this phone')).toBeTruthy();
  });
});

describe('an SOS from another of my teams (owner 2026-10-16)', () => {
  it.each(THEMES)('the banner names that team and offers to show it (dark: %s)', async (dark) => {
    crew();
    useTeamStore.setState({
      sosAlarm: {
        entity: 'sos:julie:s1',
        teamId: 'hut',
        owner: 'julie',
        authorName: 'Julie Tremblay',
        teamName: 'Gaspésie 2026',
        text: 'SOS · needs help',
        at: Date.now(),
      },
    });
    await render(wrap(<SosAlarmBanner />, dark));
    expect(screen.getByText('Gaspésie 2026')).toBeTruthy();
    expect(screen.getByLabelText('Show Gaspésie 2026')).toBeTruthy();
    await act(async () => useTeamStore.getState().acknowledgeAlarm());
  });

  it('no team chip for an SOS from the team on screen', async () => {
    crew();
    useTeamStore.setState({
      sosAlarm: {
        entity: 'sos:julie:s1',
        teamId: 't',
        owner: 'julie',
        authorName: 'Julie Tremblay',
        teamName: 'Chic-Chocs crew',
        text: 'SOS · needs help',
        at: Date.now(),
      },
    });
    await render(wrap(<SosAlarmBanner />));
    expect(screen.queryByTestId('team-sos-alarm-team')).toBeNull();
    await act(async () => useTeamStore.getState().acknowledgeAlarm());
  });
});
