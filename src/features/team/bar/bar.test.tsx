/**
 * The team bar (#707) and the active alerts (#708) on screen: the pill and
 * chips, the panel, the SOS hold + undo, Rally here + undo, the bands and
 * the in-app alarm, in both themes. Timers are jest's (modern fake timers):
 * no real sleeps; the clock moves only when a test advances it.
 */
import { IMPERIAL, METRIC } from '@core/format';
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import type { TeamRally, TeamSos } from '@core/teamui/field';
import type { TeamView } from '@core/teamui/view';
import { lifetimeMs } from '@core/teamui/lifetime';
import { resetAppTeamServiceForTests } from '@data/team/appTeam';
import { LoopbackMeshHub } from '@data/team/loopbackMesh';
import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, StyleSheet, Vibration } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { useTeamMapSelection } from '../map/TeamMapOverlay';
import { useTeamSheet } from '../map/teamMode';
import { AlertBands } from './AlertBands';
import { usePendingAlert } from './pendingAlert';
import { RESOUND_MS, SosAlarmBanner } from './SosAlarmBanner';
import { SosButton } from './SosButton';
import { TeamPanel } from './TeamPanel';
import { TeamStatusBar, useTeamBarLayout } from './TeamStatusBar';
import { UNDO_SNACK_LIFT, UndoSnack } from './UndoSnack';

const mockPush = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    navigate: mockNavigate,
    back: jest.fn(),
    replace: jest.fn(),
  }),
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
const mockNotify = jest.fn(async (_n: unknown) => undefined);
const mockSilence = jest.fn();
jest.mock('@data/team/teamNotifications', () => ({
  buzzRally: () => undefined,
  notifyTeam: (n: unknown) => mockNotify(n),
  onTeamNotificationTap: () => () => undefined,
  dismissTeamNotification: async () => undefined,
  setInAppAlarm: () => undefined,
  SOS_VIBRATION: [0, 900, 250, 900],
  armSos: () => undefined,
  silenceSos: (id: string) => mockSilence(id),
  SOS_TONE_MS: 8_000,
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

/** Jest's clock for this test (timers and Date.now move only when advanced). */
let faked = false;
function fakeClock(): void {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  faked = true;
}
// The app is in front (the alarm re-sounds only then).
Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });

beforeEach(() => {
  mockPush.mockReset();
  mockNavigate.mockReset();
  mockNotify.mockClear();
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    extensions: { ...d, team: { ...d.team, installedAt: Date.now() } },
    units: METRIC,
  });
  useTeamSheet.getState().close();
  useTeamMapSelection.getState().select(null);
  usePendingAlert.setState({ pending: null, error: null });
});

afterEach(async () => {
  await act(async () => {
    usePendingAlert.getState().undo();
    if (faked) jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  faked = false;
});

// ── A crafted team (store only): the bar, the panel, the bands ──────────────

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

function crew(over: { soses?: TeamSos[]; rally?: TeamRally | null; solo?: boolean } = {}) {
  const now = Date.now();
  const members = over.solo
    ? [member('me', 'Marc Vigneault', { isMe: true, role: 'owner' })]
    : [
        member('me', 'Marc Vigneault', { isMe: true, role: 'owner' }),
        member('julie', 'Julie Tremblay'),
        member('alex', 'Alex Lavoie'),
        member('noe', 'Noé Gagnon'),
        member('sam', 'Sam Bouchard', { lastSeenAt: now - 8 * 60_000 }),
        member('lea', 'Léa Pelletier'),
      ];
  const pos = (id: string, lat: number, lon: number, ageMs: number) => ({
    id,
    name: id,
    initials: id.slice(0, 2),
    color: '#3F8FD8',
    role: 'member' as const,
    lat,
    lon,
    accuracy: null,
    elevation: null,
    at: now - ageMs,
    ageMs,
    band: (ageMs <= 5 * 60_000 ? 'fresh' : ageMs <= 15 * 60_000 ? 'stale' : 'lost') as never,
  });
  useTeamStore.setState({
    view: {
      teamId: 't',
      name: 'Chic-Chocs crew',
      me: 'me',
      active: true,
      isAdmin: false,
      members,
    } as unknown as TeamView,
    positions: over.solo
      ? []
      : [
          pos('julie', 46.8026, -71.1977, 0),
          pos('alex', 46.811, -71.2, 60_000),
          pos('noe', 46.796, -71.205, 10_000),
          pos('lea', 46.757, -71.2, 34 * 60_000),
        ],
    peers: [],
    meshRunning: true,
    meshWanted: true,
    unread: 2,
    threadsUnread: 1,
    statuses: new Map(),
    tasks: [],
    soses: over.soses ?? [],
    rally: over.rally ?? null,
    dataVersion: String(now),
  });
}

describe('the team status bar (#707)', () => {
  it.each(THEMES)(
    'pill, faces and the chat’s unread; no chip row on the map; a tap opens the panel (dark: %s)',
    async (dark) => {
      crew();
      await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />, dark));
      expect(
        screen.getByLabelText(
          /^Chic-Chocs crew: 4 of 6 online, looking for teammates.*, 3 unread in chat$/,
        ),
      ).toBeTruthy();
      expect(screen.getByTestId('team-bar-status').props.children).toBe('4/6');
      expect(screen.getByTestId('team-bar-unread')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
      // Chat, Rally here and Draw live in the panel now (#743).
      expect(screen.queryByTestId(/^team-chip-/)).toBeNull();
      expect(screen.queryByTestId('team-bar-gather')).toBeNull();
      await fireEvent.press(screen.getByTestId('team-bar-pill'));
      expect(useTeamSheet.getState().sheet).toEqual({ kind: 'menu' });
    },
  );

  it('solo: "Only you"; offline reads "Offline"', async () => {
    crew({ solo: true });
    const r = await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-bar-status').props.children).toBe('Only you');
    expect(screen.queryByTestId(/^team-chip-/)).toBeNull();
    await r.unmount();
    crew();
    // Not syncing; the newest word from anyone is Sam's, 8 min ago.
    await act(async () =>
      useTeamStore.setState((st) => ({
        meshRunning: false,
        meshWanted: false,
        positions: st.positions.map((p) => ({ ...p, ageMs: p.ageMs + 12 * 60_000 })),
      })),
    );
    await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-bar-status').props.children).toBe('Offline · 8 min');
  });

  it('while the mesh starts at launch: "Connecting…", not a flash of "Offline" (QA 2.6.1)', async () => {
    crew();
    await act(async () => useTeamStore.setState({ meshRunning: false, meshWanted: true }));
    await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-bar-status').props.children).toBe('Connecting…');
    expect(screen.queryByText(/Offline/)).toBeNull();
    await act(async () => useTeamStore.setState({ meshRunning: true }));
    expect(screen.getByTestId('team-bar-status').props.children).toBe('4/6');
  });

  it('publishes the column height for the chips under it', async () => {
    crew();
    await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />));
    const column = screen.getByTestId('team-bar-column');
    await fireEvent(column, 'layout', { nativeEvent: { layout: { height: 44 } } });
    expect(useTeamBarLayout.getState().height).toBe(48 + 8 + 44);
  });
});

describe('a gather: the pill’s "!" and the panel, no band on the map (#743)', () => {
  const rally: TeamRally = {
    id: 'r1',
    owner: 'noe',
    lat: 46.81,
    lng: -71.2,
    text: 'Lac-Delage',
    when: null,
    radius: 60,
    at: Date.now(),
  };
  const sos: TeamSos = {
    id: 's1',
    owner: 'julie',
    lat: 46.804,
    lng: -71.195,
    text: '',
    at: Date.now() - 60_000,
    resolved: false,
    resolvedBy: null,
  };

  it.each(THEMES)(
    'an amber "!" on the pill; no gather band; a tap opens the panel (dark: %s)',
    async (dark) => {
      crew({ rally });
      await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />, dark));
      expect(screen.getByTestId('team-bar-gather')).toBeTruthy();
      expect(screen.getByText('!')).toBeTruthy();
      expect(screen.getByLabelText(/, a gather is active, 3 unread in chat$/)).toBeTruthy();
      expect(screen.queryByTestId('team-band-gather')).toBeNull();
      expect(screen.queryByTestId('team-alert-bands')).toBeNull();
      await fireEvent.press(screen.getByTestId('team-bar-pill'));
      expect(useTeamSheet.getState().sheet).toEqual({ kind: 'menu' });
      // The "!" is its own target on the pill's corner (half of it sits outside
      // the pill, where a child of the pill took no taps on Android).
      await act(async () => useTeamSheet.getState().close());
      const bang = screen.getByTestId('team-bar-gather');
      expect(StyleSheet.flatten(bang.props.style)).toMatchObject({ top: 2, right: 70 });
      await fireEvent.press(bang);
      expect(useTeamSheet.getState().sheet).toEqual({ kind: 'menu' });
    },
  );

  it('an SOS keeps its full red band under the pill, the gather its "!"', async () => {
    crew({ rally, soses: [sos] });
    await render(wrap(<TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-band-sos')).toBeTruthy();
    expect(screen.getByText('SOS · Julie Tremblay')).toBeTruthy();
    // No "+1" folding the gather under it: the gather is not a map band.
    expect(screen.queryByTestId('team-band-more')).toBeNull();
    expect(screen.getByTestId('team-bar-gather')).toBeTruthy();
  });

  it('the strip band on the map: SOS only', async () => {
    crew({ rally });
    const r = await render(
      wrap(<AlertBands here={HERE} onNavigate={jest.fn()} variant="strip" scope="map" />),
    );
    expect(screen.queryByTestId('team-alert-bands')).toBeNull();
    await r.unmount();
    crew({ rally, soses: [sos] });
    await render(
      wrap(<AlertBands here={HERE} onNavigate={jest.fn()} variant="strip" scope="map" />),
    );
    expect(screen.getByTestId('team-band-sos')).toBeTruthy();
    expect(screen.queryByTestId('team-band-gather')).toBeNull();
  });

  it.each(THEMES)(
    'the panel opens on the gather: who, where from me, Go, every member’s ETA (dark: %s)',
    async (dark) => {
      crew({ rally });
      useTeamSheet.getState().open({ kind: 'menu' });
      const nav = jest.fn();
      await render(wrap(<TeamPanel top={0} here={HERE} onNavigate={nav} />, dark));
      expect(screen.getByTestId('team-panel-gather')).toBeTruthy();
      expect(screen.getByText('Gather · Lac-Delage')).toBeTruthy();
      expect(screen.getByText('1.1 km N · by Noé')).toBeTruthy();
      // A member: Go, no End.
      expect(screen.queryByTestId('team-panel-gather-end')).toBeNull();
      const rows = screen
        .queryAllByTestId(/^team-gather-eta-/)
        .map((n) => n.props.testID as string)
        .filter((id, k, all) => all.indexOf(id) === k);
      expect(rows[0]).toBe('team-gather-eta-Alex Lavoie');
      expect(rows).toHaveLength(6);
      expect(screen.getByLabelText('Alex Lavoie: 111 m, about 2 minutes')).toBeTruthy();
      expect(screen.getByLabelText('Sam Bouchard: position unknown')).toBeTruthy();
      // Chat, Rally here and Draw are in the panel.
      for (const id of ['chat', 'rally', 'draw', 'status'])
        expect(screen.getByTestId(`team-panel-${id}`)).toBeTruthy();
      await fireEvent.press(screen.getByTestId('team-panel-gather-go'));
      expect(nav).toHaveBeenCalledWith(46.81, -71.2);
      expect(useTeamSheet.getState().sheet).toBeNull();
    },
  );

  it('an admin may End it, confirmed inline; Cancel keeps it', async () => {
    crew({ rally });
    await act(async () =>
      useTeamStore.setState((st) => ({ view: { ...st.view!, isAdmin: true } as TeamView })),
    );
    await render(wrap(<TeamPanel top={0} here={HERE} />));
    await fireEvent.press(screen.getByTestId('team-panel-gather-end'));
    expect(screen.getByText('End for everyone?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('team-panel-gather-cancel'));
    expect(screen.getByText('Gather · Lac-Delage')).toBeTruthy();
  });

  it('no gather: the panel has no gather part', async () => {
    crew();
    await render(wrap(<TeamPanel top={0} here={HERE} />));
    expect(screen.queryByTestId('team-panel-gather')).toBeNull();
  });
});

describe('the team panel (#707)', () => {
  it.each(THEMES)(
    'members live and nearest first; a row opens the card (dark: %s)',
    async (dark) => {
      crew();
      await render(wrap(<TeamPanel top={0} here={HERE} />, dark));
      const rows = screen
        .queryAllByTestId(/^team-panel-member-/)
        .map((n) => n.props.testID as string)
        .filter((id, k, all) => all.indexOf(id) === k);
      expect(rows).toEqual([
        'team-panel-member-Julie Tremblay',
        'team-panel-member-Noé Gagnon',
        'team-panel-member-Alex Lavoie',
        'team-panel-member-Sam Bouchard',
        'team-panel-member-Léa Pelletier',
      ]);
      expect(screen.getByText('Members · 4 of 6 online')).toBeTruthy();
      for (const id of ['tasks', 'rally-point', 'manage'])
        expect(screen.getByTestId(`team-panel-${id}`)).toBeTruthy();
      await fireEvent.press(screen.getByTestId('team-panel-member-Julie Tremblay'));
      expect(useTeamMapSelection.getState().hit).toEqual({ kind: 'member', id: 'julie' });
      expect(useTeamSheet.getState().sheet).toBeNull();
    },
  );

  it('distances in the user’s units (#702)', async () => {
    crew();
    useSettingsStore.setState({ units: IMPERIAL });
    await render(wrap(<TeamPanel top={0} here={HERE} />));
    expect(screen.getByText('0.2 mi NE')).toBeTruthy();
    expect(screen.queryByText(/\d m /)).toBeNull();
  });

  it('a teammate without a position opens their page; Manage team goes to the team', async () => {
    crew();
    await render(wrap(<TeamPanel top={0} here={HERE} />));
    await fireEvent.press(screen.getByTestId('team-panel-member-Sam Bouchard'));
    expect(mockPush).toHaveBeenCalledWith('/team/member/sam');
    await fireEvent.press(screen.getByTestId('team-panel-manage'));
    expect(mockPush).toHaveBeenCalledWith('/team');
  });
});

describe('the alert bands (#708)', () => {
  const sos = (owner: string, id: string, at = Date.now() - 120_000): TeamSos => ({
    id,
    owner,
    lat: 46.804,
    lng: -71.195,
    text: '',
    at,
    resolved: false,
    resolvedBy: null,
  });
  const rally: TeamRally = {
    id: 'r1',
    owner: 'noe',
    lat: 46.81,
    lng: -71.2,
    text: 'Lac-Delage',
    when: null,
    radius: 60,
    at: Date.now(),
  };

  it.each(THEMES)('others’ SOS: name, where, Navigate and Centre (dark: %s)', async (dark) => {
    crew({ soses: [sos('julie', 's1')] });
    const nav = jest.fn();
    const centre = jest.fn();
    await render(wrap(<AlertBands here={HERE} onNavigate={nav} onCentre={centre} />, dark));
    expect(screen.getByText('SOS · Julie Tremblay')).toBeTruthy();
    // Julie's live position (her SOS follows her).
    expect(screen.getByText('338 m NE · 2 min')).toBeTruthy();
    // In the user's units (#702).
    await act(() => useSettingsStore.setState({ units: IMPERIAL }));
    expect(screen.getByText('0.2 mi NE · 2 min')).toBeTruthy();
    await act(() => useSettingsStore.setState({ units: METRIC }));
    await fireEvent.press(screen.getByTestId('team-band-sos-navigate'));
    expect(nav).toHaveBeenCalledWith(46.8026, -71.1977);
    await fireEvent.press(screen.getByTestId('team-band-sos-centre'));
    expect(centre).toHaveBeenCalledWith(46.8026, -71.1977);
  });

  it('an admin resolves a teammate’s SOS by the same hold', async () => {
    crew({ soses: [sos('julie', 's1')] });
    await act(async () =>
      useTeamStore.setState((st) => ({ view: { ...st.view!, isAdmin: true } as TeamView })),
    );
    await render(wrap(<AlertBands here={HERE} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-band-sos-navigate')).toBeTruthy();
    expect(screen.getByLabelText('Resolve the SOS. Hold for two seconds')).toBeTruthy();
    expect(screen.getByTestId('team-band-sos-resolve-label').props.children).toBe('Resolve');
  });

  it('SOS outranks gather; +1 expands to stacked bands', async () => {
    crew({ soses: [sos('julie', 's1')], rally });
    await render(wrap(<AlertBands here={HERE} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-band-sos')).toBeTruthy();
    expect(screen.queryByTestId('team-band-gather')).toBeNull();
    await fireEvent.press(screen.getByLabelText('1 more active alert'));
    expect(screen.getByText('Gather · Lac-Delage')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Fold the alerts'));
    expect(screen.queryByTestId('team-band-gather')).toBeNull();
  });

  it.each(THEMES)(
    'a tap on the gather’s words lists who gets there when; Navigate stays (dark: %s)',
    async (dark) => {
      fakeClock();
      crew({ rally });
      const nav = jest.fn();
      await render(wrap(<AlertBands here={HERE} onNavigate={nav} />, dark));
      expect(screen.queryByTestId('team-gather-etas')).toBeNull();
      await fireEvent.press(screen.getByTestId('team-band-gather-text'));
      expect(screen.getByTestId('team-gather-etas')).toBeTruthy();
      // Where it is, in full, heads the expanded list (QA 2.6.1).
      expect(screen.getByTestId('team-gather-coords').props.children).toMatch(
        /^\d+\.\d{6}, -\d+\.\d{6}$/,
      );
      const rows = screen
        .queryAllByTestId(/^team-gather-eta-/)
        .map((n) => n.props.testID as string)
        .filter((id, k, all) => all.indexOf(id) === k);
      // Nearest to arrive first; no recent position (Léa: 34 min; Sam: none) last.
      expect(rows).toEqual([
        'team-gather-eta-Alex Lavoie',
        'team-gather-eta-Julie Tremblay',
        'team-gather-eta-You',
        'team-gather-eta-Noé Gagnon',
        'team-gather-eta-Léa Pelletier',
        'team-gather-eta-Sam Bouchard',
      ]);
      expect(screen.getByLabelText('Alex Lavoie: 111 m, about 2 minutes')).toBeTruthy();
      expect(screen.getByLabelText('Léa Pelletier: position unknown')).toBeTruthy();
      expect(screen.getByLabelText('Sam Bouchard: position unknown')).toBeTruthy();
      // Navigate stays on the band, list open.
      await fireEvent.press(screen.getByTestId('team-band-gather-navigate'));
      expect(nav).toHaveBeenCalledWith(46.81, -71.2);
      // The list follows the team: Sam's first fix puts him in it.
      await act(async () => {
        jest.advanceTimersByTime(60_000);
        useTeamStore.setState((st) => ({
          positions: [
            ...st.positions,
            { ...st.positions[0]!, id: 'sam', lat: 46.8099, lon: -71.2, ageMs: 0 },
          ],
        }));
      });
      expect(screen.getByLabelText('Sam Bouchard: there')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('team-band-gather-text'));
      expect(screen.queryByTestId('team-gather-etas')).toBeNull();
    },
  );

  it('the strip variant is one compact line', async () => {
    crew({ rally });
    await render(wrap(<AlertBands here={HERE} onNavigate={jest.fn()} variant="strip" />));
    expect(screen.getByText('Gather · Lac-Delage')).toBeTruthy();
    expect(screen.queryByText(/by Noé/)).toBeNull();
  });

  it('nothing active: nothing drawn', async () => {
    crew();
    await render(wrap(<AlertBands here={HERE} onNavigate={jest.fn()} />));
    expect(screen.queryByTestId('team-alert-bands')).toBeNull();
  });
});

describe('the in-app SOS alarm (#708)', () => {
  const julieSos = () =>
    crew({
      soses: [
        {
          id: 's1',
          owner: 'julie',
          lat: 46.804,
          lng: -71.195,
          text: '',
          at: Date.now(),
          resolved: false,
          resolvedBy: null,
        },
      ],
    });
  const ring = (teamName = 'T') =>
    act(async () =>
      useTeamStore.setState({
        sosAlarm: {
          entity: 'sos:julie:s1',
          owner: 'julie',
          authorName: 'Julie Tremblay',
          teamName,
          text: 'SOS · needs help',
          at: Date.now(),
        },
      }),
    );
  /** When each re-post went out (fake ms). */
  const postedAt: number[] = [];
  beforeEach(() => {
    postedAt.length = 0;
    mockSilence.mockClear();
    mockNotify.mockImplementation(async () => {
      postedAt.push(Date.now());
    });
  });
  afterEach(() => mockNotify.mockImplementation(async () => undefined));

  it('re-sounds every 8 s, exactly the tone’s length (F → D loops, no gap, no overlap)', () => {
    expect(RESOUND_MS).toBe(8_000);
  });

  it.each(THEMES)('sounds and vibrates until Acknowledge (dark: %s)', async (dark) => {
    fakeClock();
    julieSos();
    useSettingsStore.setState({ lastKnownPosition: HERE });
    const vibrate = jest.spyOn(Vibration, 'vibrate');
    const cancel = jest.spyOn(Vibration, 'cancel');
    await ring('Chic-Chocs crew');
    await render(wrap(<SosAlarmBanner />, dark));
    expect(screen.getByText('SOS · Julie Tremblay')).toBeTruthy();
    expect(screen.getByText('Needs help · 338 m NE of you · just now')).toBeTruthy();
    expect(vibrate).toHaveBeenCalledWith([0, 900, 250, 900], true);
    // Re-sounds every RESOUND_MS under the same id (replaces, never stacks).
    await act(async () => {
      jest.advanceTimersByTime(RESOUND_MS * 2);
    });
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(mockNotify.mock.calls[0]![0]).toMatchObject({
      channel: 'sos',
      identifier: 'sos:julie:s1',
    });
    await fireEvent.press(screen.getByTestId('team-sos-acknowledge'));
    expect(useTeamStore.getState().sosAlarm).toBeNull();
    expect(screen.queryByTestId('team-sos-alarm')).toBeNull();
    expect(cancel).toHaveBeenCalled();
    expect(mockSilence).toHaveBeenCalledWith('sos:julie:s1');
    await act(async () => {
      jest.advanceTimersByTime(RESOUND_MS * 3);
    });
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });

  it('loops back to back for as long as it takes: never a timeout, never a long silence', async () => {
    fakeClock();
    julieSos();
    const cancel = jest.spyOn(Vibration, 'cancel');
    cancel.mockClear();
    const t0 = Date.now();
    await ring();
    await render(wrap(<SosAlarmBanner />));
    // Ten minutes unanswered (the old alarm went quiet after two).
    for (let i = 0; i < 75; i++)
      await act(async () => {
        jest.advanceTimersByTime(RESOUND_MS);
      });
    // The ring itself plays the tone at 0 (the store's notification); then one per 8 s.
    expect(postedAt).toEqual(Array.from({ length: 75 }, (_, i) => t0 + (i + 1) * 8_000));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('team-sos-alarm')).toBeTruthy();
    await act(async () => useTeamStore.getState().acknowledgeAlarm());
  });

  it('Acknowledge mid-tone cuts the sound at once: notification gone, nothing more scheduled', async () => {
    fakeClock();
    julieSos();
    const cancel = jest.spyOn(Vibration, 'cancel');
    await ring();
    await render(wrap(<SosAlarmBanner />));
    await act(async () => {
      jest.advanceTimersByTime(RESOUND_MS);
    });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    // 3 s into that 8 s tone (mid stutter): Acknowledge.
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    cancel.mockClear();
    expect(mockSilence).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('team-sos-acknowledge'));
    // At once, without waiting for the tone to end.
    expect(mockSilence).toHaveBeenCalledTimes(1);
    expect(mockSilence).toHaveBeenCalledWith('sos:julie:s1');
    expect(cancel).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    await act(async () => {
      jest.advanceTimersByTime(RESOUND_MS * 10);
    });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    // The SOS stays (acknowledging is this phone's sound only).
    expect(useTeamStore.getState().soses).toHaveLength(1);
  });

  it('Navigate acknowledges (silences at once) and goes to the map', async () => {
    fakeClock();
    julieSos();
    await ring();
    await render(wrap(<SosAlarmBanner />));
    await act(async () => {
      jest.advanceTimersByTime(RESOUND_MS + 2_000);
    });
    await fireEvent.press(screen.getByTestId('team-sos-alarm-navigate'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(useTeamStore.getState().sosAlarm).toBeNull();
    expect(mockSilence).toHaveBeenCalledWith('sos:julie:s1');
    await act(async () => {
      jest.advanceTimersByTime(RESOUND_MS * 3);
    });
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('the same SOS raised again after Acknowledge rings again from the start (#752)', async () => {
    fakeClock();
    julieSos();
    await ring();
    const vibrate = jest.spyOn(Vibration, 'vibrate');
    vibrate.mockClear();
    await render(wrap(<SosAlarmBanner />));
    expect(vibrate).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(RESOUND_MS + 1_000);
    });
    await fireEvent.press(screen.getByTestId('team-sos-acknowledge'));
    const first = mockNotify.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(RESOUND_MS * 2);
    });
    expect(mockNotify.mock.calls.length).toBe(first);
    // Raised again: the store rings the same entity anew.
    const t1 = Date.now();
    await ring();
    expect(vibrate).toHaveBeenCalledTimes(2);
    await act(async () => {
      jest.advanceTimersByTime(RESOUND_MS * 2);
    });
    expect(mockNotify.mock.calls.length).toBe(first + 2);
    expect(postedAt.slice(-2)).toEqual([t1 + 8_000, t1 + 16_000]);
    await act(async () => useTeamStore.getState().acknowledgeAlarm());
  });
});

// ── A real team (one phone): hold + undo, Rally here + undo, Resolve ────────

describe('sending: hold, undo, and nothing during the countdown (#708)', () => {
  const hub = new LoopbackMeshHub();
  let app: TeamService;
  beforeEach(async () => {
    app = new TeamService({
      c: nodeCrypto,
      disk: new MemoryTeamDisk(),
      transport: hub.createTransport(),
      tickMs: 0,
      now: () => Date.now(),
    });
    resetAppTeamServiceForTests(app);
    await app.createTeam({ name: 'Ridge crew', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
    fakeClock();
    await act(async () => useTeamStore.getState().refresh());
  });
  afterEach(async () => {
    await app.active?.stopMesh();
  });

  const press = async (ms: number) => {
    const b = screen.getByTestId('team-sos-button');
    await fireEvent(b, 'pressIn');
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
    await fireEvent(b, 'pressOut');
  };

  /** How many countdowns begin from now on (a spy on the store's `start` would outlive the test). */
  const countStarts = () => {
    let n = 0;
    const off = usePendingAlert.subscribe((st, prev) => {
      if (st.pending !== null && st.pending !== prev.pending) n += 1;
    });
    unsubscribers.push(off);
    return () => n;
  };
  const unsubscribers: (() => void)[] = [];
  afterEach(() => {
    for (const off of unsubscribers.splice(0)) off();
  });

  /** Hold the band's Resolve for `ms`, then let go. */
  const holdResolve = async (ms: number) => {
    const b = screen.getByTestId('team-band-sos-resolve');
    await fireEvent(b, 'pressIn');
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
    await fireEvent(b, 'pressOut');
  };

  const sender = () =>
    wrap(
      <>
        <SosButton bottom={72} here={HERE} />
        <UndoSnack style={{}} />
      </>,
    );

  it.each(THEMES)(
    'a short tap only hints; a 2 s hold then 5 s sends the SOS (dark: %s)',
    async (dark) => {
      const vibrate = jest.spyOn(Vibration, 'vibrate');
      vibrate.mockClear();
      await render(
        wrap(
          <>
            <SosButton bottom={72} here={HERE} />
            <UndoSnack style={{}} />
          </>,
          dark,
        ),
      );
      await press(400);
      expect(screen.getByTestId('team-sos-hint')).toBeTruthy();
      expect(usePendingAlert.getState().pending).toBeNull();
      // The hold: a tick each second, then the countdown; nothing sent yet.
      await press(2100);
      expect(vibrate).toHaveBeenCalledTimes(2);
      expect(usePendingAlert.getState().pending?.kind).toBe('sos');
      expect(screen.getByTestId('team-undo-snack')).toBeTruthy();
      // Clear of the ⓘ + scale row under it, not flush on it (QA 2.6.1).
      expect(StyleSheet.flatten(screen.getByTestId('team-undo-snack').props.style)).toMatchObject({
        marginBottom: 8,
        marginHorizontal: 8,
      });
      expect(UNDO_SNACK_LIFT).toBe(8);
      expect(screen.getByText('Sends in 5 s')).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      expect(screen.getByText('Sends in 1 s')).toBeTruthy();
      expect(app.active!.soses()).toHaveLength(0);
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(app.active!.soses()).toMatchObject([{ owner: app.active!.me, resolved: false }]);
      expect(screen.queryByTestId('team-undo-snack')).toBeNull();
      // My SOS is active: the button says so, and a hold does nothing more.
      await act(async () => useTeamStore.getState().refresh());
      expect(screen.getByLabelText('Your SOS is active')).toBeTruthy();
    },
  );

  it('a quick tap whose press-in and press-out land in one tick only hints (QA 2.6.1)', async () => {
    // Both handlers run before React re-renders (a real quick tap on a busy
    // JS thread): the release must still see the hold that just began.
    await render(
      wrap(
        <>
          <SosButton bottom={72} here={HERE} />
          <UndoSnack style={{}} />
        </>,
      ),
    );
    const b = screen.getByTestId('team-sos-button');
    await act(async () => {
      // Inside one outer act, React renders only once both handlers ran.
      const pressIn = fireEvent(b, 'pressIn');
      const pressOut = fireEvent(b, 'pressOut');
      await Promise.all([pressIn, pressOut]);
    });
    expect(screen.getByTestId('team-sos-hint')).toBeTruthy();
    // Laid out inside the dock (a row, left of the button), never absolutely
    // outside its bounds: Android drops such a view from the accessibility
    // tree, so TalkBack and E2E never saw the hint (QA 2.6.1, CI team shard).
    expect(StyleSheet.flatten(screen.getByTestId('team-sos-hint').props.style).position).toBe(
      undefined,
    );
    expect(StyleSheet.flatten(screen.getByTestId('team-sos-layer').props.style)).toMatchObject({
      flexDirection: 'row',
    });
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(usePendingAlert.getState().pending).toBeNull();
    expect(screen.queryByTestId('team-undo-snack')).toBeNull();
    expect(app.active!.soses()).toHaveLength(0);
    // A real hold right after still arms the Undo.
    await press(2100);
    expect(usePendingAlert.getState().pending?.kind).toBe('sos');
    expect(screen.getByTestId('team-undo-snack')).toBeTruthy();
  });

  it('held past 2 s: armed ("Let go"); the full 5 s undo starts when the finger lifts', async () => {
    await render(
      wrap(
        <>
          <SosButton bottom={72} here={HERE} />
          <UndoSnack style={{}} />
        </>,
      ),
    );
    const b = screen.getByTestId('team-sos-button');
    await fireEvent(b, 'pressIn');
    await act(async () => {
      jest.advanceTimersByTime(3500);
    });
    // Still held: armed, but the undo (unreachable under the thumb) waits.
    expect(screen.getByText('Let go')).toBeTruthy();
    expect(usePendingAlert.getState().pending).toBeNull();
    await fireEvent(b, 'pressOut');
    expect(usePendingAlert.getState().pending?.kind).toBe('sos');
    expect(screen.getByText('Sends in 5 s')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(4900);
    });
    expect(app.active!.soses()).toHaveLength(0);
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(app.active!.soses()).toHaveLength(1);
  });

  it('a finger that never lifts still sends: the undo starts 5 s after arming', async () => {
    await render(
      wrap(
        <>
          <SosButton bottom={72} here={HERE} />
          <UndoSnack style={{}} />
        </>,
      ),
    );
    await fireEvent(screen.getByTestId('team-sos-button'), 'pressIn');
    await act(async () => {
      jest.advanceTimersByTime(2000 + 4900);
    });
    expect(usePendingAlert.getState().pending).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(usePendingAlert.getState().pending?.kind).toBe('sos');
  });

  it.each([6950, 7000, 7050])(
    'release racing the armed limit (%i ms held): one countdown, the full 5 s, never early',
    async (held) => {
      await render(sender());
      const starts = countStarts();
      const b = screen.getByTestId('team-sos-button');
      await fireEvent(b, 'pressIn');
      await act(async () => {
        jest.advanceTimersByTime(held);
      });
      await fireEvent(b, 'pressOut');
      const began = usePendingAlert.getState().pending?.clock.startedAt;
      expect(began).toBeDefined();
      await act(async () => {
        jest.advanceTimersByTime(began! + 4990 - Date.now());
      });
      expect(app.active!.soses()).toHaveLength(0);
      expect(screen.getByTestId('team-undo-snack')).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(20);
      });
      expect(app.active!.soses()).toHaveLength(1);
      expect(starts()).toBe(1);
    },
  );

  it('the button hidden while armed: the countdown still runs its full 5 s, once', async () => {
    const view = await render(sender());
    const starts = countStarts();
    await fireEvent(screen.getByTestId('team-sos-button'), 'pressIn');
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    // A card opens over it mid-hold: the SOS goes to its countdown.
    await view.rerender(wrap(<UndoSnack style={{}} />));
    expect(usePendingAlert.getState().pending?.kind).toBe('sos');
    await act(async () => {
      jest.advanceTimersByTime(4990);
    });
    expect(app.active!.soses()).toHaveLength(0);
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    expect(app.active!.soses()).toHaveLength(1);
    expect(starts()).toBe(1);
  });

  // E2E team shard, run 38750352646: an SOS went out after Undo. Every way a
  // hold can end (released while arming, armed, at or past the armed limit),
  // then Undo at the start or the very end of the countdown: nothing is sent,
  // by any path (the armed limit, the countdown, a stale timer), ever.
  it.each(
    [2100, 3000, 6950, 7000, 7050, 9000].flatMap((held) =>
      [0, 2500, 4990].map((undoAt) => [held, undoAt] as const),
    ),
  )('held %i ms, Undo %i ms into the countdown: never sent', async (held, undoAt) => {
    await render(sender());
    const s = app.active!;
    const raise = jest.spyOn(s, 'raiseSos');
    const starts = countStarts();
    const b = screen.getByTestId('team-sos-button');
    await fireEvent(b, 'pressIn');
    await act(async () => {
      jest.advanceTimersByTime(held);
    });
    await fireEvent(b, 'pressOut');
    expect(usePendingAlert.getState().pending?.kind).toBe('sos');
    await act(async () => {
      jest.advanceTimersByTime(undoAt);
    });
    await fireEvent.press(screen.getByTestId('team-undo'));
    expect(usePendingAlert.getState().pending).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(raise).not.toHaveBeenCalled();
    expect(s.soses()).toHaveLength(0);
    expect(starts()).toBe(1);
    expect(screen.queryByTestId('team-undo-snack')).toBeNull();
    raise.mockRestore();
  });

  it('Undo during the countdown sends nothing, ever', async () => {
    await render(
      wrap(
        <>
          <SosButton bottom={72} here={HERE} />
          <UndoSnack style={{}} />
        </>,
      ),
    );
    await press(2100);
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    await fireEvent.press(screen.getByTestId('team-undo'));
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(app.active!.soses()).toHaveLength(0);
    expect(usePendingAlert.getState().pending).toBeNull();
  });

  it('Rally here (in the panel): one tap, 5 s undo, then the "!" and the gather; End in the panel', async () => {
    await act(async () => useTeamStore.getState().refresh());
    useTeamSheet.getState().open({ kind: 'menu' });
    const panel = await render(wrap(<TeamPanel top={0} here={HERE} />));
    await fireEvent.press(screen.getByTestId('team-panel-rally'));
    await panel.unmount();
    await render(
      wrap(
        <>
          <TeamStatusBar top={8} here={HERE} onNavigate={jest.fn()} />
          <UndoSnack style={{}} />
        </>,
      ),
    );
    expect(screen.getByText('Rally point at your position')).toBeTruthy();
    expect(app.active!.rally()).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(app.active!.rally()).toMatchObject({ lat: HERE.latitude, lng: HERE.longitude });
    await act(async () => useTeamStore.getState().refresh());
    expect(screen.getByTestId('team-bar-gather')).toBeTruthy();
    expect(screen.queryByTestId('team-band-gather')).toBeNull();
    // Its creator ends it from the panel, confirmed inline.
    await fireEvent.press(screen.getByTestId('team-bar-pill'));
    await render(wrap(<TeamPanel top={0} here={HERE} />));
    expect(screen.getByText(/^By you · /)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('team-panel-gather-end'));
    await fireEvent.press(screen.getByTestId('team-panel-gather-confirm-yes'));
    expect(app.active!.rally()).toBeNull();
    expect(screen.queryByTestId('team-panel-gather')).toBeNull();
    expect(screen.queryByTestId('team-bar-gather')).toBeNull();
  });

  it('"Resolve for everyone", then an SOS seconds later: it goes out (QA 2.6.1)', async () => {
    const s = app.active!;
    expect(s.raiseSos(HERE.longitude, HERE.latitude)).toBeNull();
    await act(async () => useTeamStore.getState().refresh());
    await render(
      wrap(
        <>
          <AlertBands here={HERE} onNavigate={jest.fn()} />
          <SosButton bottom={72} here={HERE} />
          <UndoSnack style={{}} />
        </>,
      ),
    );
    await holdResolve(2100);
    expect(s.soses().every((x) => x.resolved)).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await press(2100);
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId('team-undo-error')).toBeNull();
    expect(s.soses().filter((x) => !x.resolved)).toHaveLength(1);
    await act(async () => useTeamStore.getState().refresh());
    expect(screen.getByText('Your SOS is active')).toBeTruthy();
    expect(screen.getByLabelText('Your SOS is active')).toBeTruthy();
  });

  it.each(THEMES)(
    'an SOS that fails to send says so, with Retry, and stays until it goes (dark: %s)',
    async (dark) => {
      const s = app.active!;
      const real = s.raiseSos.bind(s);
      const raise = jest.spyOn(s, 'raiseSos').mockReturnValue('not-allowed');
      await render(
        wrap(
          <>
            <SosButton bottom={72} here={HERE} />
            <UndoSnack style={{}} />
          </>,
          dark,
        ),
      );
      await press(2100);
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(raise).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('team-undo-error')).toBeTruthy();
      expect(screen.getByText(/^SOS not sent/)).toBeTruthy();
      // Never dismissed by a timer: a dropped SOS must not vanish unseen.
      await act(async () => {
        jest.advanceTimersByTime(10 * 60_000);
      });
      expect(screen.getByText(/^SOS not sent/)).toBeTruthy();
      // Retry sends at once (the hold and the undo already confirmed it).
      raise.mockImplementation(real);
      await fireEvent.press(screen.getByTestId('team-undo-retry'));
      expect(s.soses().filter((x) => !x.resolved)).toHaveLength(1);
      expect(screen.queryByTestId('team-undo-error')).toBeNull();
      raise.mockRestore();
    },
  );

  it('a send that throws is a failure on screen, never a frozen countdown', async () => {
    const s = app.active!;
    const raise = jest.spyOn(s, 'raiseSos').mockImplementation(() => {
      throw new Error('disk full');
    });
    await render(sender());
    await press(2100);
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(usePendingAlert.getState().pending).toBeNull();
    expect(screen.queryByTestId('team-undo-snack')).toBeNull();
    expect(screen.getByText(/^SOS not sent/)).toBeTruthy();
    // Dismiss is the user's call, never a timer's.
    await fireEvent.press(screen.getByTestId('team-undo-dismiss'));
    expect(screen.queryByTestId('team-undo-error')).toBeNull();
    raise.mockRestore();
  });

  it('with my SOS already active, a hold says so at once (no countdown)', async () => {
    expect(app.active!.raiseSos(HERE.longitude, HERE.latitude)).toBeNull();
    await act(async () => useTeamStore.getState().refresh());
    await render(sender());
    await press(2100);
    expect(usePendingAlert.getState().pending).toBeNull();
    expect(screen.getByText('Your SOS is already active')).toBeTruthy();
  });

  it('no position for an SOS: a failure that stays, never a passing hint', async () => {
    await render(
      wrap(
        <>
          <SosButton bottom={72} here={null} />
          <UndoSnack style={{}} />
        </>,
      ),
    );
    await press(2100);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(usePendingAlert.getState().pending).toBeNull();
    expect(screen.getByText(/^SOS not sent: your position is unknown/)).toBeTruthy();
  });

  it.each(THEMES)(
    'my SOS band: "Sent"; a tap never resolves, a 2 s hold then letting go does (dark: %s)',
    async (dark) => {
      expect(app.active!.raiseSos(HERE.longitude, HERE.latitude)).toBeNull();
      await act(async () => useTeamStore.getState().refresh());
      await render(wrap(<AlertBands here={HERE} onNavigate={jest.fn()} />, dark));
      expect(screen.getByText('Your SOS is active')).toBeTruthy();
      expect(screen.getByText('Sent · just now')).toBeTruthy();
      expect(screen.getByTestId('team-band-sos-resolve-label').props.children).toBe('Resolve');
      // A tap: nothing, and the label says to hold; no inline confirm any more.
      await fireEvent.press(screen.getByTestId('team-band-sos-resolve'));
      await holdResolve(300);
      expect(app.active!.soses()[0]!.resolved).toBe(false);
      expect(screen.queryByText('Resolve for everyone?')).toBeNull();
      expect(screen.getByTestId('team-band-sos-resolve-label').props.children).toBe('Hold 2 s');
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(app.active!.soses()[0]!.resolved).toBe(false);
      expect(screen.getByTestId('team-band-sos-resolve-label').props.children).toBe('Resolve');
      // The hold: a tick a second, "Let go" once armed; nothing until the finger lifts.
      const vibrate = jest.spyOn(Vibration, 'vibrate');
      vibrate.mockClear();
      const b = screen.getByTestId('team-band-sos-resolve');
      await fireEvent(b, 'pressIn');
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId('team-band-sos-resolve-label').props.children).toBe('1 s');
      await act(async () => {
        jest.advanceTimersByTime(1100);
      });
      expect(vibrate).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('team-band-sos-resolve-label').props.children).toBe('Let go');
      expect(screen.getByLabelText('Let go to resolve your SOS for everyone')).toBeTruthy();
      expect(app.active!.soses()[0]!.resolved).toBe(false);
      await fireEvent(b, 'pressOut');
      expect(app.active!.soses()[0]!.resolved).toBe(true);
      expect(screen.queryByTestId('team-band-sos')).toBeNull();
    },
  );

  it('letting go before 2 s cancels: nothing resolves, then or later', async () => {
    expect(app.active!.raiseSos(HERE.longitude, HERE.latitude)).toBeNull();
    await act(async () => useTeamStore.getState().refresh());
    await render(wrap(<AlertBands here={HERE} onNavigate={jest.fn()} />));
    await holdResolve(1900);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(app.active!.soses()[0]!.resolved).toBe(false);
    expect(screen.getByText('Your SOS is active')).toBeTruthy();
    // A quick tap whose press-in and press-out land in one tick does nothing either.
    const b = screen.getByTestId('team-band-sos-resolve');
    await act(async () => {
      const pressIn = fireEvent(b, 'pressIn');
      const pressOut = fireEvent(b, 'pressOut');
      await Promise.all([pressIn, pressOut]);
    });
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(app.active!.soses()[0]!.resolved).toBe(false);
  });

  it('a finger resting past "Let go" still resolves (as raising does), once', async () => {
    expect(app.active!.raiseSos(HERE.longitude, HERE.latitude)).toBeNull();
    await act(async () => useTeamStore.getState().refresh());
    await render(wrap(<AlertBands here={HERE} onNavigate={jest.fn()} />));
    const resolve = jest.spyOn(app.active!, 'resolveSos');
    const b = screen.getByTestId('team-band-sos-resolve');
    await fireEvent(b, 'pressIn');
    await act(async () => {
      jest.advanceTimersByTime(2100 + 4000);
    });
    expect(app.active!.soses()[0]!.resolved).toBe(false);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(app.active!.soses()[0]!.resolved).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    resolve.mockRestore();
  });

  it('screen readers: the "Resolve for everyone" action resolves at once', async () => {
    expect(app.active!.raiseSos(HERE.longitude, HERE.latitude)).toBeNull();
    await act(async () => useTeamStore.getState().refresh());
    await render(wrap(<AlertBands here={HERE} onNavigate={jest.fn()} />));
    const b = screen.getByLabelText('Resolve your SOS. Hold for two seconds');
    expect(b.props.accessibilityActions).toEqual([
      { name: 'longpress', label: 'Resolve for everyone' },
    ]);
    await fireEvent(b, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    expect(app.active!.soses()[0]!.resolved).toBe(false);
    await fireEvent(b, 'accessibilityAction', { nativeEvent: { actionName: 'longpress' } });
    expect(app.active!.soses()[0]!.resolved).toBe(true);
  });
});
