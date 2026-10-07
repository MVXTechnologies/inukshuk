import type { TeamTask } from '@core/team/tasks';

import { distanceToLine, unseenCount } from './pins';
import {
  anchorInfo,
  filterCounts,
  filterTasks,
  groupTasks,
  hasTaskCommand,
  parseTaskCommand,
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
