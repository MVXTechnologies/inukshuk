import { createTeam, OpWriter } from './actions';
import { MAX_QUARANTINE_OPS, TeamReplica } from './replica';
import {
  addMember,
  allEnvs,
  c,
  DAY,
  device,
  invite,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from './testing/fixtures';
import { makeJoinProof } from './invite';

describe('TeamReplica', () => {
  it('rebuilds from persisted ops + cursor + keys (the data-layer contract)', () => {
    const w = newWorld();
    w.root.write(T0 + MIN, 'msg', { id: 'a', th: 'team', tx: 'one' });
    const cursor = w.root.writer.cursor;
    const restored = new TeamReplica(c, w.teamId, w.root.keys, cursor);
    restored.ingest(allEnvs(w.root, T0 + 2 * MIN), T0 + 2 * MIN);
    // Keys come back by unwrapping the log (the genesis wrapped K0 for the owner).
    expect(restored.sendKey()?.keyId).toBe(w.root.sendKey()?.keyId);
    const next = restored.write(T0 + 3 * MIN, 'msg', { id: 'b', th: 'team', tx: 'two' })!;
    expect(next.env.sq).toBe(cursor.seq + 1);
    expect(restored.state.rejected.size).toBe(0);
    expect(restored.labels(restored.log.logged()[0]!)).toBeUndefined(); // no label on this genesis
  });

  it('team and group names travel as encrypted labels', () => {
    const owner = device();
    const t = createTeam(c, owner.keys, T0, { name: 'Chic-Chocs traverse' });
    const r = new TeamReplica(c, t.teamId, owner.keys, t.writer.cursor);
    r.addKey(t.key);
    r.ingest([t.genesis.env], T0);
    expect(r.labels(t.genesis)).toEqual({ name: 'Chic-Chocs traverse' });
    const g = r.control(T0 + 1, 'g.set', { id: 'north' }, { name: 'North slope' });
    expect(r.labels(g)).toEqual({ name: 'North slope' });
    expect(JSON.stringify(g.env)).not.toContain('North slope');
  });

  it('fails closed: no key, no group-mode write; sealed needs known active recipients', () => {
    const w = newWorld();
    const stranger = device();
    expect(
      w.root.write(T0 + 1, 'msg', { id: 'x', th: 'team', tx: 'x' }, { sealedTo: [stranger.id] }),
    ).toBeUndefined();
    const blind = new TeamReplica(c, w.teamId, device().keys);
    expect(blind.write(T0 + 1, 'msg', { id: 'x', th: 'team', tx: 'x' })).toBeUndefined();
    expect(blind.position(T0 + 1, { la: 0, lo: 0, at: T0 })).toBeUndefined();
  });

  it('quarantine is bounded; ops from strangers never reach the log', () => {
    const w = newWorld();
    const strangers = Array.from({ length: MAX_QUARANTINE_OPS + 10 }, () =>
      new OpWriter(c, device().keys, w.teamId).control(T0 + 1, 'g.set', { id: 'x' }),
    );
    const r = w.root.ingest(
      strangers.map((o) => o.env),
      T0 + 2,
    );
    expect(r.quarantined).toBe(MAX_QUARANTINE_OPS);
    expect(r.rejected.filter((x) => x.reason === 'quarantine-full')).toHaveLength(10);
    expect(w.root.quarantineSize).toBe(MAX_QUARANTINE_OPS);
    expect(w.root.log.size).toBe(1);
  });

  it('quarantined ops are released once their author is admitted', () => {
    const w = newWorld();
    const inv = invite(w.root, T0 + 1);
    const j = device();
    const early = new TeamReplica(c, w.teamId, j.keys);
    // The joiner's op reaches the owner before the admission does (relayed by someone else).
    const joinerOp = early.writer.control(T0 + 3 * MIN, 'g.set', { id: 'zz' });
    expect(w.root.ingest([joinerOp.env], T0 + 3 * MIN).quarantined).toBe(1);
    const res = w.root.admit(makeJoinProof(c, inv.token, j.keys), T0 + 2 * MIN);
    expect('op' in res).toBe(true);
    expect(w.root.quarantineSize).toBe(0);
    expect(w.root.log.get(joinerOp.id)).toBeDefined();
    expect(w.root.state.rejected.get(joinerOp.id)).toBe('forbidden'); // members can't define groups
  });

  it('admit refuses when this device may not admit or the team must rotate first', () => {
    const w = newWorld();
    const g = device();
    addMember(w.root, g, 'guest', T0 + 1);
    const inv = invite(w.root, T0 + 2);
    const rg = joinReplica(w, g, w.root, T0 + 3);
    expect(rg.admit(makeJoinProof(c, inv.token, device().keys), T0 + 4)).toEqual({
      error: 'not-allowed',
    });
    w.root.control(T0 + 5, 'm.remove', { m: g.id, cut: 0 });
    expect(w.root.admit(makeJoinProof(c, inv.token, device().keys), T0 + 6)).toEqual({
      error: 'rotation-pending',
    });
    const existing = makeJoinProof(c, inv.token, w.root.keys);
    expect(w.root.admit(existing, T0 + 7)).toEqual({ error: 'exists' });
    expect(w.root.admit({ ...existing, inv: device().id }, T0 + 7)).toEqual({
      error: 'unknown-invite',
    });
    expect(DAY).toBeGreaterThan(0);
  });

  it('reports duplicates, stale ephemerals and equivocations', () => {
    const w = newWorld();
    const op = w.root.write(T0 + 1, 'msg', { id: 'a', th: 'team', tx: 'a' })!;
    expect(w.root.ingest([op.env], T0 + 2).duplicates).toBe(1);
    const pos = w.root.position(T0 + 3, { la: 0, lo: 0, at: T0 }, 1)!;
    expect(w.root.ingest([pos.env], T0 + 10_000).rejected[0]?.reason).toBe('stale');
    const twin = new OpWriter(c, w.root.keys, w.teamId, op.env.sq - 1, {
      wall: T0 + 5,
      counter: 0,
    }).data(
      T0 + 5,
      'msg',
      { id: 'b', th: 'team', tx: 'other history' },
      { mode: 'group', ...w.root.sendKey()! },
    );
    expect(w.root.ingest([twin.env], T0 + 6).equivocations).toEqual([[op.id, twin.id]]);
  });
});
