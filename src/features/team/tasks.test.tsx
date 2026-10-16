/**
 * Editing team tasks (#746, mockups 9 and 10): the row ⋮ only where the user
 * may edit, Edit on the New task screen (titled "Edit task", footer Save),
 * Notes and Due on screen, and Delete with the app's 6 s Undo. A real
 * `TeamService` on the loopback mesh where the session matters; a crafted
 * store for the role gates. Both themes. Timers are jest's.
 */
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import type { TeamTask } from '@core/team/tasks';
import { dueLabel } from '@core/teamui/tasks';
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

import { NewTaskScreen } from './NewTaskScreen';
import { TASK_UNDO_MS, TeamTasksScreen } from './TeamTasksScreen';

const mockPush = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, replace: jest.fn(), navigate: jest.fn() }),
  useLocalSearchParams: () => mockParams,
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
  SOS_VIBRATION: [0, 900],
}));
jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const wrap = (children: ReactNode, dark = false) => (
  <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>{children}</PaperProvider>
);
const THEMES = [false, true] as const;

beforeEach(() => {
  mockPush.mockReset();
  mockBack.mockReset();
  mockParams = {};
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({ extensions: { ...d, team: { ...d.team, installedAt: Date.now() } } });
});

describe('who gets the row menu (#746)', () => {
  const member = (id: string, name: string, extra: Partial<TeamView['members'][number]> = {}) =>
    ({
      id,
      name,
      named: true,
      initials: name.slice(0, 2),
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
  const task = (id: string, owner: string, assignee: string, title: string): TeamTask => ({
    id,
    owner,
    title,
    notes: '',
    assignee,
    due: null,
    anchor: null,
    source: null,
    done: false,
    doneBy: null,
    doneAt: null,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    doneBeforeReassignment: false,
  });

  it.each(THEMES)(
    'a member: ⋮ on the tasks they created, none on one given to them (dark: %s)',
    async (dark) => {
      useTeamStore.setState({
        view: {
          teamId: 't',
          name: 'Les Sentiers',
          me: 'me',
          active: true,
          readOnly: false,
          isAdmin: false,
          members: [member('me', 'Marc', { isMe: true }), member('noe', 'Noé Bouchard')],
        } as unknown as TeamView,
        tasks: [
          task('t1', 'noe', 'me', 'Bring the stove to camp'),
          task('t2', 'me', 'noe', 'Check the bridge at km 4'),
        ],
        resolved: new Set(),
        pins: [],
        photos: [],
      });
      await render(wrap(<TeamTasksScreen />, dark));
      expect(screen.getAllByTestId('team-task-row')).toHaveLength(2);
      expect(screen.getAllByTestId('team-task-menu')).toHaveLength(1);
      expect(screen.getByLabelText('Options for “Check the bridge at km 4”')).toBeTruthy();
      expect(screen.queryByLabelText('Options for “Bring the stove to camp”')).toBeNull();
      // The assignee still ticks theirs.
      expect(
        screen.getByLabelText('Bring the stove to camp, open').props.accessibilityState,
      ).toMatchObject({ disabled: false });
    },
  );
});

describe('edit and delete on a real team (#746)', () => {
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
    await app.createTeam({ name: 'Les Sentiers', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
    await act(async () => useTeamStore.getState().refresh());
  });
  afterEach(async () => {
    jest.useRealTimers();
    await app.active?.stopMesh();
  });

  const create = (over: { notes?: string; due?: number | null } = {}) => {
    const s = app.active!;
    expect(
      s.createTask({ title: 'Check the bridge at km 4', assignee: s.me, anchor: null, ...over }),
    ).toBeNull();
    return s.tasks()[0]!;
  };

  it.each(THEMES)('Delete hides the row at once; Undo brings it back (dark: %s)', async (dark) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    create();
    await act(async () => useTeamStore.getState().refresh());
    await render(wrap(<TeamTasksScreen />, dark));
    await fireEvent.press(screen.getByTestId('team-task-menu'));
    await fireEvent.press(screen.getByText('Delete'));
    expect(screen.queryByText('Check the bridge at km 4')).toBeNull();
    expect(screen.getByText('Task deleted')).toBeTruthy();
    // Nothing leaves the phone while Undo is offered.
    expect(app.active!.tasks()).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(TASK_UNDO_MS - 100);
    });
    await fireEvent.press(screen.getByTestId('team-task-undo'));
    expect(screen.getByText('Check the bridge at km 4')).toBeTruthy();
    expect(screen.queryByTestId('team-task-undo-bar')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(app.active!.tasks()).toHaveLength(1);
  });

  it('Delete without Undo: gone for the team after 6 s', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    create();
    await act(async () => useTeamStore.getState().refresh());
    await render(wrap(<TeamTasksScreen />));
    await fireEvent.press(screen.getByTestId('team-task-menu'));
    await fireEvent.press(screen.getByText('Delete'));
    await act(async () => {
      jest.advanceTimersByTime(TASK_UNDO_MS - 1);
    });
    expect(app.active!.tasks()).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(app.active!.tasks()).toHaveLength(0);
    expect(screen.queryByTestId('team-task-undo-bar')).toBeNull();
    expect(screen.queryByText('Check the bridge at km 4')).toBeNull();
  });

  it('leaving the list during the Undo still deletes it (the commit runs on unmount)', async () => {
    create();
    await act(async () => useTeamStore.getState().refresh());
    const r = await render(wrap(<TeamTasksScreen />));
    await fireEvent.press(screen.getByTestId('team-task-menu'));
    await fireEvent.press(screen.getByText('Delete'));
    await r.unmount();
    expect(app.active!.tasks()).toHaveLength(0);
  });

  it('Edit opens the task on the New task screen', async () => {
    const task = create();
    await act(async () => useTeamStore.getState().refresh());
    await render(wrap(<TeamTasksScreen />));
    await fireEvent.press(screen.getByTestId('team-task-menu'));
    await fireEvent.press(screen.getByText('Edit'));
    expect(mockPush).toHaveBeenCalledWith(`/team/task-new?eo=${task.owner}&ei=${task.id}`);
  });

  it.each(THEMES)(
    'Edit task: filled in, Notes and Due on screen; Save writes the change (dark: %s)',
    async (dark) => {
      const due = Date.now() + 2 * 3_600_000;
      const task = create({ notes: 'Rotten plank on the left side', due });
      await act(async () => useTeamStore.getState().refresh());
      mockParams = { eo: task.owner, ei: task.id };
      await render(wrap(<NewTaskScreen />, dark));
      expect(screen.getByText('Edit task')).toBeTruthy();
      expect(screen.getByTestId('team-task-title').props.value).toBe('Check the bridge at km 4');
      expect(screen.getByTestId('team-task-notes').props.value).toBe(
        'Rotten plank on the left side',
      );
      expect(screen.getByText(dueLabel(due, Date.now()))).toBeTruthy();
      expect(screen.getByTestId('team-task-due-kept').props.accessibilityState).toMatchObject({
        selected: true,
      });
      expect(screen.queryByTestId('team-task-create')).toBeNull();
      expect(screen.getByTestId('team-task-cancel')).toBeTruthy();
      await fireEvent.changeText(screen.getByTestId('team-task-title'), 'Fix the bridge at km 4');
      await fireEvent.changeText(screen.getByTestId('team-task-notes'), 'Bring the saw.');
      await fireEvent.press(screen.getByTestId('team-task-due-none'));
      await fireEvent.press(screen.getByTestId('team-task-save'));
      expect(app.active!.tasks()[0]).toMatchObject({
        title: 'Fix the bridge at km 4',
        notes: 'Bring the saw.',
        due: null,
      });
      expect(mockBack).toHaveBeenCalled();
    },
  );

  it('New task: notes and "In 1 h" go out with it; "Pick…" steps the day and the time', async () => {
    const s = app.active!;
    await render(wrap(<NewTaskScreen />));
    expect(screen.getByText('New task')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('team-task-title'), 'Flag the detour');
    await fireEvent.changeText(screen.getByTestId('team-task-notes'), 'Ribbons in the bag');
    await fireEvent.press(screen.getByTestId('team-task-for-me'));
    await fireEvent.press(screen.getByTestId('team-task-place-none'));
    // Pick…: the next full hour after an hour from now, then a day and 15 min later.
    await fireEvent.press(screen.getByTestId('team-task-due-pick'));
    expect(screen.getByTestId('team-task-due-picker')).toBeTruthy();
    const start = Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000;
    await fireEvent.press(screen.getByTestId('team-task-due-day-forward'));
    await fireEvent.press(screen.getByTestId('team-task-due-time-forward'));
    const tomorrow = new Date(start);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const picked = tomorrow.getTime() + 15 * 60_000;
    expect(screen.getByTestId('team-task-due-time').props.children).toBe(
      dueLabel(picked, Date.now()).split(' ').pop(),
    );
    await fireEvent.press(screen.getByTestId('team-task-due-hour'));
    expect(screen.queryByTestId('team-task-due-picker')).toBeNull();
    await fireEvent.press(screen.getByTestId('team-task-create'));
    const made = s.tasks()[0]!;
    expect(made).toMatchObject({ title: 'Flag the detour', notes: 'Ribbons in the bag' });
    expect(Math.abs(made.due! - (Date.now() + 3_600_000))).toBeLessThan(61_000);
  });

  it('a task I may not edit (or one gone): the edit screen offers nothing', async () => {
    mockParams = { eo: 'someone', ei: 'gone' };
    await render(wrap(<NewTaskScreen />));
    expect(screen.getByText('Edit task')).toBeTruthy();
    expect(screen.queryByTestId('team-task-title')).toBeNull();
    expect(screen.queryByTestId('team-task-save')).toBeNull();
  });
});
