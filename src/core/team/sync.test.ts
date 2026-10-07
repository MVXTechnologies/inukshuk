import { concatBytes, toB64u, utf8 } from './bytes';
import { label } from './crypto';
import { canonicalize } from './canonical';
import { makeJoinProof } from './invite';
import { TeamReplica } from './replica';
import { RELAY_LIMITS } from './ratelimit';
import { MAX_RANGE_LEN, SyncSession, type SessionEvent, type Step } from './sync';
import {
  addMember,
  c,
  DAY,
  device,
  invite,
  joinReplica,
  MIN,
  newWorld,
  T0,
  type World,
} from './testing/fixtures';
import { int, mulberry32 } from './testing/prop';

interface Link {
  a: SyncSession;
  b: SyncSession;
  events: { a: SessionEvent[]; b: SessionEvent[] };
}

/** Deliver frames both ways until neither side has anything to say. */
function pump(link: Link, first: Step, now: number, maxRounds = 200): void {
  let toB = first.send;
  let toA: Uint8Array[] = [];
  link.events.a.push(...first.events);
  for (let i = 0; i < maxRounds && (toA.length > 0 || toB.length > 0); i++) {
    const nextA: Uint8Array[] = [];
    const nextB: Uint8Array[] = [];
    for (const f of toB) {
      const s = link.b.receive(f, now);
      nextA.push(...s.send);
      link.events.b.push(...s.events);
    }
    for (const f of toA) {
      const s = link.a.receive(f, now);
      nextB.push(...s.send);
      link.events.a.push(...s.events);
    }
    toA = nextA;
    toB = nextB;
  }
}

function connect(
  from: TeamReplica,
  to: TeamReplica,
  now: number,
  options: Parameters<typeof SyncSession.initiate>[2] = {},
): Link {
  const { session: a, step } = SyncSession.initiate(c, from, options);
  const b = SyncSession.respond(c, to);
  const link = { a, b, events: { a: [], b: [] } };
  pump(link, step, now);
  return link;
}

const closedWhy = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'closed' ? [e.why] : []));
const strikes = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'strike' ? [e.reason] : []));

function twoMembers(): { w: World; bob: TeamReplica } {
  const w = newWorld();
  const b = device();
  addMember(w.root, b, 'member', T0 + 1);
  const bob = new TeamReplica(c, w.teamId, b.keys);
  // Bob only knows the genesis + his own add (as after an in-person m.add), not later ops.
  bob.ingest(
    [...w.root.log.logged()].map((op) => op.env),
    T0 + 2,
  );
  return { w, bob };
}

describe('sync between members', () => {
  it('converges both logs and data in one session', () => {
    const { w, bob } = twoMembers();
    for (let i = 0; i < 20; i++)
      w.root.write(T0 + 10 + i, 'msg', { id: `o${i}`, th: 'team', tx: `owner ${i}` });
    for (let i = 0; i < 15; i++)
      bob.write(T0 + 10 + i, 'e.set', { k: 'wpt', id: `w${i}`, f: { name: `wpt ${i}` } });
    const link = connect(bob, w.root, T0 + MIN);
    expect(link.a.phase).toBe('open');
    expect(link.b.phase).toBe('open');
    expect(link.a.peer).toBe(w.owner.id);
    expect(bob.versionVector()).toEqual(w.root.versionVector());
    expect(bob.data().entities.size).toBe(35);
    expect([...bob.data().entities.keys()]).toEqual([...w.root.data().entities.keys()]);
    expect(strikes([...link.events.a, ...link.events.b])).toEqual([]);
  });

  it('pushes new ops live, and relays through a third phone', () => {
    const { w, bob } = twoMembers();
    const carol = device();
    addMember(w.root, carol, 'member', T0 + 3);
    const rc = new TeamReplica(c, w.teamId, carol.keys);
    const ab = connect(bob, w.root, T0 + MIN);
    // Owner writes; push it over the open session.
    const op = w.root.write(T0 + 2 * MIN, 'msg', { id: 'live', th: 'team', tx: 'live' })!;
    const step = ab.b.push([op]);
    for (const f of step.send) ab.a.receive(f, T0 + 2 * MIN);
    expect(bob.log.get(op.id)).toBeDefined();
    // Carol never meets the owner: she gets everything (incl. her own admission) from Bob.
    rc.ingest([w.root.log.logged()[0]!.env], T0); // she scanned the genesis from a QR / invite
    rc.ingest(
      [...w.root.log.logged()].map((o) => o.env),
      T0 + 3 * MIN,
    ); // m.add for her, via any copy
    const bc = connect(rc, bob, T0 + 3 * MIN);
    expect(bc.a.phase).toBe('open');
    expect(rc.log.get(op.id)).toBeDefined();
    expect(rc.decode(rc.log.get(op.id)!)).toMatchObject({ tx: 'live' });
  });

  it('syncs a 120-member team in bounded frames and range slices', () => {
    const w = newWorld();
    const reps: TeamReplica[] = [];
    for (let i = 0; i < 120; i++) {
      const d = device();
      addMember(w.root, d, 'member', T0 + i + 1);
      reps.push(joinReplica(w, d, w.root, T0 + 200));
    }
    for (const r of reps.slice(1, 40)) {
      r.write(T0 + 5000, 'msg', { id: 'hi', th: 'team', tx: 'hi' });
      expect(connect(r, w.root, T0 + 6000).a.phase).toBe('open');
    }
    // One chatty member writes more than one range slice.
    const chatty = reps[0]!;
    for (let i = 0; i < MAX_RANGE_LEN + 50; i++) {
      chatty.write(T0 + 300 + i, 'e.set', { k: 'point', id: `p${i}`, f: { n: i } });
    }
    expect(connect(chatty, w.root, T0 + 6500).a.phase).toBe('open');
    const late = reps[119]!;
    const l = connect(late, w.root, T0 + 7000);
    expect(l.a.phase).toBe('open');
    expect(late.versionVector()).toEqual(w.root.versionVector());
    expect(late.data().entities.size).toBe(MAX_RANGE_LEN + 50 + 39);
  });
});

describe('joining over the LAN', () => {
  it('a joiner with a fresh invite is admitted and receives the team', () => {
    const w = newWorld();
    w.root.write(T0 + 5, 'msg', { id: 'm1', th: 'team', tx: 'before you joined' });
    const inv = invite(w.root, T0 + 10);
    const j = device();
    const joiner = new TeamReplica(c, w.teamId, j.keys);
    const proof = makeJoinProof(c, inv.token, j.keys);
    const link = connect(joiner, w.root, T0 + MIN, { join: proof });
    expect(link.events.b.some((e) => e.type === 'admitted' && e.member === j.id)).toBe(true);
    expect(joiner.isActiveMember(j.id)).toBe(true);
    expect(joiner.sendKey()).toBeDefined();
    // The joiner reads history under the key it was given.
    const first = [...joiner.data().entities.values()][0];
    expect(first?.state.fields['tx']?.value).toBe('before you joined');
    expect(link.a.phase).toBe('open');
  });

  it('refuses expired, reused and forged invites, and strangers without one', () => {
    const w = newWorld();
    const inv = invite(w.root, T0 + 10, { expiresAt: T0 + DAY });
    const j = device();
    const proof = makeJoinProof(c, inv.token, j.keys);
    const expired = connect(new TeamReplica(c, w.teamId, j.keys), w.root, T0 + 2 * DAY, {
      join: proof,
    });
    expect(closedWhy(expired.events.b)).toEqual(['join-expired']);
    expect(closedWhy(expired.events.a)).toEqual(['join-expired']);

    const forged = makeJoinProof(c, { ...inv.token, seed: c.randomBytes(16) }, j.keys);
    const f = connect(new TeamReplica(c, w.teamId, j.keys), w.root, T0 + MIN, { join: forged });
    expect(closedWhy(f.events.b)).toEqual(['join-unknown-invite']);

    const stranger = connect(new TeamReplica(c, w.teamId, device().keys), w.root, T0 + MIN);
    expect(closedWhy(stranger.events.b)).toEqual(['not-member']);

    connect(new TeamReplica(c, w.teamId, j.keys), w.root, T0 + MIN, { join: proof });
    const k = device();
    const reuse = connect(new TeamReplica(c, w.teamId, k.keys), w.root, T0 + MIN, {
      join: makeJoinProof(c, inv.token, k.keys),
    });
    expect(closedWhy(reuse.events.b)).toEqual(['join-used']);
  });

  it('a joiner whose proof names another identity is refused', () => {
    const w = newWorld();
    const inv = invite(w.root, T0 + 10);
    const j = device();
    const other = device();
    const link = connect(new TeamReplica(c, w.teamId, j.keys), w.root, T0 + MIN, {
      join: makeJoinProof(c, inv.token, other.keys),
    });
    // hi3 is signed by j but claims other's id → signature check fails.
    expect(closedWhy(link.events.b)).toEqual(['auth']);
  });

  it('a member relaying a handshake cannot splice in its own identity (SIGMA MAC)', () => {
    const { w, bob } = twoMembers();
    const mallory = device();
    addMember(w.root, mallory, 'member', T0 + 3);
    const { session: a, step } = SyncSession.initiate(c, bob);
    const b = SyncSession.respond(c, w.root);
    const hi2 = b.receive(step.send[0]!, T0 + MIN).send[0]!;
    const hi3 = JSON.parse(new TextDecoder().decode(a.receive(hi2, T0 + MIN).send[0]!)) as Record<
      string,
      string
    >;
    // Mallory re-signs Bob's hi3 as herself (she can compute T2 from the clear hi1/hi2).
    const hi1 = JSON.parse(new TextDecoder().decode(step.send[0]!)) as Record<string, string>;
    const h2 = JSON.parse(new TextDecoder().decode(hi2)) as Record<string, string>;
    const t2 = c.sha256(
      concatBytes(
        label('hs2'),
        utf8(canonicalize(hi1)!),
        utf8(canonicalize({ e: h2['e'], id: h2['id'] })!),
      ),
    );
    const spliced: Record<string, string> = { t: 'hi3', id: mallory.id, mc: hi3['mc']! };
    const t3 = c.sha256(concatBytes(label('hs3'), t2, utf8(canonicalize(spliced)!)));
    spliced['sg'] = toB64u(c.ed25519.sign(t3, mallory.keys.signSecret));
    const r = b.receive(utf8(canonicalize(spliced)!), T0 + MIN);
    expect(closedWhy(r.events)).toEqual(['auth']);
    expect(strikes(r.events)).toEqual(['signature']);
  });

  it('a removed member can no longer open sessions', () => {
    const { w, bob } = twoMembers();
    w.root.control(T0 + 5, 'm.remove', { m: bob.id, cut: 0 });
    const link = connect(bob, w.root, T0 + MIN);
    expect(closedWhy(link.events.b)).toEqual(['not-member']);
  });

  it('refuses another team and a responder that is not a member', () => {
    const { w, bob } = twoMembers();
    const other = newWorld();
    const wrong = connect(bob, other.root, T0 + MIN);
    expect(closedWhy(wrong.events.b)).toEqual(['team']);
    // A stranger answering for our team (it knows the team id) is caught by the initiator.
    const impostor = new TeamReplica(c, w.teamId, device().keys);
    const l = connect(bob, impostor, T0 + MIN);
    expect(closedWhy(l.events.a)).toEqual(['peer-not-member']);
  });
});

describe('abuse handling', () => {
  function openLink(): { link: Link; w: World; bob: TeamReplica } {
    const { w, bob } = twoMembers();
    const link = connect(bob, w.root, T0 + MIN);
    return { link, w, bob };
  }

  it('a tampered or replayed frame kills the session', () => {
    const { link, w } = openLink();
    const op = w.root.write(T0 + 2 * MIN, 'msg', { id: 'x', th: 'team', tx: 'x' })!;
    const frame = link.b.push([op]).send[0]!;
    const bad = frame.slice();
    bad[3] = bad[3]! ^ 0xff;
    const s = link.a.receive(bad, T0 + 2 * MIN);
    expect(strikes(s.events)).toEqual(['decrypt']);
    expect(link.a.phase).toBe('closed');

    const again = openLink();
    const f2 = again.link.b.push([
      again.w.root.write(T0 + 2 * MIN, 'msg', { id: 'y', th: 'team', tx: 'y' })!,
    ]).send[0]!;
    again.link.a.receive(f2, T0 + 2 * MIN);
    const replay = again.link.a.receive(f2, T0 + 2 * MIN);
    expect(closedWhy(replay.events)).toEqual(['decrypt']);
  });

  it('oversize frames are refused before any parsing', () => {
    const { link } = openLink();
    const s = link.a.receive(new Uint8Array(600 * 1024), T0 + 2 * MIN);
    expect(strikes(s.events)).toEqual(['oversize']);
    expect(link.a.phase).toBe('open');
  });

  it('floods of unsolicited ops are rate-limited and end in a ban', () => {
    const { w, bob } = twoMembers();
    const { session: a, step } = SyncSession.initiate(c, bob, { limits: RELAY_LIMITS });
    const b = SyncSession.respond(c, w.root);
    const link = { a, b, events: { a: [] as SessionEvent[], b: [] as SessionEvent[] } };
    pump(link, step, T0 + MIN);
    let banned = false;
    for (let i = 0; i < 400 && !banned; i++) {
      const op = w.root.position(T0 + MIN, { la: 46.8, lo: -71.2, at: T0 + MIN + i }, 600)!;
      const frames = link.b.push([op]).send;
      for (const f of frames) {
        const s = link.a.receive(f, T0 + MIN); // same instant: buckets never refill
        if (closedWhy(s.events).includes('banned')) banned = true;
      }
    }
    expect(banned).toBe(true);
    expect(link.a.bannedUntil).toBeGreaterThan(T0 + MIN);
    expect(link.a.receive(new Uint8Array(10), T0 + MIN)).toEqual({ send: [], events: [] });
  });

  it('forged ops inside a valid session are struck and not stored', () => {
    const { link, w, bob } = openLink();
    const op = w.root.write(T0 + 2 * MIN, 'msg', { id: 'z', th: 'team', tx: 'z' })!;
    const forged = { ...op.env, sg: op.env.sg.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')) };
    // Hand-craft a sealed frame from the owner side carrying the forged op.
    const sneaky = { ...op, env: forged };
    const s = link.b.push([sneaky]);
    for (const f of s.send) {
      const r = link.a.receive(f, T0 + 2 * MIN);
      expect(strikes(r.events)).toContain('signature');
    }
    expect(bob.log.get(op.id)).toBeUndefined();
    expect(link.a.phase).toBe('open');
  });

  it('never throws on random bytes at any phase (fuzz)', () => {
    const rnd = mulberry32(7);
    for (let run = 0; run < 60; run++) {
      const { w, bob } = twoMembers();
      const { session: a, step } = SyncSession.initiate(c, bob);
      const b = SyncSession.respond(c, w.root);
      const phase = run % 3;
      const link = { a, b, events: { a: [] as SessionEvent[], b: [] as SessionEvent[] } };
      if (phase === 2) pump(link, step, T0 + MIN);
      const target = phase === 0 ? b : a;
      for (let i = 0; i < 5; i++) {
        const len = int(rnd, 0, 300);
        const junk = Uint8Array.from({ length: len }, () => int(rnd, 0, 255));
        expect(() => target.receive(junk, T0 + MIN)).not.toThrow();
      }
      // JSON that looks right but isn't.
      const fake = utf8(canonicalize({ t: 'hi1', v: 1, tm: w.teamId, e: 'AAAA', nn: 'x' })!);
      expect(() => b.receive(fake, T0 + MIN)).not.toThrow();
    }
  });

  it('protocol violations in the handshake close the session', () => {
    const { w } = twoMembers();
    const b = SyncSession.respond(c, w.root);
    const s = b.receive(utf8('{"t":"hi3","id":"x","sg":"y"}'), T0);
    expect(strikes(s.events)).toEqual(['protocol']);
    expect(b.phase).toBe('closed');
    const b2 = SyncSession.respond(c, w.root);
    expect(closedWhy(b2.receive(utf8('{"t":"bye","why":"nope"}'), T0).events)).toEqual(['nope']);
  });

  it('malformed sealed frames are struck, never thrown, and never stored', () => {
    const { link, bob } = openLink();
    // Encrypt arbitrary JSON as the owner's side would (a hostile but authenticated peer).
    const raw = link.b as unknown as { sendSealed(obj: unknown, step: Step): void };
    const send = (obj: unknown) => {
      const step: Step = { send: [], events: [] };
      raw.sendSealed(obj, step);
      return step.send.flatMap((f) => link.a.receive(f, T0 + 2 * MIN).events);
    };
    const before = bob.log.size;
    const bad: unknown[] = [
      { t: 'vv', v: 'x' },
      { t: 'vv', v: { notAMember: 3 } },
      { t: 'vv', v: { [bob.id]: 0 } },
      { t: 'vv', v: {}, extra: 1 },
      { t: 'want', r: [] },
      { t: 'want', r: [['x', 1, 2]] },
      { t: 'want', r: [[bob.id, 5, 1]] },
      { t: 'want', r: [[bob.id, 1, MAX_RANGE_LEN + 5]] },
      { t: 'want', r: [[bob.id, 1]] },
      { t: 'want', r: Array.from({ length: 65 }, () => [bob.id, 1, 1]) },
      { t: 'ops', o: 'x' },
      { t: 'ops', o: Array.from({ length: 1025 }, () => ({})) },
      { t: 'ops', o: [{ v: 1 }, 'junk', null] },
      { t: 'lol' },
      { notype: true },
    ];
    for (const frame of bad) {
      let events: SessionEvent[] = [];
      expect(() => (events = send(frame))).not.toThrow();
      expect(events.some((e) => e.type === 'strike')).toBe(true);
    }
    expect(bob.log.size).toBe(before);
    // Non-JSON plaintext inside a valid seal.
    const garbage: Step = { send: [], events: [] };
    const s = link.b as unknown as { sendKey: Uint8Array; sendCounter: number };
    const nonce = new Uint8Array(24);
    new DataView(nonce.buffer).setUint32(20, s.sendCounter++);
    garbage.send.push(
      c.aead.seal(s.sendKey, nonce, Uint8Array.from([0xff, 0xfe]), utf8('inukshuk/team/v1/frame')),
    );
    expect(strikes(link.a.receive(garbage.send[0]!, T0 + 2 * MIN).events)).toEqual(['malformed']);
  });

  it('a peer can close politely, and closed sessions ignore input', () => {
    const { link } = openLink();
    const bye = link.a.close('done');
    expect(link.a.phase).toBe('closed');
    const r = link.b.receive(bye.send[0]!, T0 + 2 * MIN);
    expect(closedWhy(r.events)).toEqual(['done']);
    expect(link.b.tick().send).toEqual([]);
    expect(link.a.close().send).toEqual([]);
  });

  it('tick resends the vector so a peer catches up on anything missed', () => {
    const { link, w, bob } = openLink();
    const op = w.root.write(T0 + 3 * MIN, 'msg', { id: 't', th: 'team', tx: 't' })!;
    const step = link.b.tick();
    pump(link, { send: [], events: [] }, T0 + 3 * MIN);
    let toA = step.send;
    for (let i = 0; i < 10 && toA.length > 0; i++) {
      const toB = toA.flatMap((f) => link.a.receive(f, T0 + 3 * MIN).send);
      toA = toB.flatMap((f) => link.b.receive(f, T0 + 3 * MIN).send);
    }
    expect(bob.log.get(op.id)).toBeDefined();
  });
});
