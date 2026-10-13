import type { TeamTask } from '@core/team/tasks';

import type { TeamPhoto } from './comments';
import { MAX_TASK_MARKS, teamMapMarks, type MarksInput } from './mapMarks';
import type { TeamPin } from './pins';

const photo = (id: string, owner = 'me'): TeamPhoto => ({
  id,
  owner,
  trackId: 'tr',
  lng: -70.93,
  lat: 47.08,
  takenAt: 0,
  caption: id === 'p5' ? 'Summit' : null,
  thumbUri: null,
  width: 0,
  height: 0,
});

const task = (id: string, extra: Partial<TeamTask> = {}): TeamTask => ({
  id,
  owner: 'me',
  title: 'Flag the detour with ribbons',
  assignee: 'alex',
  due: null,
  anchor: { kind: 'photo', owner: 'me', id: 'p5' },
  source: null,
  done: false,
  doneBy: null,
  doneAt: null,
  createdAt: 0,
  updatedAt: 0,
  doneBeforeReassignment: false,
  ...extra,
});

const pin: TeamPin = {
  id: 'q',
  owner: 'alex',
  lng: -70.926,
  lat: 47.09,
  messages: [
    { id: 'q', author: 'alex', text: 'Old trail closed', at: 10, mentions: [] },
    { id: 'r', author: 'me', text: 'Thanks', at: 20, mentions: [] },
  ],
  lastAt: 20,
};

function input(extra: Partial<MarksInput> = {}): MarksInput {
  return {
    photos: [photo('p3'), photo('p5')],
    threads: new Map([
      [
        'p5',
        [
          { author: 'alex', at: 50 },
          { author: 'julie', at: 60 },
        ],
      ],
      ['p3', [{ author: 'alex', at: 5 }]],
    ]),
    pins: [pin],
    tasks: [task('t1')],
    me: 'me',
    seenAt: (th) => (th === 'photo:p3' ? 10 : 0),
    look: {
      photo: (o, id) => (id === 'p5' ? { lng: -70.93, lat: 47.08, caption: 'Summit' } : undefined),
      pin: () => ({ lng: -70.926, lat: 47.09, text: 'x' }),
      trail: () => undefined,
    },
    nameOf: (id) => (id === 'alex' ? 'Alex (Guide)' : id),
    ...extra,
  };
}

describe('teamMapMarks', () => {
  it('bubbles count what is new, else everything; new ones first', () => {
    const { bubbles } = teamMapMarks(input());
    expect(bubbles.map((b) => [b.photo.id, b.count, b.fresh])).toEqual([
      ['p5', 2, true],
      ['p3', 1, false],
    ]);
  });

  it('pins count replies not by me since I looked', () => {
    expect(teamMapMarks(input()).pins).toEqual([
      expect.objectContaining({ owner: 'alex', id: 'q', count: 1, fresh: true }),
    ]);
    const seen = teamMapMarks(input({ seenAt: () => 100 })).pins[0]!;
    expect([seen.count, seen.fresh]).toEqual([2, false]);
  });

  it('open anchored tasks hang under their anchor, stacked; done and placeless ones do not', () => {
    const { tasks } = teamMapMarks(
      input({
        tasks: [
          task('a'),
          task('b', { assignee: 'me', title: 'Photograph the erosion' }),
          task('c', { done: true }),
          task('d', { anchor: null }),
          task('e', { anchor: { kind: 'trail', owner: 'me', id: 'tr' } }),
          task('f', { anchor: { kind: 'pin', owner: 'alex', id: 'q' } }),
          task('g', { anchor: { kind: 'photo', owner: 'me', id: 'gone' } }),
        ],
      }),
    );
    expect(tasks.map((x) => [x.task.id, x.under, x.stack, x.label])).toEqual([
      ['b', 'photo', 0, 'Photograph the erosion · you'],
      ['a', 'photo', 1, 'Flag the detour with… · Alex'],
      ['f', 'pin', 0, 'Flag the detour with… · Alex'],
    ]);
    const many = teamMapMarks(
      input({ tasks: Array.from({ length: 30 }, (_, i) => task(`t${i}`)) }),
    ).tasks;
    expect(many).toHaveLength(MAX_TASK_MARKS);
  });
});
