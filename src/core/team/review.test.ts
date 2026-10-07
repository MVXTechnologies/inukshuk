/**
 * Regression tests for the stage-1 security review of PR #616 (findings H1–H3,
 * M1, M4 and the prototype-key fuzz). Each High finding's proof of concept is
 * reproduced here and must stay fixed.
 */
import { performance } from 'node:perf_hooks';

import { admitBody, OpWriter, rotateBody, shareBody, targetOf } from './actions';
import { checkEnvelope, type SignedOp } from './envelope';
import { toB64u } from './bytes';
import { canonicalize, parseJson } from './canonical';
import { isLive, mergeEntity, setOp, visibleFields } from './crdt';
import { entityKey, parseSetBody } from './data';
import { makeJoinProof } from './invite';
import { activeMembers, cutFor, resolveTeam } from './membership';
import { routeDelivery } from './notify';
import { TeamReplica } from './replica';
import { parseAudience } from './roles';
import { SyncSession, type Step } from './sync';
import {
  addMember,
  allEnvs,
  c,
  DAY,
  device,
  exchange,
  HOUR,
  invite,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from './testing/fixtures';
import { forAll, int, pick } from './testing/prop';

const msg = (r: TeamReplica, now: number, id: string, tx: string) =>
  r.write(now, 'msg', { id, th: 'team', tx });

function texts(r: TeamReplica, owner: string): string[] {
  return [...r.data().entities.values()]
    .filter((e) => e.kind === 'msg' && e.owner === owner && isLive(e.state))
    .map((e) => String(visibleFields(e.state)['tx']))
    .sort();
}

function sync(a: TeamReplica, b: TeamReplica, now: number): void {
  const { session: s1, step } = SyncSession.initiate(c, a);
  const s2 = SyncSession.respond(c, b);
  let toB = step.send;
  let toA: Uint8Array[] = [];
  for (let i = 0; i < 200 && (toA.length || toB.length); i++) {
    const nA = toB.flatMap((f) => s2.receive(f, now).send);
    const nB = toA.flatMap((f) => s1.receive(f, now).send);
    toA = nA;
    toB = nB;
  }
  expect(s1.phase).toBe('open');
  void ({} as Step);
}

describe('H1: a rejected admission must not leave its wrap on the live key', () => {
  it('invite race: the loser held the key, so the team must rotate (PoC)', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    const inv = invite(w.root, T0 + 2);
    const rb = joinReplica(w, bob, w.root, T0 + 3);
    const winner = device();
    const loser = device();
    w.root.admit(makeJoinProof(c, inv.token, winner.keys), T0 + MIN);
    rb.admit(makeJoinProof(c, inv.token, loser.keys), T0 + 2 * MIN);
    // The loser's phone got rb's log (with its own admit) and unwrapped the live key.
    const rl = new TeamReplica(c, w.teamId, loser.keys);
    rl.ingest(allEnvs(rb, T0 + 2 * MIN), T0 + 2 * MIN);
    const leakedKey = rl.state.sendKeyId!;
    expect(rl.key(leakedKey)).toBeDefined();

    exchange(w.root, rb, T0 + 3 * MIN);
    for (const r of [w.root, rb]) {
      expect(r.isActiveMember(loser.id)).toBe(false);
      expect(r.state.needsRotation).toBe(true);
      expect(r.sendKey()).toBeUndefined();
      expect(msg(r, T0 + 4 * MIN, 'x', 'fail closed')).toBeUndefined();
    }
    w.root.control(
      T0 + 5 * MIN,
      'k.rotate',
      rotateBody(c, w.teamId, activeMembers(w.root.state)).body,
    );
    const secret = msg(w.root, T0 + 6 * MIN, 's', 'after rotation')!;
    rl.ingest(allEnvs(w.root, T0 + 7 * MIN), T0 + 7 * MIN);
    expect(rl.decode(rl.log.get(secret.id)!)).toBeUndefined();
  });

  it('an admit that loses to a revocation or to expiry also forces rotation', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    const inv = invite(w.root, T0 + 2, { maxUses: 5 });
    const rb = joinReplica(w, bob, w.root, T0 + 3);
    w.root.control(T0 + MIN, 'i.revoke', { inv: (inv.body as { inv: string }).inv });
    rb.admit(makeJoinProof(c, inv.token, device().keys), T0 + 2 * MIN); // hasn't seen the revocation
    exchange(w.root, rb, T0 + 3 * MIN);
    expect(w.root.state.needsRotation).toBe(true);

    const w2 = newWorld();
    const exp = invite(w2.root, T0 + 1, { expiresAt: T0 + DAY });
    const j = device();
    const late = new OpWriter(
      c,
      w2.root.keys,
      w2.teamId,
      w2.root.writer.cursor.seq,
      { wall: T0 + 2 * DAY, counter: 0 },
      w2.root.writer.cursor.prev,
    ).control(
      T0 + 2 * DAY,
      'm.admit',
      admitBody(c, w2.teamId, makeJoinProof(c, exp.token, j.keys), w2.root.sendKey()!),
    );
    const s = resolveTeam(c, w2.teamId, [...w2.root.log.logged(), late]);
    expect(s.rejected.get(late.id)).toBe('invite');
    expect(s.needsRotation).toBe(true);
  });

  it('a guest (or anyone) cannot force rotations with unverified wraps (re-review #1, PoC)', () => {
    const w = newWorld();
    const guest = device();
    const bob = device();
    addMember(w.root, guest, 'guest', T0 + 1);
    addMember(w.root, bob, 'member', T0 + 2);
    const rg = joinReplica(w, guest, w.root, T0 + 3);
    const rb = joinReplica(w, bob, w.root, T0 + 3);
    const keyId = w.root.state.sendKeyId!;
    // An all-zero "wrap" of the public key id, addressed to a random id.
    const junk = {
      e: toB64u(device().keys.boxPublic),
      w: [[device().id, keyId, toB64u(new Uint8Array(48))]],
    };
    const share = rg.control(T0 + MIN, 'k.share', { kw: junk });
    const admit = rg.control(T0 + MIN + 1, 'm.admit', {
      ...makeJoinProof(c, invite(w.root, T0 + 4).token, device().keys),
      kw: junk,
    });
    // A member admitting against an invite that doesn't exist is not a race either.
    const bogus = rb.control(T0 + MIN + 2, 'm.admit', {
      ...makeJoinProof(
        c,
        { teamId: w.teamId, seed: c.randomBytes(16), expiresAt: T0 },
        device().keys,
      ),
      kw: junk,
    });
    for (const r of [rg, rb]) exchange(r, w.root, T0 + 2 * MIN);
    expect(w.root.state.needsRotation).toBe(false);
    expect(msg(w.root, T0 + 3 * MIN, 'ok', 'still writing')).toBeDefined();
    const evidence = w.root.state.wrapEvidence.map((e) => e.opId);
    expect(evidence).toEqual(expect.arrayContaining([share.id, admit.id, bogus.id]));
    // And a member sharing the real key with a stranger is evidence, not a rotation.
    const leak = rb.control(
      T0 + 4 * MIN,
      'k.share',
      shareBody(c, w.teamId, [rb.sendKey()!], [{ id: device().id, x: device().x }]),
    );
    exchange(rb, w.root, T0 + 5 * MIN);
    expect(w.root.state.rejected.get(leak.id)).toBe('key');
    expect(w.root.state.wrapEvidence.some((e) => e.opId === leak.id && e.author === bob.id)).toBe(
      true,
    );
  });
});

describe('H2: prototype-named keys never reach Object.prototype', () => {
  const NAMES = [
    'toString',
    'valueOf',
    'constructor',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__proto__',
    '__defineGetter__',
  ];

  it('entity fields named like prototype members merge, sync and render (PoC)', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    const rb = joinReplica(w, bob, w.root, T0 + 2);
    w.root.write(T0 + MIN, 'e.set', { k: 'wpt', id: 'w', f: { toString: 'a', valueOf: 1 } });
    rb.write(T0 + 2 * MIN, 'e.set', { k: 'wpt', id: 'w', f: { constructor: 'b', toString: 'c' } });
    exchange(w.root, rb, T0 + 3 * MIN);
    for (const r of [w.root, rb]) {
      expect(() => r.data()).not.toThrow();
      const e = r.data().entities.get(entityKey('wpt', 'w'))!;
      expect(visibleFields(e.state)).toEqual({ toString: 'c', valueOf: 1, constructor: 'b' });
      expect(() => `${JSON.stringify(visibleFields(e.state))}`).not.toThrow();
    }
  });

  it('fuzz: prototype keys at every parse and merge stage are inert', () => {
    const w = newWorld();
    forAll(
      77,
      200,
      (rnd) => {
        const keys = Array.from({ length: int(rnd, 1, 4) }, () => pick(rnd, NAMES));
        const obj = `{${keys.map((k, i) => `${JSON.stringify(k)}:${i}`).join(',')}}`;
        return { keys, obj };
      },
      ({ obj }) => {
        const parsed = parseJson(obj)!;
        expect(() => canonicalize(parsed)).not.toThrow();
        expect(() => parseSetBody({ k: 'wpt', id: 'x', f: parsed })).not.toThrow();
        expect(() => parseAudience(parsed)).not.toThrow();
        const body = parseSetBody({ k: 'wpt', id: 'x', f: parsed });
        if (body) {
          const s = { wall: T0, counter: 0, author: 'a' };
          const merged = mergeEntity(setOp(body.f, s), setOp(body.f, { ...s, author: 'b' }));
          expect(Object.keys(visibleFields(merged)).sort()).toEqual(Object.keys(body.f).sort());
        }
        const env = { ...(parsed as object), v: 1 };
        expect(checkEnvelope(c, env, { teamId: w.teamId, now: T0 }).ok).toBe(false);
        const op = w.root.log.logged()[0]!;
        expect(() => routeDelivery(w.root.state, op, parsed, w.owner.id)).not.toThrow();
      },
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('H3: a removed member cannot rewrite history below the cut', () => {
  function scenario() {
    const w = newWorld();
    const eve = device();
    const bob = device();
    addMember(w.root, eve, 'member', T0 + 1);
    addMember(w.root, bob, 'member', T0 + 2);
    const re = joinReplica(w, eve, w.root, T0 + 3);
    const rb = joinReplica(w, bob, w.root, T0 + 3);
    const real = [1, 2, 3].map((i) => msg(re, T0 + i * MIN, `r${i}`, `real ${i}`)!);
    exchange(re, w.root, T0 + 4 * MIN);
    w.root.control(T0 + 10 * MIN, 'm.remove', { m: eve.id, cut: cutFor(w.root.state, eve.id) });
    // Eve signs a different history from seq 2, backdated before her removal.
    const evil = new OpWriter(
      c,
      eve.keys,
      w.teamId,
      1,
      { wall: T0 + MIN, counter: 5 },
      real[0]!.id,
    );
    const key = { mode: 'group' as const, ...re.sendKey()! };
    const forged = [2, 3].map((i) =>
      evil.data(T0 + MIN + i, 'msg', { id: `f${i}`, th: 'team', tx: `forged ${i}` }, key),
    );
    return { w, eve, rb, real, forged };
  }

  it('a peer that got the forged history first converges on the real one (PoC, direct)', () => {
    const { w, eve, rb, real, forged } = scenario();
    rb.ingest([real[0]!.env, ...forged.map((o) => o.env)], T0 + 11 * MIN);
    expect(texts(rb, eve.id)).toEqual(['forged 2', 'forged 3', 'real 1']);
    const report = rb.ingest(allEnvs(w.root, T0 + 12 * MIN), T0 + 12 * MIN);
    expect(report.equivocations.length).toBeGreaterThan(0); // provable: both signed ops held
    const [a, b] = report.equivocations[0]!;
    expect(rb.log.get(a)?.env.au).toBe(eve.id);
    expect(rb.log.get(b)?.env.au).toBe(eve.id);
    expect(texts(rb, eve.id)).toEqual(['real 1', 'real 2', 'real 3']);
    expect(texts(w.root, eve.id)).toEqual(['real 1', 'real 2', 'real 3']);
    // The owner refuses the forgeries outright too.
    w.root.ingest(
      forged.map((o) => o.env),
      T0 + 13 * MIN,
    );
    expect(texts(w.root, eve.id)).toEqual(['real 1', 'real 2', 'real 3']);
    for (const f of forged) expect(w.root.state.rejected.get(f.id)).toBe('fork');
  });

  it('…and over a sync session, where it must pull the pinned ops back (PoC, session)', () => {
    const { w, eve, rb, real, forged } = scenario();
    rb.ingest([real[0]!.env, ...forged.map((o) => o.env)], T0 + 11 * MIN);
    sync(rb, w.root, T0 + 12 * MIN);
    expect(texts(rb, eve.id)).toEqual(['real 1', 'real 2', 'real 3']);
    expect(rb.versionVector()[eve.id]).toBe(3);
    expect(rb.state.chains.get(eve.id)!.ids).toEqual(real.map((o) => o.id));
  });
});

describe('M1: one far-future op does not pin honest clocks', () => {
  it('only accepted ops move the clock, and never more than 5 min ahead', () => {
    const w = newWorld();
    const mal = device();
    addMember(w.root, mal, 'member', T0 + 1);
    const rm = joinReplica(w, mal, w.root, T0 + 2);
    const ahead = new OpWriter(
      c,
      mal.keys,
      w.teamId,
      rm.writer.cursor.seq,
      { wall: T0 + 23 * HOUR, counter: 0 },
      rm.writer.cursor.prev,
    ).data(
      T0 + 23 * HOUR,
      'msg',
      { id: 'a', th: 'team', tx: 'from the future' },
      { mode: 'group', ...rm.sendKey()! },
    );
    const now = T0 + MIN;
    expect(w.root.ingest([ahead.env], now).accepted).toHaveLength(1);
    expect(w.root.writer.cursor.hlc.wall).toBeLessThanOrEqual(now + 5 * MIN);
    // The owner's next op is still acceptable to a peer whose clock is right.
    const next = msg(w.root, now, 'b', 'honest')!;
    expect(checkEnvelope(c, next.env, { teamId: w.teamId, now, maxFutureMs: 10 * MIN }).ok).toBe(
      true,
    );
    // A stranger's far-future op (quarantined, not accepted) moves nothing.
    const before = w.root.writer.cursor.hlc;
    const stranger = new OpWriter(c, device().keys, w.teamId, 0, {
      wall: T0 + 20 * HOUR,
      counter: 0,
    });
    w.root.ingest([stranger.control(T0 + 20 * HOUR, 'g.set', { id: 'z' }).env], now);
    expect(w.root.writer.cursor.hlc).toEqual(before);
  });
});

describe('M4: delete authority is the role at the op’s position', () => {
  it('a delete made as a member stays forbidden after promotion', () => {
    const w = newWorld();
    const bob = device();
    const carol = device();
    addMember(w.root, bob, 'member', T0 + 1);
    addMember(w.root, carol, 'member', T0 + 2);
    const rb = joinReplica(w, bob, w.root, T0 + 3);
    const rc = joinReplica(w, carol, w.root, T0 + 3);
    rc.write(T0 + MIN, 'e.set', { k: 'comment', id: 'c', f: { photoId: 'p', text: 'mine' } });
    exchange(rc, rb, T0 + 2 * MIN);
    const del = rb.write(T0 + 3 * MIN, 'e.del', { k: 'comment', id: 'c', o: carol.id })!;
    exchange(rb, w.root, T0 + 4 * MIN);
    exchange(rc, w.root, T0 + 4 * MIN);
    w.root.control(T0 + 5 * MIN, 'm.update', { m: bob.id, r: 'admin' });
    const e = w.root.data().entities.get(entityKey('comment', 'c', carol.id))!;
    expect(isLive(e.state)).toBe(true);
    expect(w.root.data().skipped).toContainEqual({ id: del.id, why: 'forbidden' });
    expect(w.root.state.members.get(bob.id)?.role).toBe('admin');
  });
});

describe('M2 sanity: incremental appends match a full refold', () => {
  it('the replica state equals resolveTeam over the same ops', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    const rb = joinReplica(w, bob, w.root, T0 + 2);
    for (let i = 0; i < 30; i++) {
      const r = i % 2 ? w.root : rb;
      r.write(T0 + MIN + i, 'e.set', { k: 'wpt', id: `w${i % 4}`, f: { n: i } });
    }
    exchange(w.root, rb, T0 + HOUR);
    for (const r of [w.root, rb]) {
      const full = resolveTeam(c, w.teamId, r.log.logged());
      expect(r.state.data.map((o) => o.id)).toEqual(full.data.map((o) => o.id));
      expect([...r.state.rejected]).toEqual([...full.rejected]);
      expect(r.state.sendKeyId).toBe(full.sendKeyId);
    }
    expect(targetOf).toBeDefined();
  });
});

describe('re-review #2/#3: rebuild cost', () => {
  it('rebuilds a 100k-op single-author log in < 500 ms (no quadratic maxSeq, no spread)', () => {
    const w = newWorld();
    const genesis = w.root.log.logged()[0]!;
    const keyId = w.root.state.sendKeyId!;
    const idOf = (i: number) => {
      const b = new Uint8Array(32);
      new DataView(b.buffer).setUint32(0, i + 1);
      b[31] = 7;
      return toB64u(b);
    };
    const ops: SignedOp[] = [genesis];
    let prev = genesis.id;
    for (let i = 0; i < 100_000; i++) {
      const id = idOf(i);
      const sq = i + 2;
      ops.push({
        env: {
          v: 1,
          tm: w.teamId,
          au: w.owner.id,
          sq,
          pv: prev,
          hc: [T0 + MIN + i, 0],
          t: 'e.set',
          k: keyId,
          n: '',
          c: '',
          sg: '',
        },
        id,
        stamp: { wall: T0 + MIN + i, counter: 0, author: w.owner.id },
        bytes: 200,
      });
      prev = id;
    }
    const t = performance.now();
    const s = resolveTeam(c, w.teamId, ops);
    const ms = performance.now() - t;
    expect(s.data).toHaveLength(100_000);
    expect(ms).toBeLessThan(500);
  });

  it('after a proven equivocation, further forks are coalesced, not refolded per op', () => {
    const w = newWorld();
    const eve = device();
    addMember(w.root, eve, 'member', T0 + 1);
    const re = joinReplica(w, eve, w.root, T0 + 2);
    const real = Array.from({ length: 40 }, (_, i) => msg(re, T0 + MIN + i, `r${i}`, `r${i}`)!);
    exchange(re, w.root, T0 + 2 * MIN);
    const key = { mode: 'group' as const, ...re.sendKey()! };
    const forkAt = (k: number) =>
      new OpWriter(
        c,
        eve.keys,
        w.teamId,
        k,
        { wall: T0 + MIN + k, counter: 9 },
        real[k - 1]!.id,
      ).data(T0 + MIN + k, 'msg', { id: `f${k}`, th: 'team', tx: 'fork' }, key);
    const before = w.root.fullFolds;
    w.root.ingest([forkAt(1).env], T0 + 3 * MIN); // first proof: one refold
    expect(w.root.fullFolds).toBe(before + 1);
    for (let k = 2; k < 30; k++) w.root.ingest([forkAt(k).env], T0 + 3 * MIN + k);
    expect(w.root.fullFolds).toBe(before + 1); // 28 more forks, no refold
    w.root.ingest([], T0 + 3 * MIN + 20_000); // coalesced refold once the interval passes
    expect(w.root.fullFolds).toBe(before + 2);
    const full = resolveTeam(c, w.teamId, w.root.log.logged());
    expect(w.root.state.chains.get(eve.id)!.ids).toEqual(full.chains.get(eve.id)!.ids);
  });
});

describe('re-review #4: the safety code cannot be ground, and handshakes time out', () => {
  /** A crypto whose randomness replays the same stream (same ephemerals and nonce). */
  const replay = (seed: number): typeof c => {
    let n = seed;
    return {
      ...c,
      randomBytes: (len: number) =>
        Uint8Array.from({ length: len }, () => (n = (n * 1103515245 + 12345) >>> 0) & 0xff),
    };
  };

  it('varying hi3 (identity, join proof) with fixed ephemerals leaves the code unchanged (PoC)', () => {
    const w = newWorld();
    const codes: string[] = [];
    for (const who of [device(), device()]) {
      addMember(w.root, who, 'member', T0 + codes.length + 1);
      const r = joinReplica(w, who, w.root, T0 + 10);
      const { session: a, step } = SyncSession.initiate(replay(1), r);
      const b = SyncSession.respond(replay(2), w.root);
      const hi2 = b.receive(step.send[0]!, T0 + MIN).send[0]!;
      const hi3 = a.receive(hi2, T0 + MIN).send[0]!;
      b.receive(hi3, T0 + MIN);
      expect(b.phase).toBe('open');
      expect(a.safetyCode).toBe(b.safetyCode);
      codes.push(b.safetyCode!);
    }
    // Same cm, nonce and ephemerals, different hi3 contents: same code, so a man in
    // the middle gains nothing by grinding what it puts in hi3.
    expect(codes[0]).toBe(codes[1]);
  });

  it('a handshake that stalls past 30 s is dropped on both sides', () => {
    const w = newWorld();
    const bob = device();
    addMember(w.root, bob, 'member', T0 + 1);
    const rb = joinReplica(w, bob, w.root, T0 + 2);
    const { session: a, step } = SyncSession.initiate(c, rb, { now: T0 });
    const b = SyncSession.respond(c, w.root);
    const hi2 = b.receive(step.send[0]!, T0).send[0]!;
    const late = a.receive(hi2, T0 + 31_000);
    expect(late.events).toContainEqual({ type: 'closed', why: 'timeout' });
    expect(b.tick(T0 + 31_000).events).toContainEqual({ type: 'closed', why: 'timeout' });
  });
});
