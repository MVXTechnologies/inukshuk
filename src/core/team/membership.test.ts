import { addMemberBody, admitBody, OpWriter, rotateBody, shareBody, targetOf } from './actions';
import { checkEnvelope, type SignedOp } from './envelope';
import { makeJoinProof } from './invite';
import { newTeamKey } from './keys';
import {
  activeMembers,
  compareOps,
  DEFAULT_TEAM_LIFETIME_MS,
  isReadOnly,
  MAX_TEAM_LIFETIME_MS,
  resolveTeam,
} from './membership';
import { TeamReplica } from './replica';
import {
  addMember,
  allEnvs,
  c,
  DAY,
  device,
  exchange,
  invite,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from './testing/fixtures';
import { mulberry32, shuffle } from './testing/prop';

const ops = (r: TeamReplica): SignedOp[] => [...r.log.logged()];
const reason = (r: TeamReplica, op: SignedOp) => r.state.rejected.get(op.id);
const msg = (r: TeamReplica, now: number, tx: string) =>
  r.write(now, 'msg', { id: `m${now}`, th: 'team', tx });

/** A writer for `r`'s device whose clock starts at `wall` (to sign backdated ops). */
const backdated = (r: TeamReplica, wall: number) =>
  new OpWriter(c, r.keys, r.teamId, r.writer.cursor.seq, { wall, counter: 0 });

describe('genesis', () => {
  it('makes the creator the owner, with a usable key and the default 14-day lifetime', () => {
    const w = newWorld();
    const s = w.root.state;
    expect(s.owner).toBe(w.owner.id);
    expect(s.members.get(w.owner.id)?.role).toBe('owner');
    expect(s.expiresAt).toBe(T0 + DEFAULT_TEAM_LIFETIME_MS);
    expect(w.root.sendKey()).toBeDefined();
    expect(s.needsRotation).toBe(false);
    expect(isReadOnly(s, T0)).toBe(false);
    expect(isReadOnly(s, T0 + 15 * DAY)).toBe(true);
  });

  it('a log with no genesis for this team id resolves to nothing', () => {
    const a = newWorld();
    const b = newWorld();
    // b's genesis checked against a's team id fails envelope admission (team mismatch).
    expect(checkEnvelope(c, ops(b.root)[0]!.env, { teamId: a.teamId, now: T0 }).ok).toBe(false);
    const s = resolveTeam(c, a.teamId, []);
    expect(s.owner).toBeUndefined();
    expect(s.needsRotation).toBe(true);
  });

  it('a second genesis signed by the owner (equivocation) is rejected deterministically', () => {
    const w = newWorld();
    // Same seq 1 is impossible to re-store (equivocation), so resolve directly.
    const dup = new OpWriter(c, w.root.keys, w.teamId, 0, { wall: T0 + MIN, counter: 0 });
    const second = dup.control(T0 + MIN, 'm.genesis', ops(w.root)[0]!.env.b!);
    const s = resolveTeam(c, w.teamId, [...ops(w.root), second]);
    expect(s.rejected.get(second.id)).toBe('duplicate-genesis');
  });
});

describe('membership by admins', () => {
  it('owner adds an admin; the admin adds members; members cannot add', () => {
    const w = newWorld();
    const admin = device();
    const bob = device();
    const eve = device();
    addMember(w.root, admin, 'admin', T0 + 1);
    const ra = joinReplica(w, admin, w.root, T0 + 2);
    expect(ra.sendKey()).toBeDefined(); // the add wrapped the key for the admin
    addMember(ra, bob, 'member', T0 + 3);
    const rb = joinReplica(w, bob, ra, T0 + 4);
    expect(rb.state.members.get(bob.id)?.role).toBe('member');
    // Bob (member) tries to add Eve.
    const forged = rb.control(
      T0 + 5,
      'm.add',
      addMemberBody(c, w.teamId, targetOf(eve), 'member', rb.sendKey()!),
    );
    expect(reason(rb, forged)).toBe('forbidden');
    expect(rb.state.members.has(eve.id)).toBe(false);
  });

  it('an admin cannot mint admins, nor touch other admins or the owner', () => {
    const w = newWorld();
    const a1 = device();
    const a2 = device();
    addMember(w.root, a1, 'admin', T0 + 1);
    addMember(w.root, a2, 'admin', T0 + 2);
    const r1 = joinReplica(w, a1, w.root, T0 + 3);
    const mint = addMember(r1, device(), 'admin', T0 + 4);
    expect(reason(r1, mint)).toBe('forbidden');
    const demote = r1.control(T0 + 5, 'm.update', { m: a2.id, r: 'member', cut: 0 });
    expect(reason(r1, demote)).toBe('forbidden');
    const kickOwner = r1.control(T0 + 6, 'm.remove', { m: w.owner.id, cut: 1 });
    expect(reason(r1, kickOwner)).toBe('forbidden');
  });

  it('rejects malformed bodies without throwing', () => {
    const w = newWorld();
    const bad = [
      w.root.control(T0 + 1, 'm.add', { m: 'nope' }),
      w.root.control(T0 + 2, 'm.update', { m: w.owner.id }),
      w.root.control(T0 + 3, 'm.remove', { m: w.owner.id }),
      w.root.control(T0 + 4, 'g.set', { id: 'a b' }),
      w.root.control(T0 + 5, 't.extend', { exp: 'soon' }),
      w.root.control(T0 + 6, 't.close', { now: true }),
      w.root.control(T0 + 7, 'k.rotate', { kw: {} }),
      w.root.control(T0 + 8, 'i.create', { inv: 'x' }),
      w.root.control(T0 + 9, 'm.admit', { m: 1 }),
      w.root.control(T0 + 10, 'i.revoke', {}),
      w.root.control(T0 + 11, 'g.del', {}),
      w.root.control(T0 + 12, 'k.share', { kw: 3 }),
    ];
    for (const op of bad) expect(reason(w.root, op)).toBe('invalid-body');
  });
});

describe('removal, cuts and key rotation', () => {
  it('removal needs a rotation; the new key excludes the removed member', () => {
    const w = newWorld();
    const bob = device();
    const eve = device();
    addMember(w.root, bob, 'member', T0 + 1);
    addMember(w.root, eve, 'member', T0 + 2);
    const re = joinReplica(w, eve, w.root, T0 + 3);
    const rb = joinReplica(w, bob, w.root, T0 + 3);
    expect(msg(re, T0 + 4, 'hi from eve')).toBeDefined();
    exchange(w.root, re, T0 + 5);

    w.root.control(T0 + 6, 'm.remove', { m: eve.id, cut: re.versionVector()[eve.id] ?? 0 });
    expect(w.root.state.needsRotation).toBe(true);
    expect(w.root.sendKey()).toBeUndefined();
    expect(msg(w.root, T0 + 7, 'blocked')).toBeUndefined(); // fail closed

    const { body } = rotateBody(c, w.teamId, activeMembers(w.root.state));
    w.root.control(T0 + 8, 'k.rotate', body);
    expect(w.root.state.needsRotation).toBe(false);
    const secret = msg(w.root, T0 + 9, 'eve cannot read this')!;

    exchange(w.root, rb, T0 + 10);
    exchange(w.root, re, T0 + 10);
    expect(rb.decode(rb.log.get(secret.id)!)).toMatchObject({ tx: 'eve cannot read this' });
    // Eve is not even storing it as valid; and she has no key for it.
    expect(re.key(w.root.state.sendKeyId!)).toBeUndefined();
    expect(re.state.members.get(eve.id)?.status).toBe('removed');
    // Eve's earlier message survives (it was before the cut).
    const owners = [...w.root.data().entities.values()].map((e) => e.owner);
    expect(owners.sort()).toEqual([eve.id, w.owner.id].sort());
  });

  it("a removed member's backdated ops past the cut are refused everywhere", () => {
    const w = newWorld();
    const eve = device();
    addMember(w.root, eve, 'member', T0 + 1);
    const re = joinReplica(w, eve, w.root, T0 + 2);
    w.root.control(T0 + 10 * MIN, 'm.remove', { m: eve.id, cut: 0 });
    // Eve signs a message dated before her removal, with her next seq (1 > cut 0).
    const sneaky = backdated(re, T0 + 3).data(
      T0 + 3,
      'msg',
      { id: 'x', th: 'team', tx: 'backdated' },
      { mode: 'group', ...re.sendKey()! },
    );
    const report = w.root.ingest([sneaky.env], T0 + 11 * MIN);
    expect(report.rejected[0]?.reason).toBe('removed');
    // Even folded directly (a peer that stored it before learning of the removal):
    const s = resolveTeam(c, w.teamId, [...ops(w.root), sneaky]);
    expect(s.rejected.get(sneaky.id)).toBe('removed');
    expect(s.data.find((op) => op.id === sneaky.id)).toBeUndefined();
  });

  it('a demoted admin loses authority for ops past the cut, even backdated ones', () => {
    const w = newWorld();
    const adm = device();
    addMember(w.root, adm, 'admin', T0 + 1);
    const ra = joinReplica(w, adm, w.root, T0 + 2);
    const legit = addMember(ra, device(), 'member', T0 + 3); // seq 1
    exchange(w.root, ra, T0 + 4);
    w.root.control(T0 + 10 * MIN, 'm.update', { m: adm.id, r: 'member', cut: 1 });
    const late = backdated(ra, T0 + 5).control(
      T0 + 5,
      'm.add',
      addMemberBody(c, w.teamId, targetOf(device()), 'member', ra.sendKey()!),
    ); // seq 2, dated before the demotion
    const s = resolveTeam(c, w.teamId, [...ops(w.root), late]);
    expect(s.rejected.has(legit.id)).toBe(false);
    expect(s.rejected.get(late.id)).toBe('forbidden');
    // Re-promotion of a demoted admin is refused in v1.
    const again = w.root.control(T0 + 11 * MIN, 'm.update', { m: adm.id, r: 'admin', from: 2 });
    expect(reason(w.root, again)).toBe('forbidden');
  });

  it('demoting an admin requires a cut', () => {
    const w = newWorld();
    const adm = device();
    addMember(w.root, adm, 'admin', T0 + 1);
    const op = w.root.control(T0 + 2, 'm.update', { m: adm.id, r: 'member' });
    expect(reason(w.root, op)).toBe('invalid-body');
  });

  it('concurrent removal and role change: removal wins in either order', () => {
    for (const removalFirst of [true, false]) {
      const w = newWorld();
      const a1 = device();
      const a2 = device();
      const m = device();
      addMember(w.root, a1, 'admin', T0 + 1);
      addMember(w.root, a2, 'admin', T0 + 2);
      addMember(w.root, m, 'member', T0 + 3);
      const r1 = joinReplica(w, a1, w.root, T0 + 4);
      const r2 = joinReplica(w, a2, w.root, T0 + 4);
      const tRemove = removalFirst ? T0 + MIN : T0 + 2 * MIN;
      const tUpdate = removalFirst ? T0 + 2 * MIN : T0 + MIN;
      r1.control(tRemove, 'm.remove', { m: m.id, cut: 0 });
      r2.control(tUpdate, 'm.update', { m: m.id, r: 'guest' });
      exchange(r1, r2, T0 + 3 * MIN);
      for (const r of [r1, r2]) expect(r.state.members.get(m.id)?.status).toBe('removed');
      expect(r1.state.members.get(m.id)).toEqual(r2.state.members.get(m.id));
    }
  });

  it('concurrent rotations racing a removal fail closed until a fresh rotation', () => {
    const w = newWorld();
    const a1 = device();
    const x = device();
    const y = device();
    addMember(w.root, a1, 'admin', T0 + 1);
    addMember(w.root, x, 'member', T0 + 2);
    addMember(w.root, y, 'member', T0 + 3);
    const r1 = joinReplica(w, a1, w.root, T0 + 4);
    // Owner removes X and rotates (still including Y); admin removes Y and rotates (still including X).
    w.root.control(T0 + MIN, 'm.remove', { m: x.id, cut: 0 });
    w.root.control(
      T0 + MIN + 1,
      'k.rotate',
      rotateBody(c, w.teamId, activeMembers(w.root.state)).body,
    );
    r1.control(T0 + MIN, 'm.remove', { m: y.id, cut: 0 });
    r1.control(T0 + MIN + 2, 'k.rotate', rotateBody(c, w.teamId, activeMembers(r1.state)).body);
    exchange(w.root, r1, T0 + 2 * MIN);
    expect(w.root.state.needsRotation).toBe(true);
    expect(r1.state.sendKeyId).toBeUndefined();
    w.root.control(
      T0 + 3 * MIN,
      'k.rotate',
      rotateBody(c, w.teamId, activeMembers(w.root.state)).body,
    );
    exchange(w.root, r1, T0 + 4 * MIN);
    expect(r1.state.needsRotation).toBe(false);
    expect(r1.sendKey()).toBeDefined();
  });

  it('k.share fills in a member who missed a rotation; keys cannot be shared to strangers', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    // Rotate for the owner only (as if Bob's admit and the rotation raced).
    const { body, key } = rotateBody(c, w.teamId, [w.root.state.members.get(w.owner.id)!]);
    w.root.control(T0 + 2, 'k.rotate', body);
    expect(w.root.state.missingKey).toEqual([bob.id]);
    w.root.control(
      T0 + 3,
      'k.share',
      shareBody(c, w.teamId, [key], [w.root.state.members.get(bob.id)!]),
    );
    expect(w.root.state.missingKey).toEqual([]);
    const rb = joinReplica(w, bob, w.root, T0 + 4);
    expect(rb.sendKey()?.keyId).toBe(key.keyId);
    const stranger = device();
    const leak = w.root.control(
      T0 + 5,
      'k.share',
      shareBody(c, w.teamId, [key], [{ id: stranger.id, x: stranger.x }]),
    );
    expect(reason(w.root, leak)).toBe('key');
    // A rotation that claims an existing key id is refused.
    const reuse = w.root.control(
      T0 + 6,
      'k.rotate',
      shareBody(c, w.teamId, [key], [w.root.state.members.get(bob.id)!]),
    );
    expect(reason(w.root, reuse)).toBe('key');
    expect(newTeamKey(c).keyId).not.toBe(key.keyId);
  });
});

describe('invites and admission', () => {
  it('any member admits a joiner holding a valid invite; single use is enforced', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    const inv = invite(w.root, T0 + 2, { groups: [{ g: 'nope' }] }); // unknown group → refused
    expect(reason(w.root, inv.op)).toBe('unknown-target');
    const good = invite(w.root, T0 + 3);
    const rb = joinReplica(w, bob, w.root, T0 + 4);
    const joiner = device();
    const proof = makeJoinProof(c, good.token, joiner.keys);
    const res = rb.admit(proof, T0 + 5);
    expect('op' in res).toBe(true);
    expect(rb.state.members.get(joiner.id)).toMatchObject({ role: 'member', via: 'admit' });
    const rj = joinReplica(w, joiner, rb, T0 + 6);
    expect(rj.sendKey()).toBeDefined();
    expect(msg(rj, T0 + 7, 'hello team')).toBeDefined();
    // Second use of a single-use invite.
    const other = device();
    expect(rb.admit(makeJoinProof(c, good.token, other.keys), T0 + 8)).toEqual({ error: 'used' });
  });

  it('two peers admitting on one single-use invite concurrently: the earlier wins everywhere', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    const inv = invite(w.root, T0 + 2);
    const rb = joinReplica(w, bob, w.root, T0 + 3);
    const j1 = device();
    const j2 = device();
    expect('op' in w.root.admit(makeJoinProof(c, inv.token, j1.keys), T0 + MIN)).toBe(true);
    expect('op' in rb.admit(makeJoinProof(c, inv.token, j2.keys), T0 + 2 * MIN)).toBe(true);
    exchange(w.root, rb, T0 + 3 * MIN);
    for (const r of [w.root, rb]) {
      expect(r.isActiveMember(j1.id)).toBe(true);
      expect(r.isActiveMember(j2.id)).toBe(false);
    }
  });

  it('refuses expired, revoked, forged and admin-only invites', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    const inv = invite(w.root, T0 + 2, { maxUses: 5 });
    const rb = joinReplica(w, bob, w.root, T0 + 3);
    const j = device();
    expect(rb.admit(makeJoinProof(c, inv.token, j.keys), T0 + 3 * DAY)).toEqual({
      error: 'expired',
    });
    // A forged proof: right invite id, signed with a different seed.
    const fake = makeJoinProof(c, { ...inv.token, seed: c.randomBytes(16) }, j.keys);
    expect(rb.admit({ ...fake, inv: makeJoinProof(c, inv.token, j.keys).inv }, T0 + 4)).toEqual({
      error: 'bad-proof',
    });
    const adminOnly = invite(w.root, T0 + 5, { approve: 'admin' });
    exchange(w.root, rb, T0 + 6);
    expect(rb.admit(makeJoinProof(c, adminOnly.token, j.keys), T0 + 7)).toEqual({
      error: 'needs-admin',
    });
    w.root.control(T0 + 8, 'i.revoke', { inv: inv.body && (inv.body as { inv: string }).inv });
    exchange(w.root, rb, T0 + 9);
    expect(rb.admit(makeJoinProof(c, inv.token, j.keys), T0 + 10)).toEqual({ error: 'revoked' });
    expect(rb.admit(makeJoinProof(c, inv.token, bob.keys), T0 + 10)).toEqual({ error: 'revoked' });
  });

  it('an admit backdated before expiry by a dishonest member is still bound by its HLC', () => {
    const w = newWorld();
    const inv = invite(w.root, T0 + 1, { expiresAt: T0 + DAY });
    const j = device();
    // The owner's own replica refuses by wall clock…
    expect(w.root.admit(makeJoinProof(c, inv.token, j.keys), T0 + 2 * DAY)).toEqual({
      error: 'expired',
    });
    // …and an admit stamped after expiry is refused by every peer's fold.
    const late = new OpWriter(c, w.root.keys, w.teamId, w.root.writer.cursor.seq, {
      wall: T0 + 2 * DAY,
      counter: 0,
    }).control(
      T0 + 2 * DAY,
      'm.admit',
      admitBody(c, w.teamId, makeJoinProof(c, inv.token, j.keys), w.root.sendKey()!),
    );
    const s = resolveTeam(c, w.teamId, [...ops(w.root), late]);
    expect(s.rejected.get(late.id)).toBe('invite');
  });

  it('invites cannot mint admins or outlive 30 days', () => {
    const w = newWorld();
    const tooLong = invite(w.root, T0 + 1, { expiresAt: T0 + 40 * DAY });
    expect(reason(w.root, tooLong.op)).toBe('invalid-body');
    const asAdmin = invite(w.root, T0 + 2, { role: 'admin' as 'member' });
    expect(reason(w.root, asAdmin.op)).toBe('forbidden');
  });
});

describe('expiry and closing', () => {
  it('ops after expiry are refused; an admin extension revives the team, capped at a year', () => {
    const w = newWorld(T0, DAY);
    const late = msg(w.root, T0 + 2 * DAY, 'too late')!;
    expect(reason(w.root, late)).toBe('expired');
    w.root.control(T0 + 2 * DAY + 1, 't.extend', { exp: T0 + 10 * DAY });
    expect(w.root.state.expiresAt).toBe(T0 + 10 * DAY);
    const ok = msg(w.root, T0 + 3 * DAY, 'back')!;
    expect(reason(w.root, ok)).toBeUndefined();
    const forever = w.root.control(T0 + 3 * DAY, 't.extend', {
      exp: T0 + MAX_TEAM_LIFETIME_MS + 1,
    });
    expect(reason(w.root, forever)).toBe('limit');
    // An extension never shortens.
    w.root.control(T0 + 3 * DAY + 1, 't.extend', { exp: T0 + 5 * DAY });
    expect(w.root.state.expiresAt).toBe(T0 + 10 * DAY);
  });

  it('members cannot extend or close; after an admin closes, everything is refused', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    const rb = joinReplica(w, bob, w.root, T0 + 2);
    expect(reason(rb, rb.control(T0 + 3, 't.extend', { exp: T0 + 20 * DAY }))).toBe('forbidden');
    expect(reason(rb, rb.control(T0 + 4, 't.close', {}))).toBe('forbidden');
    w.root.control(T0 + 5, 't.close', {});
    expect(isReadOnly(w.root.state, T0 + 6)).toBe(true);
    expect(reason(w.root, msg(w.root, T0 + 6, 'x')!)).toBe('closed');
  });
});

describe('groups', () => {
  it('builds a tree, refuses cycles, deep chains and deleting a parent', () => {
    const w = newWorld();
    const g = (id: string, p?: string) => w.root.control(T0 + 1, 'g.set', p ? { id, p } : { id });
    g('a');
    g('b', 'a');
    expect(reason(w.root, g('a', 'b'))).toBe('invalid-body'); // cycle
    expect(reason(w.root, g('c', 'zzz'))).toBe('invalid-body'); // unknown parent
    let parent = 'b';
    for (let i = 0; i < 6; i++) {
      g(`d${i}`, parent);
      parent = `d${i}`;
    }
    expect(reason(w.root, g('tooDeep', parent))).toBe('invalid-body');
    expect(reason(w.root, w.root.control(T0 + 2, 'g.del', { id: 'a' }))).toBe('forbidden');
    expect(reason(w.root, w.root.control(T0 + 3, 'g.del', { id: 'd5' }))).toBeUndefined();
    expect(w.root.state.groups.has('d5')).toBe(false);
    expect(reason(w.root, w.root.control(T0 + 4, 'g.del', { id: 'd5' }))).toBe('unknown-target');
  });
});

describe('determinism', () => {
  it('any arrival order resolves to the same state (shuffled op sets)', () => {
    const w = newWorld();
    const a1 = device();
    const bob = device();
    const eve = device();
    addMember(w.root, a1, 'admin', T0 + 1);
    const r1 = joinReplica(w, a1, w.root, T0 + 2);
    addMember(r1, bob, 'member', T0 + 3);
    addMember(r1, eve, 'member', T0 + 4);
    w.root.control(T0 + 5, 'g.set', { id: 'sar' });
    exchange(w.root, r1, T0 + 6);
    r1.control(T0 + 7, 'm.update', { m: bob.id, g: [{ g: 'sar', lead: true }] });
    w.root.control(T0 + 7, 'm.remove', { m: eve.id, cut: 0 });
    w.root.control(T0 + 8, 'k.rotate', rotateBody(c, w.teamId, activeMembers(w.root.state)).body);
    exchange(w.root, r1, T0 + 9);
    const all = ops(w.root);
    const reference = resolveTeam(c, w.teamId, all);
    const rnd = mulberry32(42);
    for (let i = 0; i < 25; i++) {
      const s = resolveTeam(c, w.teamId, [...shuffle(all, rnd), ...all.slice(0, 3)]);
      expect([...s.members.values()]).toEqual([...reference.members.values()]);
      expect([...s.rejected]).toEqual([...reference.rejected]);
      expect(s.sendKeyId).toBe(reference.sendKeyId);
      expect([...s.groups]).toEqual([...reference.groups]);
    }
    expect([...all].sort(compareOps)[0]?.env.t).toBe('m.genesis');
  });

  it('a stranger’s ops are quarantined, bounded, and never become members', () => {
    const w = newWorld();
    const stranger = new TeamReplica(c, w.teamId, device().keys);
    const fake = stranger.writer.control(T0 + 1, 'g.set', { id: 'x' });
    const r = w.root.ingest([fake.env], T0 + 2);
    expect(r.quarantined).toBe(1);
    expect(w.root.ingest([fake.env], T0 + 2).duplicates).toBe(1);
    expect(w.root.state.groups.has('x')).toBe(false);
    expect(allEnvs(w.root, T0 + 3)).toHaveLength(1);
  });
});
