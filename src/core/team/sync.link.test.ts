import { capStore } from '../group/sim/store';
import { LANE_SYNC, LANE_URGENT, LANES, type Lane } from '../group/lanes';
import { utf8, utf8Decode } from './bytes';
import { canonicalize } from './canonical';
import { makeJoinProof } from './invite';
import { RELAY_LIMITS } from './ratelimit';
import { TeamReplica } from './replica';
import {
  LINK_CAP,
  MAX_RTC_CANDIDATE,
  MAX_RTC_SDP,
  parseRtcSignal,
  RTC_CAP,
  RTC_RATE,
  SyncSession,
  UPGRADE_TIMEOUT_MS,
  WANT_STALE_MS,
  type SessionEvent,
  type SessionOptions,
  type SyncStore,
} from './sync';
import { addMember, c, DAY, device, invite, MIN, newWorld, T0 } from './testing/fixtures';

/**
 * 2.7 additions to the sync session (design §2.6, §4.4): seal on dequeue
 * (pull mode, per-lane outboxes), and the capability-gated `up`/`upok`/`rtc`
 * frames. 2.6 behaviour (push mode, no caps) is covered unchanged by
 * sync.test.ts and friends.
 */

interface End {
  s: SyncSession;
  events: SessionEvent[];
  wire: Uint8Array[];
}

/** Take one frame from a pull-mode session, strict lane priority. */
function take(s: SyncSession): Uint8Array | undefined {
  for (const l of LANES) {
    if (s.hasPending(l)) {
      const f = s.nextFrame(l);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}

function deliver(from: End, to: End, now: number, max = Infinity): number {
  let n = 0;
  for (let f = take(from.s); f !== undefined && n < max; f = n < max ? take(from.s) : undefined) {
    from.wire.push(f);
    to.events.push(...to.s.receive(f, now).events);
    n++;
  }
  return n;
}

function settle(a: End, b: End, now: number): void {
  for (let i = 0; i < 200; i++) if (deliver(a, b, now) + deliver(b, a, now) === 0) return;
}

function twoMembers() {
  const w = newWorld();
  const b = device();
  addMember(w.root, b, 'member', T0 + 1);
  const bob = new TeamReplica(c, w.teamId, b.keys);
  bob.ingest(
    w.root.log.logged().map((op) => op.env),
    T0 + 2,
  );
  return { w, bob, b };
}

const claimsAll = () => [LINK_CAP, RTC_CAP];
const claimsNone = () => [];

function open(
  from: SyncStore,
  to: SyncStore,
  now: number,
  optsA: SessionOptions = {},
  optsB: SessionOptions = {},
): { a: End; b: End } {
  const { session, step } = SyncSession.initiate(c, from, { now, pull: true, ...optsA });
  expect(step.send).toEqual([]);
  const a: End = { s: session, events: [...step.events], wire: [] };
  const b: End = { s: SyncSession.respond(c, to, { pull: true, ...optsB }), events: [], wire: [] };
  settle(a, b, now);
  return { a, b };
}

const strikes = (e: End) => e.events.flatMap((x) => (x.type === 'strike' ? [x.reason] : []));
const closed = (e: End) => e.events.flatMap((x) => (x.type === 'closed' ? [x.why] : []));
const sealed = (s: SyncSession, obj: unknown): Uint8Array => {
  // Reach the private sealer only to forge frames a hostile peer could send.
  const plain = utf8(canonicalize(obj)!);
  return (s as unknown as { seal(p: Uint8Array): Uint8Array }).seal(plain);
};

describe('pull mode (seal on dequeue)', () => {
  it('converges like push mode, and Step.send stays empty', () => {
    const { w, bob } = twoMembers();
    for (let i = 0; i < 30; i++)
      w.root.write(T0 + 10 + i, 'msg', { id: `o${i}`, th: 'team', tx: `${i}` });
    for (let i = 0; i < 20; i++)
      bob.write(T0 + 10 + i, 'e.set', { k: 'wpt', id: `w${i}`, f: { n: i } });
    const { a, b } = open(bob, w.root, T0 + MIN);
    expect(a.s.phase).toBe('open');
    expect(b.s.phase).toBe('open');
    expect(bob.versionVector()).toEqual(w.root.versionVector());
    expect(strikes(a)).toEqual([]);
    expect(strikes(b)).toEqual([]);
    expect(a.s.pendingFrames).toBe(0);
  });

  it('an SOS written behind thousands of queued catch-up ops is the next frame sealed', () => {
    const { w, bob } = twoMembers();
    const carol = device();
    addMember(w.root, carol, 'member', T0 + 2);
    const rc = new TeamReplica(c, w.teamId, carol.keys);
    rc.ingest(
      w.root.log.logged().map((op) => op.env),
      T0 + 3,
    );
    // Carol wrote 4,096 ops the owner holds and Bob lacks.
    for (let i = 0; i < 4096; i++)
      rc.write(T0 + 10 + i, 'e.set', { k: 'wpt', id: `c${i}`, f: { n: i } });
    w.root.ingest(
      rc.log.logged().map((op) => op.env),
      T0 + 5000,
    );
    bob.ingest(
      w.root.log
        .logged()
        .filter((op) => op.env.au !== carol.id)
        .map((op) => op.env),
      T0 + 5000,
    );
    const ownerEnd: End = {
      s: SyncSession.respond(c, w.root, { pull: true, limits: RELAY_LIMITS }),
      events: [],
      wire: [],
    };
    const init = SyncSession.initiate(c, bob, { now: T0 + MIN, pull: true, limits: RELAY_LIMITS });
    const bobEnd: End = { s: init.session, events: [], wire: [] };
    // Handshake and vectors, then Bob's `want`: the owner queues the catch-up.
    for (let i = 0; i < 6; i++) {
      deliver(bobEnd, ownerEnd, T0 + MIN);
      deliver(ownerEnd, bobEnd, T0 + MIN, 1);
    }
    deliver(bobEnd, ownerEnd, T0 + MIN);
    expect(ownerEnd.s.hasPending(LANE_SYNC)).toBe(true);
    const backlog = ownerEnd.s.pendingFrames;
    // The first 1,024-op slice, in 128 KiB frames.
    expect(backlog).toBeGreaterThan(2);
    const sos = w.root.write(T0 + MIN, 'e.set', { k: 'sos', id: 'help', f: { on: 1 } })!;
    ownerEnd.s.push([sos], T0 + MIN, LANE_URGENT);
    expect(ownerEnd.s.hasPending(LANE_URGENT)).toBe(true);
    // Exactly one frame later Bob holds the SOS.
    expect(deliver(ownerEnd, bobEnd, T0 + MIN, 1)).toBe(1);
    expect(bob.log.get(sos.id)).toBeDefined();
    // The counters stayed in step: the rest of the catch-up still decrypts.
    // Paced as a link would (relay budget: one 128 KiB frame every 4 s), with ticks.
    let now = T0 + MIN;
    for (let i = 0; i < 400; i++) {
      now += 4000;
      if (i % 3 === 0) {
        bobEnd.events.push(...bobEnd.s.tick(now).events);
        ownerEnd.events.push(...ownerEnd.s.tick(now).events);
      }
      const moved = deliver(ownerEnd, bobEnd, now, 1) + deliver(bobEnd, ownerEnd, now, 1);
      if (moved === 0 && bob.versionVector()[carol.id] === 4096) break;
    }
    expect(bob.versionVector()).toEqual(w.root.versionVector());
    expect(strikes(bobEnd)).toEqual([]);
    expect(strikes(ownerEnd)).toEqual([]);
  });

  it('nothing readable leaves before sealing', () => {
    const { w, bob } = twoMembers();
    w.root.write(T0 + 5, 'msg', { id: 'm', th: 'team', tx: 'plaintext marker' });
    const { a, b } = open(bob, w.root, T0 + MIN);
    for (const f of [...a.wire, ...b.wire]) {
      const text = utf8Decode(f) ?? '';
      for (const marker of ['"t":"ops"', '"t":"vv"', '"t":"want"', 'plaintext marker', bob.id]) {
        expect(text.includes(marker)).toBe(false);
      }
    }
  });

  it('defers pushes beyond its share of the peer budget to a pull', () => {
    const { w, bob } = twoMembers();
    const { a, b } = open(
      bob,
      w.root,
      T0 + MIN,
      { limits: RELAY_LIMITS },
      { limits: RELAY_LIMITS },
    );
    const ops = Array.from({ length: 200 }, (_, i) =>
      bob.write(T0 + MIN, 'e.set', { k: 'wpt', id: `x${i}`, f: { n: i } })!,
    );
    a.s.push(ops, T0 + MIN);
    settle(a, b, T0 + MIN);
    expect(strikes(b)).toEqual([]);
    expect(w.root.versionVector()).toEqual(bob.versionVector());
    // A position past the budget is just dropped (the next one replaces it).
    const pos = Array.from({ length: 200 }, (_, i) => bob.position(T0 + MIN + i, { ll: [1, i] })!);
    a.s.push(pos, T0 + MIN);
    settle(a, b, T0 + MIN);
    expect(strikes(b)).toEqual([]);
  });

  it('closing drops the queued plaintext and the peer still reads the bye', () => {
    const { w, bob } = twoMembers();
    const { a, b } = open(bob, w.root, T0 + MIN);
    a.s.push([bob.write(T0 + MIN, 'msg', { id: 'q', th: 'team', tx: 'queued' })!], T0 + MIN);
    expect(a.s.pendingFrames).toBe(1);
    a.s.close('backgrounded');
    expect(a.s.pendingFrames).toBe(1);
    expect(a.s.hasPending(LANE_URGENT)).toBe(true);
    settle(a, b, T0 + MIN);
    expect(closed(b)).toEqual(['backgrounded']);
    expect(a.s.nextFrame(LANE_SYNC)).toBeUndefined();
  });

  it('a refused join leaves its clear bye in the outbox', () => {
    const w = newWorld();
    const j = device();
    const joiner = new TeamReplica(c, w.teamId, j.keys);
    const inv = invite(w.root, T0 + 10);
    const proof = makeJoinProof(c, inv.token, j.keys);
    const { a, b } = open(joiner, w.root, T0 + 3 * DAY, { join: proof });
    expect(closed(b)).toEqual(['join-expired']);
    expect(closed(a)).toEqual(['join-expired']);
  });

  it('times out a handshake and fails cleanly in pull mode', () => {
    const { w, bob } = twoMembers();
    const { session } = SyncSession.initiate(c, bob, { now: T0, pull: true });
    expect(session.hasPending(LANE_URGENT)).toBe(true);
    take(session);
    const step = session.tick(T0 + 31_000);
    expect(step.send).toEqual([]);
    expect(step.events).toContainEqual({ type: 'closed', why: 'timeout' });
    expect(utf8Decode(take(session)!)).toContain('"t":"bye"');
    void w;
  });

  it('re-asks a stalled want only once it stopped making progress', () => {
    const { w, bob } = twoMembers();
    const { a, b } = open(bob, w.root, T0 + MIN);
    // The owner claims ops it cannot serve (a stall): Bob asks once…
    const claim = { ...w.root.versionVector(), [w.owner.id]: 99 };
    const vv = (at: number) => a.s.receive(sealed(b.s, { t: 'vv', v: claim }), at);
    vv(T0 + MIN);
    expect(a.s.hasPending(LANE_SYNC)).toBe(true);
    deliver(a, b, T0 + MIN);
    // …not again while the request is young (a second one would overlap it)…
    vv(T0 + MIN + 1000);
    expect(a.s.hasPending(LANE_SYNC)).toBe(false);
    // …and again once it made no progress for the stale window.
    vv(T0 + MIN + WANT_STALE_MS + 1);
    expect(a.s.hasPending(LANE_SYNC)).toBe(true);
    expect(strikes(a)).toEqual([]);
  });

  it('a range that completes through another peer first: the late copies were still asked for', () => {
    const { w, bob } = twoMembers();
    const limits = { ...RELAY_LIMITS, maxFrameBytes: 4096 };
    const { a, b } = open(bob, w.root, T0 + MIN, { limits }, { limits });
    // More messages than the peer's unsolicited budget, served over many small frames.
    for (let i = 0; i < 2 * RELAY_LIMITS.ops.msg[1]; i++) {
      w.root.write(T0 + MIN + 1 + i, 'msg', { id: `m${i}`, th: 'team', tx: `note ${i}` });
    }
    const at = T0 + 2 * MIN;
    b.events.push(...b.s.tick(at).events);
    deliver(b, a, at); // the vector
    deliver(a, b, at); // Bob's want
    expect(b.s.pendingFrames).toBeGreaterThan(2);
    // A faster path delivers everything first…
    bob.ingest(
      w.root.log.logged().map((op) => op.env),
      at,
    );
    // …then this peer's answer lands, frame after frame: no strike, nothing lost.
    deliver(b, a, at);
    expect(strikes(a)).toEqual([]);
    expect(bob.versionVector()).toEqual(w.root.versionVector());
  });
});

describe('`up`/`upok`: LAN upgrade to link-mux framing (cap-gated)', () => {
  function capable(claims: () => string[] = claimsAll) {
    const { w, bob } = twoMembers();
    const sa = capStore(bob, claims);
    const sb = capStore(w.root, claims);
    return { w, bob, sa, sb };
  }

  it('upgrades both ways, holding the initiator in between', () => {
    const { sa, sb } = capable();
    const { a, b } = open(sa, sb, T0, { linkUpgrade: true }, { linkUpgrade: true });
    expect(a.s.canUpgrade(T0)).toBe(true);
    expect(a.s.requestUpgrade(T0)).toBe(true);
    expect(a.s.requestUpgrade(T0)).toBe(false);
    const up = take(a.s)!;
    expect(a.s.upgradeOut).toBe(false);
    // Holding: nothing else leaves until `upok`.
    a.s.tick(T0 + 1);
    expect(a.s.hasPending(LANE_SYNC)).toBe(false);
    b.events.push(...b.s.receive(up, T0).events);
    expect(b.s.upgradeIn).toBe(true);
    expect(b.s.upgradeOut).toBe(false);
    expect(b.events).toContainEqual({ type: 'upgrade' });
    const upok = take(b.s)!;
    expect(b.s.upgradeOut).toBe(true);
    a.events.push(...a.s.receive(upok, T0).events);
    expect(a.s.upgradeIn && a.s.upgradeOut).toBe(true);
    expect(a.s.hasPending(LANE_SYNC)).toBe(true);
    settle(a, b, T0);
    expect(strikes(a)).toEqual([]);
    expect(strikes(b)).toEqual([]);
  });

  it('is never offered to a peer without the `lnk` claim (a 2.6 phone)', () => {
    const { sa, sb } = capable(claimsNone);
    const { a } = open(sa, sb, T0, { linkUpgrade: true }, { linkUpgrade: true });
    expect(a.s.canUpgrade(T0)).toBe(false);
    expect(a.s.requestUpgrade(T0)).toBe(false);
    // Nor without pull mode, nor by the responder.
    const { sa: x, sb: y } = capable();
    const { a: pa, b: pb } = open(x, y, T0, { linkUpgrade: true }, { linkUpgrade: true });
    expect(pb.s.canUpgrade(T0)).toBe(false);
    expect(pa.s.canUpgrade(T0)).toBe(true);
  });

  it('a 2.6-style peer strikes `up` exactly as any unknown frame', () => {
    const { sa, sb } = capable();
    const { a, b } = open(sa, sb, T0, { linkUpgrade: true }, {});
    a.s.requestUpgrade(T0);
    deliver(a, b, T0);
    expect(strikes(b)).toEqual(['protocol']);
  });

  it('strikes misplaced or malformed upgrade frames', () => {
    const { sa, sb } = capable();
    const { a, b } = open(sa, sb, T0, { linkUpgrade: true }, { linkUpgrade: true });
    b.events.push(...b.s.receive(sealed(a.s, { t: 'upok' }), T0).events); // responder never gets upok
    a.events.push(...a.s.receive(sealed(b.s, { t: 'up' }), T0).events); // initiator never gets up
    a.events.push(...a.s.receive(sealed(b.s, { t: 'upok' }), T0).events); // upok without up
    b.events.push(...b.s.receive(sealed(a.s, { t: 'up', x: 1 }), T0).events);
    expect(strikes(b)).toEqual(['protocol', 'malformed']);
    expect(strikes(a)).toEqual(['protocol', 'protocol']);
    // Initiator: a malformed upok after a real up.
    a.s.requestUpgrade(T0);
    take(a.s);
    a.events.push(...a.s.receive(sealed(b.s, { t: 'upok', x: 1 }), T0).events);
    expect(strikes(a)).toEqual(['protocol', 'protocol', 'malformed']);
  });

  it('ends a session whose `up` is never answered, without a bye in the wrong framing', () => {
    const { sa, sb } = capable();
    const { a } = open(sa, sb, T0, { linkUpgrade: true }, { linkUpgrade: true });
    a.s.requestUpgrade(T0);
    take(a.s);
    expect(a.s.tick(T0 + UPGRADE_TIMEOUT_MS).events).toEqual([]);
    expect(a.s.tick(T0 + UPGRADE_TIMEOUT_MS + 1).events).toContainEqual({
      type: 'closed',
      why: 'upgrade-timeout',
    });
    expect(take(a.s)).toBeUndefined();
  });
});

describe('`rtc`: WebRTC signalling inside the session (R-RTC-1/3)', () => {
  const offer = { k: 'offer' as const, sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n' };

  function rtcPair(claims: () => string[] = claimsAll, optsB: SessionOptions = { rtc: true }) {
    const { w, bob } = twoMembers();
    return open(capStore(bob, claims), capStore(w.root, claims), T0, { rtc: true }, optsB);
  }

  it('carries offer, answer and candidates to a capable active member', () => {
    const { a, b } = rtcPair();
    expect(a.s.canSignal(T0)).toBe(true);
    a.s.signal(offer, T0);
    a.s.signal(
      { k: 'ice', c: 'candidate:1 1 udp 1 203.0.113.5 4000 typ srflx', mid: '0', ix: 0 },
      T0,
    );
    b.s.signal({ k: 'answer', sdp: 'v=0\r\n' }, T0);
    settle(a, b, T0);
    const got = (e: End) => e.events.flatMap((x) => (x.type === 'rtc' ? [x.signal] : []));
    expect(got(b)).toEqual([
      offer,
      { k: 'ice', c: 'candidate:1 1 udp 1 203.0.113.5 4000 typ srflx', mid: '0', ix: 0 },
    ]);
    expect(got(a)).toEqual([{ k: 'answer', sdp: 'v=0\r\n' }]);
    // Never readable on the wire.
    for (const f of a.wire) expect(utf8Decode(f)?.includes('fingerprint') ?? false).toBe(false);
  });

  it('is never sent without the claim, the option, or to a provisional joiner', () => {
    expect(rtcPair(claimsNone).a.s.canSignal(T0)).toBe(false);
    const { a } = rtcPair(claimsNone);
    expect(a.s.signal(offer, T0)).toEqual({ send: [], events: [] });
    expect(a.s.pendingFrames).toBe(0);
    const { w } = twoMembers();
    const j = device();
    const joiner = new TeamReplica(c, w.teamId, j.keys);
    const inv = invite(w.root, T0 + 10);
    const proof = makeJoinProof(c, inv.token, j.keys);
    const jl = open(
      capStore(joiner, claimsAll),
      capStore(w.root, claimsAll),
      T0 + MIN,
      { rtc: true, join: proof },
      { rtc: true },
    );
    expect(jl.a.s.phase).toBe('open');
    expect(jl.a.s.canSignal(T0 + MIN)).toBe(false);
    // A malformed signal is refused locally.
    const { a: ok } = rtcPair();
    ok.s.signal({ k: 'offer', sdp: '' }, T0);
    expect(ok.s.pendingFrames).toBe(0);
  });

  it('a peer not speaking rtc strikes it as an unknown frame (2.6 behaviour)', () => {
    const { a, b } = rtcPair(claimsAll, {});
    a.s.signal(offer, T0);
    settle(a, b, T0);
    expect(strikes(b)).toEqual(['protocol']);
  });

  it('strikes malformed signals and floods', () => {
    const { a, b } = rtcPair();
    b.events.push(...b.s.receive(sealed(a.s, { t: 'rtc', k: 'nope' }), T0).events);
    expect(strikes(b)).toEqual(['malformed']);
    for (let i = 0; i < RTC_RATE[1] + 2; i++) {
      b.events.push(...b.s.receive(sealed(a.s, { t: 'rtc', k: 'ice', c: `c${i}` }), T0).events);
    }
    expect(strikes(b).filter((x) => x === 'rate').length).toBe(2);
  });

  it('parses signals totally', () => {
    const ok = (o: Record<string, unknown>) => parseRtcSignal({ t: 'rtc', ...o });
    expect(ok({ k: 'answer', sdp: 'x' })).toEqual({ k: 'answer', sdp: 'x' });
    expect(ok({ k: 'ice', c: '' })).toEqual({ k: 'ice', c: '' });
    for (const bad of [
      { k: 'offer' },
      { k: 'offer', sdp: '' },
      { k: 'offer', sdp: 'x'.repeat(MAX_RTC_SDP + 1) },
      { k: 'offer', sdp: 'x', c: 'y' },
      { k: 'ice', c: 1 },
      { k: 'ice', c: 'x'.repeat(MAX_RTC_CANDIDATE + 1) },
      { k: 'ice', c: 'x', mid: 5 },
      { k: 'ice', c: 'x', mid: 'm'.repeat(65) },
      { k: 'ice', c: 'x', ix: -1 },
      { k: 'ice', c: 'x', ix: 256 },
      { k: 'ice', c: 'x', ix: 1.5 },
      { k: 'ice', c: 'x', z: 1 },
      { k: 'bye' },
      {},
    ]) {
      expect(ok(bad)).toBeUndefined();
    }
  });
});

describe('signal-only sessions: the L0 room is never a data relay', () => {
  const offer = { k: 'offer' as const, sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n' };
  const only: SessionOptions = { rtc: true, signalOnly: true };

  it('authenticates and signals, but sends no vector, want, op or push', () => {
    const { w, bob } = twoMembers();
    // Bob lacks a message the root holds: a syncing session would pull it.
    w.root.write(T0 + 3, 'msg', { id: 'm1', th: 'team', tx: 'hello' });
    const { a, b } = open(
      capStore(bob, claimsAll),
      capStore(w.root, claimsAll),
      T0 + 5,
      only,
      only,
    );
    expect(a.s.phase).toBe('open');
    expect(b.s.phase).toBe('open');
    // The handshake only: hi1 and hi3 one way, hi2 the other, nothing sealed.
    expect(a.wire).toHaveLength(2);
    expect(b.wire).toHaveLength(1);
    expect(a.s.tick(T0 + 60_000)).toEqual({ send: [], events: [] });
    expect(b.s.push(w.root.log.logged(), T0 + 60_000)).toEqual({ send: [], events: [] });
    expect(a.s.pendingFrames + b.s.pendingFrames).toBe(0);
    expect(bob.versionVector()).not.toEqual(w.root.versionVector());
    // Signalling still flows.
    a.s.signal(offer, T0 + 6);
    settle(a, b, T0 + 6);
    expect(b.events.filter((x) => x.type === 'rtc')).toHaveLength(1);
    expect(strikes(a)).toEqual([]);
    expect(strikes(b)).toEqual([]);
  });

  it('strikes sync frames from a peer that tries to use the room as a relay', () => {
    const { w, bob } = twoMembers();
    const { a, b } = open(capStore(bob, claimsAll), capStore(w.root, claimsAll), T0, only, only);
    for (const f of [
      { t: 'vv', v: {} },
      { t: 'want', r: [[bob.id, 1, 1]] },
      { t: 'ops', o: [] },
    ]) {
      b.events.push(...b.s.receive(sealed(a.s, f), T0).events);
    }
    expect(strikes(b)).toEqual(['protocol', 'protocol', 'protocol']);
  });
});

describe('lanes in pull mode', () => {
  it('hands each lane only its own frames', () => {
    const { w, bob } = twoMembers();
    const { a } = open(bob, w.root, T0 + MIN);
    const lanes = (): Lane[] => LANES.filter((l) => a.s.hasPending(l));
    expect(lanes()).toEqual([]);
    a.s.push([bob.position(T0 + MIN, { ll: [1, 2] })!], T0 + MIN);
    a.s.tick(T0 + MIN);
    expect(lanes()).toEqual([1, 2]);
    expect(a.s.nextFrame(LANE_URGENT)).toBeUndefined();
  });
});
