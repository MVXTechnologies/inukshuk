/**
 * Team notes on screen (#706): the composer, the note card (a teammate's,
 * an admin's view, my own with its ⋮ menu and the Fades after sub-panel),
 * the note list, the panel's Notes row and the arrival snackbar, in both
 * themes. A crafted store for the views; a real TeamService on the loopback
 * hub for what writes. Jest's own clock: no real sleeps.
 */
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { METRIC } from '@core/format';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import type { PinNote, TeamPin } from '@core/teamui/pins';
import type { NotePin } from '@core/teamui/notes';
import { lifetimeMs } from '@core/teamui/lifetime';
import type { TeamView } from '@core/teamui/view';
import { resetAppTeamServiceForTests } from '@data/team/appTeam';
import { LoopbackMeshHub } from '@data/team/loopbackMesh';
import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { TeamPanel } from '../bar/TeamPanel';
import { useTeamMapSelection } from '../map/TeamMapOverlay';
import { TeamPinComposer, usePinDraft } from '../map/TeamPinComposer';
import { useTeamPick } from '../map/TeamPick';
import { useTeamSheet } from '../map/teamMode';
import { hitTestNotes, NoteCallouts, resetNoteHitsForTests } from './NoteCallouts';
import { NoteCard } from './NoteCard';
import { NoteSnack } from './NoteSnack';
import { NotesScreen } from './NotesScreen';

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: jest.fn(), back: mockBack, replace: jest.fn() }),
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
  notifyTeam: async () => undefined,
  onTeamNotificationTap: () => () => undefined,
  dismissTeamNotification: async () => undefined,
  setInAppAlarm: () => undefined,
  SOS_VIBRATION: [0, 900, 250, 900],
}));
jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));
jest.mock('expo-location', () => ({ getLastKnownPositionAsync: async () => null }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@maplibre/maplibre-react-native', () => {
  const { View } = jest.requireActual('react-native');
  return {
    Marker: ({ children, id }: { children: ReactNode; id: string }) => (
      <View testID={`marker-${id}`}>{children}</View>
    ),
  };
});

const HERE = { latitude: 46.8, longitude: -71.2 };
const THEMES = [false, true] as const;
const wrap = (children: ReactNode, dark = false) => (
  <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>{children}</PaperProvider>
);
const T = Date.UTC(2026, 9, 15, 15);
const HOUR = 3600_000;

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

const NOTE: PinNote = {
  text: 'Hut water is dry. Fill up at the lake.',
  color: 1,
  expiresAt: T + 4 * HOUR,
  fadeFrom: T,
  newsAt: T,
  edited: false,
};

function notePin(id: string, owner: string, over: Partial<PinNote> = {}, at = T): NotePin {
  return {
    id,
    owner,
    lng: -71.19,
    lat: 46.81,
    messages: [{ id, author: owner, text: 'x', at, mentions: [] }],
    lastAt: at,
    note: { ...NOTE, ...over },
  };
}

function view(over: Partial<TeamView> = {}): TeamView {
  return {
    teamId: 't',
    name: 'Chic-Chocs crew',
    me: 'me',
    active: true,
    readOnly: false,
    isAdmin: false,
    expiresAt: T + 9 * 24 * HOUR,
    members: [
      member('me', 'Marc Vigneault', { isMe: true, role: 'owner' }),
      member('julie', 'Julie Tremblay'),
      member('noe', 'Noé Gagnon'),
    ],
    ...over,
  } as unknown as TeamView;
}

function crafted(pins: TeamPin[], seen: Record<string, number> = {}, v: TeamView = view()) {
  useTeamStore.setState({
    view: v,
    pins,
    record: { seen } as never,
    positions: [],
    peers: [],
    statuses: new Map(),
    tasks: [],
    soses: [],
    rally: null,
    meshRunning: true,
    meshWanted: true,
    unread: 0,
    threadsUnread: 0,
    dataVersion: String(T),
  });
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  jest.setSystemTime(T + 12 * 60_000);
  mockPush.mockReset();
  mockBack.mockReset();
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    extensions: { ...d, team: { ...d.team, installedAt: T } },
    units: METRIC,
  });
  resetAppTeamServiceForTests(null);
  resetNoteHitsForTests();
  useTeamMapSelection.getState().select(null);
  useTeamSheet.getState().close();
  usePinDraft.getState().close();
  useTeamPick.getState().cancel();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a teammate’s note: its card', () => {
  it.each(THEMES)('text, distance, Fades in and Seen by; no ⋮ (dark: %s)', async (dark) => {
    const p = notePin('j1', 'julie');
    crafted([p]);
    await render(
      wrap(
        <NoteCard pin={p} view={view()} here={HERE} onNavigate={jest.fn()} onClose={jest.fn()} />,
        dark,
      ),
    );
    expect(screen.getByText('Julie Tremblay')).toBeTruthy();
    expect(screen.getByText('Note · 12 min ago')).toBeTruthy();
    expect(screen.getByTestId('note-text').props.children).toBe(NOTE.text);
    expect(screen.getByLabelText(/^Distance: /)).toBeTruthy();
    expect(screen.getByLabelText('Fades in: 3 h 48')).toBeTruthy();
    expect(screen.getByLabelText('Seen by: —')).toBeTruthy();
    expect(screen.queryByTestId('note-more')).toBeNull();
  });

  it('Navigate goes there; an admin gets ⋮ with Delete only', async () => {
    const p = notePin('j1', 'julie');
    crafted([p]);
    const nav = jest.fn();
    const close = jest.fn();
    await render(
      wrap(
        <NoteCard
          pin={p}
          view={view({ isAdmin: true })}
          here={HERE}
          onNavigate={nav}
          onClose={close}
        />,
      ),
    );
    await fireEvent.press(screen.getByTestId('note-more'));
    expect(screen.getByTestId('note-menu-delete')).toBeTruthy();
    expect(screen.queryByTestId('note-menu-edit')).toBeNull();
    expect(screen.queryByTestId('note-menu-fade')).toBeNull();
    expect(screen.queryByTestId('note-menu-move')).toBeNull();
    await fireEvent.press(screen.getByTestId('note-navigate'));
    expect(nav).toHaveBeenCalledWith(p.lat, p.lng);
    expect(close).toHaveBeenCalled();
  });

  it('shows the newest reply', async () => {
    const p: NotePin = {
      ...notePin('j1', 'julie'),
      messages: [
        { id: 'j1', author: 'julie', text: 'x', at: T, mentions: [] },
        {
          id: 'r1',
          author: 'noe',
          text: 'Thanks, we’ll fill up at the lake.',
          at: T + 6 * 60_000,
          mentions: [],
        },
      ],
    };
    crafted([p]);
    await render(
      wrap(
        <NoteCard pin={p} view={view()} here={null} onNavigate={jest.fn()} onClose={jest.fn()} />,
      ),
    );
    expect(screen.getByTestId('note-latest-reply')).toBeTruthy();
    expect(screen.getByText('Noé · 6 min')).toBeTruthy();
  });
});

describe('notes on the map', () => {
  it.each(THEMES)(
    'a callout per note, unread dot until opened; tiles below 1:50 000 (dark: %s)',
    async (dark) => {
      const a = notePin('j1', 'julie');
      const b = { ...notePin('n1', 'noe', { newsAt: T - HOUR }), lng: -71.3 };
      crafted([a, b], { 'pin:noe:n1': T });
      const r = await render(wrap(<NoteCallouts zoom={15} />, dark));
      expect(screen.getAllByTestId('note-callout')).toHaveLength(2);
      expect(screen.getAllByTestId('note-callout-unread')).toHaveLength(1);
      expect(screen.getByLabelText(`Note, Julie · 12 min: ${NOTE.text}`)).toBeTruthy();
      await r.rerender(wrap(<NoteCallouts zoom={11} />, dark));
      expect(screen.queryAllByTestId('note-callout')).toHaveLength(0);
      expect(screen.getAllByTestId('note-tile')).toHaveLength(2);
    },
  );

  it('the composer’s preview shows dashed where the note lands', async () => {
    crafted([]);
    usePinDraft.getState().open(-71.2, 46.8);
    usePinDraft.getState().set({ text: 'Camp here' });
    await render(wrap(<NoteCallouts zoom={15} />));
    expect(screen.getByLabelText('Note, You · preview: Camp here')).toBeTruthy();
  });

  it('a tap is hit-tested against the measured callouts', async () => {
    const a = notePin('j1', 'julie');
    crafted([a]);
    await render(wrap(<NoteCallouts zoom={15} />));
    await fireEvent(screen.getByTestId('note-callout'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 160, height: 70 } },
    });
    const map = { project: async () => [200, 400] as [number, number] };
    // The callout hangs above its spot: inside it, and beside it.
    expect(await hitTestNotes(map, 210, 370)).toEqual({ kind: 'note', owner: 'julie', id: 'j1' });
    expect(await hitTestNotes(map, 400, 370)).toBeNull();
    expect(await hitTestNotes(map, 210, 470)).toBeNull();
  });
});

describe('the note list', () => {
  it.each(THEMES)(
    'New, Earlier and a collapsed Faded group; Mine filters (dark: %s)',
    async (dark) => {
      crafted(
        [
          notePin('j1', 'julie'),
          notePin('n1', 'noe', { newsAt: T - HOUR }),
          notePin('m1', 'me', { text: 'Camp here tonight' }),
          notePin('old', 'julie', { text: 'Moose on the trail', expiresAt: T - HOUR }),
        ],
        { 'pin:noe:n1': T },
      );
      await render(wrap(<NotesScreen />, dark));
      expect(screen.getByText('NEW')).toBeTruthy();
      expect(screen.getByText('EARLIER')).toBeTruthy();
      expect(screen.queryByText('Moose on the trail')).toBeNull();
      await fireEvent.press(screen.getByTestId('notes-faded'));
      expect(screen.getByText('Moose on the trail')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('notes-filter-mine'));
      expect(screen.getAllByTestId('note-row')).toHaveLength(1);
      // A row opens the note's card on the map.
      await fireEvent.press(screen.getByTestId('note-row'));
      expect(useTeamMapSelection.getState().hit).toEqual({ kind: 'pin', owner: 'me', id: 'm1' });
      expect(mockBack).toHaveBeenCalled();
    },
  );

  it('the panel’s Notes row says how many are new', async () => {
    crafted([notePin('j1', 'julie'), notePin('n1', 'noe')]);
    await render(wrap(<TeamPanel top={0} here={HERE} />));
    expect(screen.getByLabelText('Notes, 2 new')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('team-panel-notes'));
    expect(mockPush).toHaveBeenCalledWith('/team/notes');
  });
});

describe('a note arriving', () => {
  it('announces a teammate’s new note once, with VIEW; not the ones already there', async () => {
    crafted([notePin('j1', 'julie')]);
    await render(wrap(<NoteSnack here={HERE} />));
    expect(screen.queryByTestId('note-snack')).toBeNull();
    await act(async () =>
      useTeamStore.setState((s) => ({
        pins: [...s.pins, notePin('n2', 'noe', { text: 'Bridge out' })],
      })),
    );
    expect(screen.getByText(/^Noé left a note · /)).toBeTruthy();
    expect(screen.getByText('“Bridge out”')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('note-snack-view'));
    expect(useTeamMapSelection.getState().hit).toEqual({ kind: 'pin', owner: 'noe', id: 'n2' });
    expect(screen.queryByTestId('note-snack')).toBeNull();
  });
});

describe('composing and owning a note (a real team)', () => {
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
    await act(async () => useTeamStore.getState().refresh());
  });
  afterEach(async () => {
    await app.active?.stopMesh();
    resetAppTeamServiceForTests(null);
  });

  it.each(THEMES)('counts, picks a fade, posts; my card has its ⋮ (dark: %s)', async (dark) => {
    usePinDraft.getState().open(-71.2, 46.81);
    const onPinned = jest.fn();
    await render(wrap(<TeamPinComposer here={HERE} onPinned={onPinned} />, dark));
    expect(screen.getByText('New note')).toBeTruthy();
    expect(screen.getByText(/^Pinned where you tapped · /)).toBeTruthy();
    expect(screen.getByTestId('note-count').props.children).toBe('0 / 140');
    expect(screen.getByTestId('team-pin-send').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.changeText(screen.getByTestId('team-pin-input'), 'Camp here tonight');
    expect(screen.getByTestId('note-count').props.children).toBe('17 / 140');
    await fireEvent.press(screen.getByTestId('note-fade-1d'));
    await fireEvent.press(screen.getByTestId('note-alert'));
    expect(screen.getByText('Post to Ridge crew')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('team-pin-send'));
    await act(async () => useTeamStore.getState().refresh());
    const pins = useTeamStore.getState().pins;
    expect(pins).toHaveLength(1);
    const posted = pins[0]!;
    expect(posted.note).toMatchObject({ text: 'Camp here tonight' });
    expect(posted.note!.expiresAt - posted.note!.fadeFrom).toBeGreaterThan(23 * HOUR);
    expect(onPinned).toHaveBeenCalledWith(app.active!.me, posted.id);
    expect(usePinDraft.getState().at).toBeNull();
  });

  it('⋮: Fades after counts again from now; Edit text; Move picks a place', async () => {
    const s = app.active!;
    expect(
      s.postNote(-71.2, 46.81, 'Lunch spot', { col: 2, fade: '4h', alert: false }, 'mine1'),
    ).toBeNull();
    await act(async () => useTeamStore.getState().refresh());
    const pin = () => useTeamStore.getState().pins[0] as NotePin;
    const card = () =>
      wrap(
        <NoteCard
          pin={pin()}
          view={useTeamStore.getState().view!}
          here={HERE}
          onNavigate={jest.fn()}
          onClose={jest.fn()}
        />,
      );
    const r = await render(card());
    expect(screen.getByText('Your note')).toBeTruthy();
    expect(screen.getByLabelText('Replies: 0')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('note-more'));
    await fireEvent.press(screen.getByTestId('note-menu-fade'));
    expect(screen.getByTestId('note-fade-menu')).toBeTruthy();
    expect(screen.getByText('4 h left')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('note-fade-1h'));
    await act(async () => useTeamStore.getState().refresh());
    expect(pin().note.expiresAt - Date.now()).toBeLessThanOrEqual(HOUR);
    await r.rerender(card());
    await fireEvent.press(screen.getByTestId('note-more'));
    await fireEvent.press(screen.getByTestId('note-menu-edit'));
    await fireEvent.changeText(
      screen.getByTestId('note-edit-input'),
      `Lunch spot${String.fromCodePoint(0x202e)} moved`,
    );
    await fireEvent.press(screen.getByTestId('note-edit-save'));
    await act(async () => useTeamStore.getState().refresh());
    expect(pin().note.text).toBe('Lunch spot moved');
    await r.rerender(card());
    await fireEvent.press(screen.getByTestId('note-more'));
    await fireEvent.press(screen.getByTestId('note-menu-move'));
    expect(useTeamPick.getState()).toMatchObject({ purpose: 'note-move', note: 'mine1' });
  });
});
