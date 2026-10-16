/**
 * Task notes and edits with 2.6.x phones in the team (#746).
 *
 * A 2.6.x phone is simulated by running the REAL fold with the task
 * validator 2.6.2 shipped: no `notes` field and no `ak: null` (its
 * `validField` returned false for any field it did not know, and accepted
 * only an anchor kind for `ak`). Everything else is the current code, as in
 * `teamdraw/compat.test.ts`.
 *
 * What must hold: the 2.6.x phone stores and relays every op (chains stay
 * whole), shows the task with its title and every edit it can read, and
 * skips only the notes and "no place" writes, as `invalid` (never
 * `forbidden`, which would read as an attack).
 */
import type { Json } from './canonical';
import { TeamReplica } from './replica';
import {
  entityToTask,
  taskEditWrites,
  taskFields,
  taskNotesFields,
  teamTasks,
  type TeamTask,
} from './tasks';
import { entityKey } from './data';
import {
  addMember,
  allEnvs,
  c,
  device,
  exchange,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from './testing/fixtures';

interface Old {
  TeamReplica: typeof import('./replica').TeamReplica;
  teamTasks: typeof teamTasks;
}

/** The real modules, with the task validator of 2.6.2. */
function oldVersion(): Old {
  let out: Old | undefined;
  jest.isolateModules(() => {
    jest.doMock('@core/team/tasks', () => {
      const actual = jest.requireActual<typeof import('./tasks')>('@core/team/tasks');
      return {
        ...actual,
        validTaskFields: (f: Record<string, Json>, author: string) =>
          !Object.prototype.hasOwnProperty.call(f, 'notes') &&
          f['ak'] !== null &&
          actual.validTaskFields(f, author),
      };
    });
    /* eslint-disable @typescript-eslint/no-require-imports */
    out = {
      TeamReplica: (require('@core/team/replica') as typeof import('./replica')).TeamReplica,
      teamTasks: (require('@core/team/tasks') as typeof import('./tasks')).teamTasks,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return out!;
}

/** Owner (admin), Bob (creator, 2.6.3), Eve (assignee, still on 2.6.x), Dan (2.6.3, joins late). */
function crew() {
  const w = newWorld();
  const bob = device();
  const eve = device();
  const dan = device();
  addMember(w.root, bob, 'member', T0 + 1);
  addMember(w.root, eve, 'member', T0 + 2);
  addMember(w.root, dan, 'member', T0 + 3);
  const rb = joinReplica(w, bob, w.root, T0 + 5);
  return { w, bob, eve, dan, rb };
}

describe('task notes and edits with 2.6.x phones (#746)', () => {
  const old = oldVersion();

  it('the 2.6.x validator really refuses the new writes (the simulation bites)', () => {
    const { w, eve, rb } = crew();
    rb.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: { ...taskFields({ title: 'Check the bridge', assignee: eve.id }), notes: 'Saw' },
    });
    const oldEve = new old.TeamReplica(c, w.teamId, eve.keys);
    oldEve.ingest(allEnvs(w.root, T0 + 2 * MIN), T0 + 2 * MIN);
    oldEve.ingest(allEnvs(rb, T0 + 2 * MIN), T0 + 2 * MIN);
    // One write holding both: the old phone would lose the whole task. Hence two writes.
    expect(old.teamTasks(oldEve.data(T0 + 2 * MIN))).toEqual([]);
    expect(teamTasks(rb.data(T0 + 2 * MIN))).toHaveLength(1);
  });

  it('create with notes, edit, clear the place: the 2.6.x phone shows the task and relays it all', () => {
    const { w, bob, eve, dan, rb } = crew();
    let now = T0 + MIN;
    const step = () => (now += 1000);
    // Create: the fields every version reads, then the notes in their own write.
    rb.write(step(), 'e.set', {
      k: 'task',
      id: 't1',
      f: taskFields({
        title: 'Check the bridge at km 4',
        assignee: eve.id,
        anchor: { kind: 'point', lat: 47, lng: -70.9 },
      }),
    });
    rb.write(step(), 'e.set', {
      k: 'task',
      id: 't1',
      f: taskNotesFields('Rotten plank, bring the saw'),
    });
    rb.write(step(), 'msg', { id: 'm1', th: 'team', tx: 'Task is up' });
    // An edit: new title and due, no place any more, new notes (three writes).
    const before = entityToTask(rb.data(now).entities.get(entityKey('task', 't1', bob.id))!)!;
    const writes = taskEditWrites(before, {
      title: 'Fix the bridge at km 4',
      notes: 'Rotten plank on the left side, bring the saw.',
      assignee: eve.id,
      due: T0 + 60 * MIN,
      anchor: null,
    });
    expect(writes).toHaveLength(3);
    const editOps = writes.map((f) => rb.write(step(), 'e.set', { k: 'task', id: 't1', f })!);
    // Bob's chain goes on after them.
    const after = rb.write(step(), 'msg', { id: 'm2', th: 'team', tx: 'Edited it' })!;
    exchange(w.root, rb, step());

    // Eve's 2.6.x phone, fed by the owner.
    const oldEve = new old.TeamReplica(c, w.teamId, eve.keys);
    oldEve.ingest(allEnvs(w.root, step()), now);
    const oldTasks = old.teamTasks(oldEve.data(now));
    expect(oldTasks).toHaveLength(1);
    expect(oldTasks[0]).toMatchObject<Partial<TeamTask>>({
      title: 'Fix the bridge at km 4',
      assignee: eve.id,
      due: T0 + 60 * MIN,
      // It cannot read "no place": the old place stays on that phone.
      anchor: { kind: 'point', lat: 47, lng: -70.9 },
    });
    // Only the writes it cannot read are skipped, and as invalid, never forbidden.
    const skipped = oldEve.data(now).skipped;
    expect(skipped.filter((s) => s.why === 'forbidden')).toEqual([]);
    const notesOps = [...oldEve.log.logged()].filter((op) => {
      const body = oldEve.decode(op) as { f?: Record<string, unknown> } | undefined;
      return body?.f !== undefined && ('notes' in body.f || body.f['ak'] === null);
    });
    expect(notesOps).toHaveLength(3);
    for (const op of notesOps) expect(skipped).toContainEqual({ id: op.id, why: 'invalid' });
    // The chain is whole: Bob's message after the edits is there, nothing parked.
    expect(oldEve.log.logged().some((op) => op.id === after.id)).toBe(true);
    expect(oldEve.versionVector()).toEqual(w.root.versionVector());
    expect(oldEve.parkedSize).toBe(0);
    expect(editOps.every((op) => oldEve.log.logged().some((x) => x.id === op.id))).toBe(true);

    // Dan (2.6.3) only ever syncs with Eve's old phone: it relays everything.
    const rd = new TeamReplica(c, w.teamId, dan.keys);
    rd.ingest(allEnvs(oldEve as unknown as TeamReplica, now), now);
    const seen = teamTasks(rd.data(now));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject<Partial<TeamTask>>({
      title: 'Fix the bridge at km 4',
      notes: 'Rotten plank on the left side, bring the saw.',
      due: T0 + 60 * MIN,
      anchor: null,
    });
    expect(rd.versionVector()).toEqual(w.root.versionVector());
  });

  it('Eve on 2.6.x still ticks the task done, and the 2.6.3 phones see it', () => {
    const { w, bob, eve, rb } = crew();
    rb.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: taskFields({ title: 'Flag the detour', assignee: eve.id }),
    });
    rb.write(T0 + MIN + 1, 'e.set', { k: 'task', id: 't1', f: taskNotesFields('Ribbons') });
    exchange(w.root, rb, T0 + 2 * MIN);
    const oldEve = new old.TeamReplica(c, w.teamId, eve.keys);
    oldEve.ingest(allEnvs(w.root, T0 + 2 * MIN), T0 + 2 * MIN);
    oldEve.write(T0 + 3 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: { done: true, dby: eve.id, dat: T0 + 3 * MIN },
    });
    rb.ingest(allEnvs(oldEve as unknown as TeamReplica, T0 + 4 * MIN), T0 + 4 * MIN);
    expect(teamTasks(rb.data(T0 + 4 * MIN))[0]).toMatchObject({
      done: true,
      doneBy: eve.id,
      notes: 'Ribbons',
    });
  });
});
