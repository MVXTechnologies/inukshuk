import { createTeam } from '@core/team/actions';
import { TeamReplica } from '@core/team/replica';
import {
  addMember,
  allEnvs,
  c,
  device,
  exchange,
  joinReplica,
  newWorld,
  T0,
  type Device,
} from '@core/team/testing/fixtures';
import { GMETA, GROUP_RECORD_ID, groupMeta } from '@core/group/meta';
import { GREF } from '@core/domains/team/groupKinds';

import { libraryRegistry } from './index';
import { LFO, LIT } from './kinds';
import {
  DEFAULT_LIBRARY_ROLE,
  detachedCopy,
  followPlan,
  seedPlan,
  sharedRefs,
  syncsInBackground,
} from './share';
import { LibSim, MIN, OWNER, ROOT } from './testUtils';
import { newFolder, newItem, trash } from './writes';

const at = (n: number) => T0 + n * MIN;

/** A team T (owner + Bob, Eve, Gus) and a library group F owned by the team owner. */
function teamAndFolder(follow = 1) {
  const t = newWorld();
  const bob = device();
  const eve = device();
  const gus = device();
  addMember(t.root, bob, 'member', at(1));
  addMember(t.root, eve, 'member', at(1) + 1);
  addMember(t.root, gus, 'guest', at(1) + 2);
  const lib = createTeam(c, t.owner.keys, at(2));
  const f = new TeamReplica(c, lib.teamId, t.owner.keys, lib.writer.cursor, {
    registry: libraryRegistry(),
  });
  f.addKey(lib.key);
  f.ingest([lib.genesis.env], at(2));
  f.write(at(3), 'e.set', {
    k: GMETA,
    id: GROUP_RECORD_ID,
    f: { app: 'lib', v: 1, parent: t.teamId, follow, root: ROOT },
  });
  return { t, bob, eve, gus, f };
}

const addTo = (f: TeamReplica, d: Device, role: 'member' | 'guest' | 'admin', now: number) =>
  addMember(f, d, role, now);

describe('seeded from the team', () => {
  it('adds the picked active members with their team box keys, at the picked role', () => {
    const { t, bob, eve, gus } = teamAndFolder();
    const plan = seedPlan(t.root.state, t.owner.id, [
      { id: bob.id },
      { id: eve.id, role: 'guest' },
      { id: eve.id, role: 'admin' },
      { id: gus.id, role: 'owner' },
      { id: t.owner.id },
      { id: device().id },
    ]);
    expect(plan).toEqual(
      [
        { id: bob.id, x: bob.x, role: DEFAULT_LIBRARY_ROLE },
        { id: eve.id, x: eve.x, role: 'guest' },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });
});

describe('the folder follows its team', () => {
  it('a manager adds the team members it never had; removed team members leave', () => {
    const { t, bob, eve, gus, f } = teamAndFolder();
    addTo(f, bob, 'member', at(4));
    addTo(f, eve, 'member', at(4) + 1);
    const outsider = device();
    addTo(f, outsider, 'member', at(4) + 2);
    t.root.control(at(5), 'm.remove', { m: eve.id, cut: [0] });
    const meta = groupMeta(f.data());
    const plan = followPlan(t.root.state, f.state, meta, t.owner.id);
    expect(plan.add).toEqual([{ id: gus.id, x: gus.x, role: DEFAULT_LIBRARY_ROLE }]);
    expect(plan.remove).toEqual([eve.id]);
    // Someone removed from the folder alone is never re-added.
    f.control(at(6), 'm.remove', { m: bob.id, cut: [0] });
    expect(followPlan(t.root.state, f.state, meta, t.owner.id).add.map((m) => m.id)).toEqual([
      gus.id,
    ]);
  });

  it('does nothing unless following, of this team, and I manage the folder', () => {
    const { t, bob, f } = teamAndFolder();
    addTo(f, bob, 'member', at(4));
    const meta = groupMeta(f.data());
    expect(followPlan(t.root.state, f.state, { ...meta, follow: false }, t.owner.id)).toEqual({
      add: [],
      remove: [],
    });
    expect(followPlan(t.root.state, f.state, { ...meta, parent: 'x' }, t.owner.id).add).toEqual([]);
    expect(followPlan(t.root.state, f.state, meta, bob.id).add).toEqual([]);
    expect(followPlan(t.root.state, f.state, meta, device().id).add).toEqual([]);
    // A manager cannot hand out a role above theirs.
    expect(followPlan(t.root.state, f.state, meta, t.owner.id, 'owner').add).toEqual([]);
  });
});

describe('team folders arrive on their own', () => {
  it('lists the lib groups announced in the team, one per group, oldest announcement', () => {
    const t = newWorld();
    const bob = device();
    addMember(t.root, bob, 'member', at(1));
    const rb = joinReplica(t, bob, t.root, at(2));
    const g1 = 'AAAAAAAAAAAAAAAAAAAAAA';
    const g2 = 'BAAAAAAAAAAAAAAAAAAAAA';
    t.root.write(at(3), 'e.set', { k: GREF, id: g1, f: { app: 'lib', name: 'Winter maps' } });
    rb.write(at(4), 'e.set', { k: GREF, id: g1, f: { app: 'lib', name: 'Dup' } });
    rb.write(at(5), 'e.set', { k: GREF, id: g2, f: { app: 'lib' } });
    rb.write(at(6), 'e.set', { k: GREF, id: 'CAAAAAAAAAAAAAAAAAAAAA', f: { app: 'self' } });
    exchange(t.root, rb, at(7));
    expect(sharedRefs(t.root.data())).toEqual([
      { group: g1, by: t.owner.id, name: 'Winter maps' },
      { group: g2, by: bob.id },
    ]);
    expect(allEnvs(rb, at(8)).length).toBe(allEnvs(t.root, at(8)).length);
  });

  it('only teams sync in the background', () => {
    expect(syncsInBackground({ app: 'team', v: 1, follow: false, net: false })).toBe(true);
    expect(syncsInBackground({ app: 'lib', v: 1, follow: true, net: false })).toBe(false);
  });
});

describe('leave, keep a copy', () => {
  it('the tree as a normal folder: parents first, trash and sync fields left out', () => {
    const ED = 'ed'.padEnd(43, 'A');
    const sim = new LibSim({ [ED]: 'member' });
    sim.meta(at(0));
    sim.set(OWNER, at(0) + 1, newFolder(ROOT, 'Gaspésie'));
    sim.set(ED, at(1), newFolder('f', 'Day 1', ROOT));
    sim.set(ED, at(2), newItem('i', 'wpt', 'Camp', 'f', { ll: [-65, 49] }));
    sim.set(ED, at(3), newItem('j', 'wpt', 'Gone', ROOT));
    sim.set(ED, at(4), trash(sim.look().history, ED, LIT, 'j'));
    expect(detachedCopy(sim.look().view)).toEqual([
      { kind: LFO, id: ROOT, name: 'Gaspésie', fields: { n: 'Gaspésie' } },
      { kind: LFO, id: 'f', parent: ROOT, name: 'Day 1', fields: { n: 'Day 1', p: ROOT } },
      {
        kind: LIT,
        id: 'i',
        parent: 'f',
        name: 'Camp',
        fields: { t: 'wpt', n: 'Camp', p: 'f', ll: [-65, 49] },
      },
    ]);
  });

  it('a single shared item copies on its own', () => {
    const ED = 'ed'.padEnd(43, 'A');
    const sim = new LibSim({ [ED]: 'member' });
    sim.meta(at(0), 'solo');
    sim.set(ED, at(1), newItem('solo', 'trk', 'Ride', undefined, { g: '_p~iF~ps|U' }));
    expect(detachedCopy(sim.look().view)).toEqual([
      { kind: LIT, id: 'solo', name: 'Ride', fields: { t: 'trk', n: 'Ride', g: '_p~iF~ps|U' } },
    ]);
  });
});
