import type { TeamTask } from '@core/team/tasks';

import { distanceToLine, unseenCount } from './pins';
import {
  anchorInfo,
  dueLabel,
  DUE_STEP_MIN,
  filterCounts,
  filterTasks,
  groupTasks,
  hasTaskCommand,
  inOneHour,
  parseTaskCommand,
  pickStart,
  shiftDue,
  tasksFromSource,
} from './tasks';
import type { MemberRow } from './view';

const member = (id: string, name: string, extra: Partial<MemberRow> = {}): MemberRow => ({
  id,
  name,
  named: true,
  initials: '',
  color: '',
  role: 'member',
  active: true,
  isMe: false,
  groups: [],
  joinedAt: 0,
  via: 'admit',
  left: false,
  lastSeenAt: null,
  actions: { promote: null, demote: null, remove: false, setGroup: false },
  ...extra,
});

const members = [
  member('alex', 'Alex (Guide)'),
  member('al', 'Al'),
  member('julie', 'Julie Tremblay'),
  member('gus', 'Gus', { role: 'guest' }),
  member('old', 'Luc', { active: false }),
  member('me', 'Marc-André', { isMe: true }),
];

const task = (extra: Partial<TeamTask>): TeamTask => ({
  id: 't',
  owner: 'me',
  title: 'x',
  notes: '',
  assignee: 'alex',
  due: null,
  anchor: null,
  source: null,
  done: false,
  doneBy: null,
  doneAt: null,
  createdAt: 0,
  updatedAt: 0,
  doneBeforeReassignment: false,
  ...extra,
});

describe('+task command', () => {
  it('finds the assignee (longest name, me too) and the title', () => {
    expect(parseTaskCommand('+task @Alex (Guide) flag the detour', members)).toEqual({
      ok: true,
      assignee: 'alex',
      title: 'flag the detour',
      span: [0, 19],
    });
    expect(parseTaskCommand('Thanks! +TASK @al: count the markers', members)).toEqual({
      ok: true,
      assignee: 'al',
      title: 'count the markers',
      span: [8, 17],
    });
    expect(parseTaskCommand('+task @me photograph the erosion', members)).toMatchObject({
      ok: true,
      assignee: 'me',
      title: 'photograph the erosion',
    });
    expect(parseTaskCommand('+task @Marc-André bring rope', members)).toMatchObject({
      assignee: 'me',
      title: 'bring rope',
    });
  });

  it('takes a first name when only one member has it', () => {
    expect(parseTaskCommand('+task @julie bring the rope', members)).toEqual({
      ok: true,
      assignee: 'julie',
      title: 'bring the rope',
      span: [0, 12],
    });
    const twins = [...members, member('j2', 'Julie Roy')];
    expect(parseTaskCommand('+task @Julie bring the rope', twins)).toEqual({
      ok: false,
      reason: 'no-assignee',
    });
  });

  it('explains what is missing', () => {
    expect(parseTaskCommand('nice view', members)).toBeNull();
    expect(parseTaskCommand('email me+task@x.org', members)).toBeNull();
    expect(parseTaskCommand('+task flag it', members)).toEqual({
      ok: false,
      reason: 'no-assignee',
    });
    expect(parseTaskCommand('+task @Nobody flag it', members)).toEqual({
      ok: false,
      reason: 'no-assignee',
    });
    expect(parseTaskCommand('+task @Luc flag it', members)).toEqual({
      ok: false,
      reason: 'no-assignee',
    });
    expect(parseTaskCommand('+task @Gus flag it', members)).toEqual({ ok: false, reason: 'guest' });
    expect(parseTaskCommand('+task @Julie Tremblay  ', members)).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(parseTaskCommand(`+task @Al ${'x'.repeat(501)}`, members)).toEqual({
      ok: false,
      reason: 'too-long',
    });
    expect(hasTaskCommand('ok +task')).toBe(true);
    expect(hasTaskCommand('a+task')).toBe(false);
  });
});

describe('task list', () => {
  const tasks = [
    task({ id: 'a', assignee: 'alex', createdAt: 3 }),
    task({ id: 'b', assignee: 'alex', due: 10, createdAt: 1 }),
    task({ id: 'c', assignee: 'me', createdAt: 2 }),
    task({ id: 'd', assignee: 'julie', done: true, createdAt: 4 }),
    task({ id: 'e', assignee: 'alex', done: true, createdAt: 5 }),
    task({ id: 'f', assignee: 'me', done: true, createdAt: 6, source: { owner: 'me', id: 'c1' } }),
  ];

  it('filters and counts', () => {
    expect(filterCounts(tasks, 'me')).toEqual({ mine: 1, all: 6, open: 3, done: 3 });
    expect(filterTasks(tasks, 'mine', 'me').map((t) => t.id)).toEqual(['c']);
    expect(filterTasks(tasks, 'done', 'me').map((t) => t.id)).toEqual(['d', 'e', 'f']);
    expect(tasksFromSource(tasks, 'me', 'c1').map((t) => t.id)).toEqual(['f']);
  });

  it('groups by person, me first; open before done, due first, newest first', () => {
    const names: Record<string, string> = { alex: 'Alex', julie: 'Julie', me: 'Me' };
    const groups = groupTasks(tasks, 'me', (id) => names[id] ?? id);
    expect(groups.map((g) => [g.assignee, g.tasks.map((t) => t.id)])).toEqual([
      ['me', ['c', 'f']],
      ['alex', ['b', 'a', 'e']],
      ['julie', ['d']],
    ]);
  });
});

describe('pins helpers', () => {
  it('measures distance to a trail in metres', () => {
    const line: [number, number][] = [
      [-70.93, 47.08],
      [-70.92, 47.08],
    ];
    expect(distanceToLine(-70.925, 47.08, line)).toBeLessThan(1);
    // 0.001° of latitude ≈ 111 m.
    expect(distanceToLine(-70.925, 47.081, line)).toBeCloseTo(111, -1);
    expect(distanceToLine(-70.94, 47.08, line)).toBeGreaterThan(700);
    expect(distanceToLine(0, 0, [])).toBe(Infinity);
    expect(distanceToLine(-70.925, 47.08, [[-70.925, 47.08]])).toBe(0);
  });

  it('counts what is new for me', () => {
    const msgs = [
      { author: 'me', at: 5 },
      { author: 'alex', at: 5 },
      { author: 'alex', at: 9 },
    ];
    expect(unseenCount(msgs, 'me', 4)).toBe(2);
    expect(unseenCount(msgs, 'me', 5)).toBe(1);
    expect(unseenCount(msgs, 'me', 9)).toBe(0);
  });
});

describe('anchorInfo', () => {
  const look = {
    photo: (o: string, id: string) =>
      o === 'me' && id === 'p' ? { lng: 1, lat: 2, caption: 'Summit: the river' } : undefined,
    pin: (o: string, id: string) =>
      o === 'alex' && id === 'q' ? { lng: 3, lat: 4, text: 'x'.repeat(60) } : undefined,
    trail: (_o: string, id: string) =>
      id === 't' ? { name: 'Mont-Sainte-Anne', start: [5, 6] as [number, number] } : undefined,
  };
  it('labels and locates every kind of anchor', () => {
    expect(anchorInfo(null, look)).toEqual({ label: 'No place', at: null });
    expect(anchorInfo({ kind: 'point', lat: 47, lng: -70 }, look)).toEqual({
      label: 'A place on the map',
      at: [-70, 47],
    });
    expect(anchorInfo({ kind: 'photo', owner: 'me', id: 'p' }, look)).toEqual({
      label: 'Photo · Summit: the river',
      at: [1, 2],
    });
    expect(anchorInfo({ kind: 'photo', owner: 'x', id: 'p' }, look).at).toBeNull();
    const pin = anchorInfo({ kind: 'pin', owner: 'alex', id: 'q' }, look);
    expect(pin.label.length).toBeLessThanOrEqual('Pin · '.length + 40);
    expect(pin.at).toEqual([3, 4]);
    expect(anchorInfo({ kind: 'pin', owner: 'me', id: 'q' }, look).label).toBe('A removed pin');
    expect(anchorInfo({ kind: 'trail', owner: 'me', id: 't' }, look)).toEqual({
      label: 'Trail · Mont-Sainte-Anne',
      at: [5, 6],
    });
    expect(anchorInfo({ kind: 'trail', owner: 'me', id: 'z' }, look).at).toBeNull();
  });
});

describe('due times on screen (#746)', () => {
  // Local wall times: the labels are the phone's own clock, in any zone.
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
  const now = at(16, 9, 41); // Fri Oct 16, 09:41

  it('today, tomorrow, yesterday, this week, then the date', () => {
    expect(dueLabel(at(16, 16), now)).toBe('Today 16:00');
    expect(dueLabel(at(16, 0, 5), now)).toBe('Today 00:05');
    expect(dueLabel(at(17, 8, 30), now)).toBe('Tomorrow 08:30');
    expect(dueLabel(at(15, 18), now)).toBe('Yesterday 18:00');
    expect(dueLabel(at(18, 9), now)).toBe('Sun 09:00');
    expect(dueLabel(at(22, 9), now)).toBe('Thu 09:00');
    expect(dueLabel(at(23, 9), now)).toBe('Oct 23 09:00');
    expect(dueLabel(at(10, 9), now)).toBe('Oct 10 09:00');
    expect(dueLabel(new Date(2027, 0, 2, 7, 0).getTime(), now)).toBe('Jan 2 07:00');
  });

  it('"In 1 h" to the minute; "Pick…" starts at the set time or the next full hour', () => {
    expect(inOneHour(now + 40_000)).toBe(at(16, 10, 42));
    expect(pickStart(null, now)).toBe(at(16, 11));
    expect(pickStart(at(17, 8), now)).toBe(at(17, 8));
  });

  it('steps by days (same clock time) and by 15 min, never into the past', () => {
    expect(shiftDue(at(16, 16), { days: 1 }, now)).toBe(at(17, 16));
    expect(shiftDue(at(16, 16), { minutes: DUE_STEP_MIN }, now)).toBe(at(16, 16, 15));
    expect(shiftDue(at(16, 16), { minutes: -DUE_STEP_MIN }, now)).toBe(at(16, 15, 45));
    // Snaps an odd minute onto the grid.
    expect(shiftDue(at(16, 10, 42), { minutes: DUE_STEP_MIN }, now)).toBe(at(16, 11));
    expect(shiftDue(at(16, 16), { days: -1 }, now)).toBe(at(16, 16));
    expect(shiftDue(at(16, 9, 50), { minutes: -DUE_STEP_MIN }, now)).toBe(at(16, 9, 50));
  });
});
