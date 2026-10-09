import type { Json } from './canonical';
import { isLive, visibleFields } from './crdt';
import { entityKey, parseMsgBody, parseSetBody, reduceData } from './data';
import { resolveTeam } from './membership';
import {
  canCompleteTask,
  canEditTask,
  entityToTask,
  statusFields,
  taskFields,
  teamTasks,
  validTaskFields,
} from './tasks';
import { addMember, c, device, exchange, joinReplica, MIN, newWorld, T0 } from './testing/fixtures';
import { forAll, int, mulberry32, pick, shuffle } from './testing/prop';
import type { TeamReplica } from './replica';
import { teamPins } from '../teamui/pins';

/** Owner (admin), Bob (creator), Alex (assignee), Eve (another member), Gus (guest). */
function crew() {
  const w = newWorld();
  const bob = device();
  const alex = device();
  const eve = device();
  const gus = device();
  addMember(w.root, bob, 'member', T0 + 1);
  addMember(w.root, alex, 'member', T0 + 2);
  addMember(w.root, eve, 'member', T0 + 3);
  addMember(w.root, gus, 'guest', T0 + 4);
  const rb = joinReplica(w, bob, w.root, T0 + 5);
  const ra = joinReplica(w, alex, w.root, T0 + 5);
  const re = joinReplica(w, eve, w.root, T0 + 5);
  const rg = joinReplica(w, gus, w.root, T0 + 5);
  const all = [w.root, rb, ra, re, rg];
  const sync = (now: number) => {
    for (const r of all) exchange(w.root, r, now);
    for (const r of all) exchange(w.root, r, now);
  };
  return { w, bob, alex, eve, gus, rb, ra, re, rg, all, sync };
}

const task = (r: TeamReplica, owner: string, id: string) =>
  r.data().entities.get(entityKey('task', id, owner));

describe('task fields', () => {
  it('validates every field and pins "done by" to the author', () => {
    const me = device().id;
    const other = device().id;
    expect(validTaskFields(taskFields({ title: 'Flag the detour', assignee: other }), me)).toBe(
      true,
    );
    expect(
      validTaskFields(
        taskFields({
          title: 'x',
          assignee: other,
          due: T0,
          anchor: { kind: 'point', lat: 47, lng: -70.9 },
          source: { owner: me, id: 'c1' },
        }),
        me,
      ),
    ).toBe(true);
    const bads: Record<string, Json>[] = [
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(501) },
      { assignee: 'nope' },
      { due: -1 },
      { due: 1.5 },
      { ak: 'house' },
      { ai: 'a b' },
      { la: 91 },
      { lo: -181 },
      { done: 'yes' },
      { dby: other },
      { dat: 'now' },
      { owner: me },
      { tb: 'AAAA' },
    ];
    for (const bad of bads) {
      expect(validTaskFields(bad, me)).toBe(false);
    }
    expect(validTaskFields(statusFields(true, me, T0), me)).toBe(true);
    expect(validTaskFields(statusFields(true, me, T0), other)).toBe(false);
  });

  it('only tasks take an owner in e.set; pins carry an anchor only on their own thread', () => {
    const o = device().id;
    expect(parseSetBody({ k: 'task', id: 't', f: { done: true }, o })).toBeDefined();
    expect(parseSetBody({ k: 'wpt', id: 't', f: { name: 'x' }, o })).toBeUndefined();
    expect(parseSetBody({ k: 'comment', id: 't', f: { text: 'x' }, o })).toBeUndefined();
    expect(parseSetBody({ k: 'task', id: 't', f: { done: true }, o: 'x' })).toBeUndefined();
    const th = `pin:${o}:p1`;
    expect(parseMsgBody({ id: 'p1', th, tx: 'Rockfall', ll: [-70.9, 47.1] })).toBeDefined();
    expect(parseMsgBody({ id: 'r1', th, tx: 'A reply' })).toBeDefined();
    for (const bad of [
      { id: 'p1', th: `pin:${o}:p2`, tx: 'x', ll: [-70.9, 47.1] },
      { id: 'p1', th: 'pin:p1', tx: 'x', ll: [-70.9, 47.1] },
      { id: 'p1', th: 'pin:p1', tx: 'x' },
      { id: 'p1', th: `pin:nope:p1`, tx: 'x' },
      { id: 'p1', th: 'team', tx: 'x', ll: [-70.9, 47.1] },
      { id: 'p1', th, tx: 'x', ll: [-70.9] },
      { id: 'p1', th, tx: 'x', ll: [-190, 47] },
      { id: 'p1', th, tx: 'x', ll: [0, 91] },
      { id: 'p1', th, tx: 'x', ll: ['a', 'b'] },
      { id: 'p1', th: 'team:a:b', tx: 'x' },
    ]) {
      expect(parseMsgBody(bad)).toBeUndefined();
    }
  });
});

describe('task authorization (adversarial)', () => {
  it('the creator assigns; the assignee marks it done; nobody else can', () => {
    const { bob, alex, eve, rb, ra, re, sync } = crew();
    rb.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: taskFields({ title: 'Flag the detour', assignee: alex.id }),
    });
    sync(T0 + 2 * MIN);
    // Eve tries to tick it, to retitle it, and to delete it.
    const eveDone = re.write(T0 + 3 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: statusFields(true, eve.id, T0 + 3 * MIN),
    })!;
    const eveEdit = re.write(T0 + 3 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: { title: 'Ignore this' },
    })!;
    const eveDel = re.write(T0 + 3 * MIN, 'e.del', { k: 'task', id: 't1', o: bob.id })!;
    // Alex retitles (not allowed) and reassigns to Eve (not allowed), then ticks it (allowed).
    const alexEdit = ra.write(T0 + 4 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: { title: 'Something easier' },
    })!;
    const alexMove = ra.write(T0 + 4 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: { assignee: eve.id },
    })!;
    // Status writes mixed with another field are refused whole.
    const alexMixed = ra.write(T0 + 4 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: { ...statusFields(true, alex.id, T0 + 4 * MIN), due: T0 },
    })!;
    ra.write(T0 + 5 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: statusFields(true, alex.id, T0 + 5 * MIN),
    });
    sync(T0 + 6 * MIN);
    for (const r of [rb, ra, re]) {
      const t = entityToTask(task(r, bob.id, 't1')!)!;
      expect(t).toMatchObject({
        title: 'Flag the detour',
        assignee: alex.id,
        done: true,
        doneBy: alex.id,
        doneAt: T0 + 5 * MIN,
      });
      const forbidden = r
        .data()
        .skipped.filter((s) => s.why === 'forbidden')
        .map((s) => s.id);
      for (const op of [eveDone, eveEdit, eveDel, alexEdit, alexMove, alexMixed]) {
        expect(forbidden).toContain(op.id);
      }
    }
    // Eve's write without an owner just makes her own task; Bob's is untouched.
    re.write(T0 + 7 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: taskFields({ title: 'Mine', assignee: eve.id }),
    });
    sync(T0 + 8 * MIN);
    expect(
      teamTasks(rb.data())
        .map((t) => [t.owner, t.title])
        .sort(),
    ).toEqual(
      [
        [bob.id, 'Flag the detour'],
        [eve.id, 'Mine'],
      ].sort(),
    );
  });

  it('nobody can mark a task done in someone else’s name', () => {
    const { bob, alex, rb, ra, sync } = crew();
    rb.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: taskFields({ title: 'x', assignee: alex.id }),
    });
    sync(T0 + 2 * MIN);
    const spoof = ra.write(T0 + 3 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: { done: true, dby: bob.id, dat: T0 },
    })!;
    sync(T0 + 4 * MIN);
    expect(rb.data().skipped).toContainEqual({ id: spoof.id, why: 'invalid' });
    expect(entityToTask(task(rb, bob.id, 't1')!)!.done).toBe(false);
  });

  it('a reassigned task can only be ticked by its new assignee', () => {
    const { bob, alex, eve, rb, ra, re, sync } = crew();
    rb.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: taskFields({ title: 'x', assignee: alex.id }),
    });
    rb.write(T0 + 2 * MIN, 'e.set', { k: 'task', id: 't1', f: { assignee: eve.id } });
    sync(T0 + 3 * MIN);
    const stale = ra.write(T0 + 4 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: statusFields(true, alex.id, T0 + 4 * MIN),
    })!;
    re.write(T0 + 5 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: statusFields(true, eve.id, T0 + 5 * MIN),
    });
    sync(T0 + 6 * MIN);
    expect(rb.data().skipped).toContainEqual({ id: stale.id, why: 'forbidden' });
    expect(entityToTask(task(rb, bob.id, 't1')!)).toMatchObject({ done: true, doneBy: eve.id });
  });

  it('admins edit and delete any task; the creator deletes their own', () => {
    const { w, bob, alex, eve, rb, sync } = crew();
    rb.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: taskFields({ title: 'x', assignee: alex.id }),
    });
    rb.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't2',
      f: taskFields({ title: 'y', assignee: alex.id }),
    });
    sync(T0 + 2 * MIN);
    w.root.write(T0 + 3 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: { title: 'Admin wording', assignee: eve.id },
    });
    w.root.write(T0 + 3 * MIN, 'e.del', { k: 'task', id: 't2', o: bob.id });
    sync(T0 + 4 * MIN);
    expect(entityToTask(task(rb, bob.id, 't1')!)).toMatchObject({
      title: 'Admin wording',
      assignee: eve.id,
    });
    expect(isLive(task(rb, bob.id, 't2')!.state)).toBe(false);
    rb.write(T0 + 5 * MIN, 'e.del', { k: 'task', id: 't1' });
    sync(T0 + 6 * MIN);
    expect(teamTasks(rb.data())).toEqual([]);
  });

  it('guests only comment: no tasks, waypoints or deletes of others; comments and pins are fine', () => {
    const { w, bob, gus, rb, rg, sync } = crew();
    rb.write(T0 + MIN, 'e.set', { k: 'wpt', id: 'hut', f: { name: 'Hut' } });
    sync(T0 + 2 * MIN);
    const writes = [
      rg.write(T0 + 3 * MIN, 'e.set', {
        k: 'task',
        id: 'g1',
        f: taskFields({ title: 'x', assignee: bob.id }),
      }),
      rg.write(T0 + 3 * MIN, 'e.set', { k: 'wpt', id: 'hut', f: { name: 'Gus was here' } }),
      rg.write(T0 + 3 * MIN, 'e.set', { k: 'track', id: 'tr', f: { name: 'x' } }),
      rg.write(T0 + 3 * MIN, 'e.del', { k: 'wpt', id: 'hut' }),
    ];
    rg.write(T0 + 3 * MIN, 'e.set', {
      k: 'comment',
      id: 'gc',
      f: { photoId: 'p1', text: 'Nice view' },
    });
    rg.write(T0 + 3 * MIN, 'msg', {
      id: 'gp',
      th: `pin:${gus.id}:gp`,
      tx: 'Mud here',
      ll: [-70.9, 47.08],
    });
    rg.write(T0 + 4 * MIN, 'e.del', { k: 'comment', id: 'gc' });
    sync(T0 + 5 * MIN);
    const d = w.root.data();
    for (const op of writes) {
      expect(op).toBeDefined();
      expect(d.skipped).toContainEqual({ id: op!.id, why: 'forbidden' });
    }
    expect(visibleFields(d.entities.get(entityKey('wpt', 'hut'))!.state)).toEqual({ name: 'Hut' });
    expect(isLive(d.entities.get(entityKey('comment', 'gc', gus.id))!.state)).toBe(false);
    expect(teamPins(d).map((p) => [p.owner, p.messages[0]!.text])).toEqual([[gus.id, 'Mud here']]);
  });

  it('UI gates match the fold', () => {
    const me = device().id;
    const other = device().id;
    const t = {
      id: 't',
      owner: other,
      title: 'x',
      assignee: me,
      due: null,
      anchor: null,
      source: null,
      done: false,
      doneBy: null,
      doneAt: null,
      createdAt: T0,
      updatedAt: T0,
      doneBeforeReassignment: false,
    };
    expect(canCompleteTask(t, me, 'member')).toBe(true);
    expect(canEditTask(t, me, 'member')).toBe(false);
    expect(canCompleteTask(t, me, 'guest')).toBe(false);
    expect(canCompleteTask({ ...t, assignee: other }, me, 'member')).toBe(false);
    expect(canEditTask({ ...t, assignee: other }, me, 'admin')).toBe(true);
    expect(canCompleteTask(t, me, undefined)).toBe(false);
  });
});

describe('pins', () => {
  it('threads replies under the owner’s root; a redacted root hides the pin', () => {
    const { w, bob, alex, rb, ra, sync } = crew();
    const th = `pin:${bob.id}:p1`;
    rb.write(T0 + MIN, 'msg', { id: 'p1', th, tx: 'Rockfall', ll: [-70.92, 47.09] });
    ra.write(T0 + 3 * MIN, 'msg', { id: 'r1', th, tx: 'Taking the ridge' });
    // A reply to a pin nobody posted is not a pin.
    ra.write(T0 + 3 * MIN, 'msg', { id: 'r2', th: `pin:${bob.id}:zz`, tx: 'Orphan' });
    sync(T0 + 4 * MIN);
    for (const r of [rb, ra, w.root]) {
      const pins = teamPins(r.data());
      expect(pins).toHaveLength(1);
      expect(pins[0]).toMatchObject({ id: 'p1', owner: bob.id, lng: -70.92, lat: 47.09 });
      expect(pins[0]!.messages.map((m) => [m.author, m.text])).toEqual([
        [bob.id, 'Rockfall'],
        [alex.id, 'Taking the ridge'],
      ]);
    }
    rb.write(T0 + 5 * MIN, 'e.del', { k: 'msg', id: 'p1' });
    sync(T0 + 6 * MIN);
    expect(teamPins(rb.data())).toEqual([]);
  });

  it('PoC (review #3): nobody can root, backdate or move someone else’s pin', () => {
    const { w, alex, bob, gus, rb, ra, rg, sync } = crew();
    const th = `pin:${alex.id}:p1`;
    ra.write(T0 + 10 * MIN, 'msg', { id: 'p1', th, tx: 'Rockfall', ll: [-70.92, 47.09] });
    // Bob backdates an anchored "root" on Alice's thread; a guest tries too.
    const bobRoot = rb.write(T0 + MIN, 'msg', { id: 'p1', th, tx: 'Moved', ll: [0, 0] })!;
    const gusRoot = rg.write(T0 + MIN, 'msg', { id: 'p1', th, tx: 'Moved', ll: [1, 1] })!;
    // Alice "moves" her pin with a second message of the same id: messages are immutable.
    ra.write(T0 + 11 * MIN, 'msg', { id: 'p1', th, tx: 'Moved', ll: [2, 2] });
    sync(T0 + 12 * MIN);
    for (const r of [w.root, ra, rb, rg]) {
      expect(teamPins(r.data()).map((p) => [p.owner, p.lng, p.lat, p.messages.length])).toEqual([
        [alex.id, -70.92, 47.09, 1],
      ]);
      const invalid = r
        .data()
        .skipped.filter((x) => x.why === 'invalid')
        .map((x) => x.id);
      expect(invalid).toEqual(expect.arrayContaining([bobRoot.id, gusRoot.id]));
    }
    void bob;
    void gus;
  });
});

describe('review regressions', () => {
  it('PoC (review #2): "done by" never shows the wrong person', () => {
    const { bob, alex, rb, ra, sync } = crew();
    rb.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: taskFields({ title: 'x', assignee: alex.id }),
    });
    sync(T0 + 2 * MIN);
    ra.write(T0 + 3 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: statusFields(true, alex.id, T0 + 3 * MIN),
    });
    ra.write(T0 + 4 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: statusFields(false, alex.id, 0),
    });
    // Bob (the creator) ticks it with a bare `done`: refused whole.
    const bare = rb.write(T0 + 5 * MIN, 'e.set', { k: 'task', id: 't1', f: { done: true } })!;
    const half = rb.write(T0 + 5 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: { done: true, dby: bob.id },
    })!;
    const stale = rb.write(T0 + 5 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: { done: false, dby: bob.id, dat: T0 },
    })!;
    sync(T0 + 6 * MIN);
    const t = entityToTask(task(rb, bob.id, 't1')!)!;
    expect(t).toMatchObject({ done: false, doneBy: null, doneAt: null });
    const invalid = rb
      .data()
      .skipped.filter((x) => x.why === 'invalid')
      .map((x) => x.id);
    expect(invalid).toEqual(expect.arrayContaining([bare.id, half.id, stale.id]));
    rb.write(T0 + 7 * MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: statusFields(true, bob.id, T0 + 7 * MIN),
    });
    sync(T0 + 8 * MIN);
    expect(entityToTask(task(ra, bob.id, 't1')!)).toMatchObject({ done: true, doneBy: bob.id });
  });

  it('PoC (review #5): nobody, admins included, creates a task in another member’s name', () => {
    const { w, bob, alex, rb, sync } = crew();
    const forged = w.root.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 'f1',
      o: bob.id,
      f: taskFields({ title: 'Bob says: give me your keys', assignee: alex.id }),
    })!;
    sync(T0 + 2 * MIN);
    expect(rb.data().skipped).toContainEqual({ id: forged.id, why: 'forbidden' });
    expect(teamTasks(rb.data())).toEqual([]);
  });

  it('PoC (review #4): a former assignee’s backdated completion is flagged', () => {
    const { bob, alex, eve, rb, ra, sync } = crew();
    rb.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: taskFields({ title: 'x', assignee: alex.id }),
    });
    sync(T0 + 2 * MIN);
    // Alex, offline, completes "before" the reassignment by backdating his clock.
    ra.write(T0 + 2 * MIN + 1, 'e.set', {
      k: 'task',
      id: 't1',
      o: bob.id,
      f: statusFields(true, alex.id, T0 + 2 * MIN),
    });
    rb.write(T0 + 3 * MIN, 'e.set', { k: 'task', id: 't1', f: { assignee: eve.id } });
    sync(T0 + 4 * MIN);
    // Accepted residual: the completion stands, but it shows it predates the reassignment.
    expect(entityToTask(task(rb, bob.id, 't1')!)).toMatchObject({
      assignee: eve.id,
      done: true,
      doneBy: alex.id,
      doneBeforeReassignment: true,
    });
  });
});

describe('property: tasks converge and stay authorized under any order', () => {
  it('12 random histories of 25 writes from five roles', () => {
    forAll(
      589,
      12,
      (rnd) => rnd,
      (rnd) => {
        const k = crew();
        const actors = [
          { r: k.w.root, id: k.w.owner.id },
          { r: k.rb, id: k.bob.id },
          { r: k.ra, id: k.alex.id },
          { r: k.re, id: k.eve.id },
          { r: k.rg, id: k.gus.id },
        ];
        const ids = ['t1', 't2'];
        const owners = [k.bob.id, k.alex.id];
        for (let i = 0; i < 25; i++) {
          const a = pick(rnd, actors);
          const t = T0 + MIN + int(rnd, 0, 20) * 1000;
          const id = pick(rnd, ids);
          const o = pick(rnd, owners);
          const roll = rnd();
          if (roll < 0.3) {
            a.r.write(t, 'e.set', {
              k: 'task',
              id,
              f: taskFields({ title: `T${i}`, assignee: pick(rnd, actors).id }),
            });
          } else if (roll < 0.7) {
            a.r.write(t, 'e.set', {
              k: 'task',
              id,
              o,
              f: statusFields(rnd() < 0.7, rnd() < 0.9 ? a.id : pick(rnd, actors).id, t),
            });
          } else if (roll < 0.85) {
            a.r.write(t, 'e.set', { k: 'task', id, o, f: { title: `E${i}` } });
          } else {
            a.r.write(t, 'e.del', { k: 'task', id, o });
          }
          if (rnd() < 0.3) k.sync(t + 1);
        }
        k.sync(T0 + 30 * MIN);
        const ops = [...k.w.root.log.logged()];
        const view = (list: typeof ops) => {
          const s = resolveTeam(c, k.w.teamId, list);
          const d = reduceData(s, (op) => k.w.root.decode(op));
          return teamTasks(d).map((x) => JSON.stringify(x));
        };
        const ref = view(ops);
        for (const r of k.all)
          expect(teamTasks(r.data()).map((x) => JSON.stringify(x))).toEqual(ref);
        expect(view(shuffle(ops, mulberry32(int(rnd, 0, 1e6))))).toEqual(ref);
        // Every task held is owned by a non-guest, and "done by" is someone allowed.
        for (const x of teamTasks(k.w.root.data())) {
          expect(x.owner).not.toBe(k.gus.id);
          if (x.doneBy !== null) expect(x.doneBy).not.toBe(k.gus.id);
        }
      },
    );
  });
});
