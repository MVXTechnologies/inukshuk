/**
 * Backward compatibility of team drawing with 2.5.0 / 2.5.1 peers (#683).
 *
 * An "old" phone is simulated by running the REAL code with the new kinds and
 * type unknown, in an isolated module registry:
 * - `RECORD_KINDS` without `drw`/`cap` (so `parseSetBody` fails `isKind`, as
 *   it does on 2.5.1, and the fold records `skipped: invalid`);
 * - `checkEnvelope` refusing `pen` with reason `type` (2.5.1's `OP_TYPES`).
 *
 * This suite also passed once against the frozen 2.5.1 sources (`src/core/team`
 * at 101c7fe0, extracted to a scratch module dir, security review #683). It
 * cannot do that in CI: the checkout is shallow, and an integration commit
 * may not survive a squash merge. Vendoring a copy of the old protocol would
 * leave ~6,000 lines of dead code to keep compiling.
 */
import type { SignedOp } from '@core/team/envelope';
import type { TeamReplica } from '@core/team/replica';
import { LAN_LIMITS, RELAY_LIMITS } from '@core/team/ratelimit';
import { SyncSession, type SessionEvent, type Step, type SyncStore } from '@core/team/sync';
import { addMember, c, device, joinReplica, MIN, T0 } from '@core/team/testing/fixtures';
import { alertContext, alertFor } from '@core/teamui/alerts';

import { capBody } from './caps';
import { destination } from './geo';
import { penBody, toleranceM, type Stroke } from './pen';
import { teamShapes } from './view';
import { crew, drawOn, QC } from './testUtils';

const OLD_KINDS = ['trl', 'tve', 'sos', 'rly', 'mres'];

interface Old {
  TeamReplica: typeof import('@core/team/replica').TeamReplica;
  SyncSession: typeof SyncSession;
  alertFor: typeof alertFor;
  alertContext: typeof alertContext;
}

/** The real modules, with the kinds and the ephemeral type 2.5.1 does not know. */
function oldVersion(): Old {
  let out: Old | undefined;
  jest.isolateModules(() => {
    jest.doMock('@core/team/records', () => ({
      ...jest.requireActual<object>('@core/team/records'),
      RECORD_KINDS: OLD_KINDS,
    }));
    jest.doMock('@core/team/envelope', () => {
      const actual =
        jest.requireActual<typeof import('@core/team/envelope')>('@core/team/envelope');
      return {
        ...actual,
        checkEnvelope: (cr: unknown, raw: unknown, ctx: unknown) =>
          (raw as { t?: unknown } | null)?.t === 'pen'
            ? { ok: false, reason: 'type' }
            : actual.checkEnvelope(cr as never, raw, ctx as never),
      };
    });
    /* eslint-disable @typescript-eslint/no-require-imports */
    out = {
      TeamReplica: (require('@core/team/replica') as typeof import('@core/team/replica'))
        .TeamReplica,
      SyncSession: (require('@core/team/sync') as typeof import('@core/team/sync')).SyncSession,
      alertFor: (require('@core/teamui/alerts') as typeof import('@core/teamui/alerts')).alertFor,
      alertContext: (require('@core/teamui/alerts') as typeof import('@core/teamui/alerts'))
        .alertContext,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return out!;
}

const envs = (r: TeamReplica, now: number) =>
  [...r.log.logged(), ...r.liveEphemeral(now)].map((op) => op.env);

/** A comparable snapshot of a data view: visible fields per key, positions, and alerts. */
function snapshot(
  r: TeamReplica,
  me: string,
  now: number,
  fns: Pick<Old, 'alertFor' | 'alertContext'>,
  drop: readonly string[] = [],
) {
  const data = r.data(now);
  const entities = [...data.entities.entries()]
    .filter(([, e]) => !drop.includes(e.kind))
    .map(([k, e]) => [k, e.state] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const positions = [...data.positions.entries()]
    .map(([k, p]) => [k, p.value] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const ctx = fns.alertContext(r.state, data);
  const alerts = r.log
    .logged()
    .map((op) => fns.alertFor(r.state, op, r.decode(op), me, ctx))
    .filter((a) => a !== null)
    .sort((a, b) => (a!.key < b!.key ? -1 : 1));
  return { entities, positions, alerts };
}

/** A busy team: chat, a task, a rally, an SOS, positions, with drawings and caps mixed in. */
function busyTeam() {
  const t = crew();
  const { w, bob, eve, rb, re, rg, sync } = t;
  const dan = device();
  addMember(w.root, dan, 'member', T0 + 5);
  const rd = joinReplica(w, dan, w.root, T0 + 6);
  const all = [w.root, rb, re, rg, rd];
  const syncAll = (now: number) => {
    sync(now);
    for (const r of all) r.ingest(envs(w.root, now), now);
    w.root.ingest(envs(rd, now), now);
    sync(now);
    for (const r of all) r.ingest(envs(w.root, now), now);
  };
  let now = T0 + MIN;
  const step = () => (now += 1000);
  // Bob's chain mixes drawings, caps, messages and a task.
  rb.write(step(), 'e.set', capBody(bob.id));
  rb.write(step(), 'msg', { id: 'm1', th: 'team', tx: 'Leaving the lot', mn: [eve.id] });
  drawOn(rb, step(), 'a1', null);
  rb.write(step(), 'e.set', {
    k: 'task',
    id: 't1',
    f: { title: 'Scout the ridge', assignee: eve.id },
  });
  rb.write(step(), 'e.set', { k: 'drw', id: 'a1', f: { tx: 'Ridge' } });
  rb.write(step(), 'e.set', { k: 'rly', id: 'r1', f: { la: 46.8, lo: -71.2, tx: 'Meet' } });
  rb.write(step(), 'e.del', { k: 'drw', id: 'a1' });
  rb.write(step(), 'msg', { id: 'm2', th: 'team', tx: 'Ridge is clear' }, { pr: 1 });
  re.write(step(), 'e.set', { k: 'sos', id: 's1', f: { la: 46.81, lo: -71.21, tx: 'Ankle' } });
  re.write(step(), 'e.set', capBody(eve.id));
  drawOn(re, step(), 'e1', 5 * MIN);
  rg.write(step(), 'msg', { id: 'g1', th: 'team', tx: 'Guest here' });
  rb.position(step(), { la: 46.8, lo: -71.2, at: now });
  re.position(step(), { la: 46.81, lo: -71.21, at: now });
  // Dan only ever draws (so "without the drawings" is his chain removed whole).
  rd.write(step(), 'e.set', capBody(dan.id));
  for (let i = 0; i < 5; i++) drawOn(rd, step(), `d${i}`, i % 2 === 0 ? 30_000 : null);
  rd.write(step(), 'e.del', { k: 'drw', id: 'd0' });
  syncAll(step());
  return { ...t, dan, rd, now };
}

describe('backward compatibility (#683)', () => {
  const old = oldVersion();

  it('(1) the old fold over ops with drw and cap gives the same entities, positions and alerts', () => {
    const { w, eve, dan, now } = busyTeam();
    const ops = envs(w.root, now);
    // A 2.5.1 replica for Eve and the current one, fed the very same ops.
    const eveKeys = w.replicas.get(eve.id)!.keys;
    const oldEve = new old.TeamReplica(c, w.teamId, eveKeys);
    oldEve.ingest(ops, now);
    const newEve = w.replicas.get(eve.id)!;
    const a = snapshot(oldEve as unknown as TeamReplica, eve.id, now, old);
    const b = snapshot(newEve, eve.id, now, { alertFor, alertContext }, ['drw', 'cap']);
    expect(a.entities.length).toBeGreaterThan(5);
    expect(a.positions).toHaveLength(2);
    expect(a.alerts.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    // The old fold skipped every drw/cap as invalid and kept the chains whole.
    const drawOps = [...newEve.log.logged()].filter((op) => {
      const body = newEve.decode(op) as { k?: string } | undefined;
      return body?.k === 'drw' || body?.k === 'cap';
    });
    expect(drawOps.length).toBe(13);
    const skipped = new Map(oldEve.data(now).skipped.map((s) => [s.id, s.why]));
    for (const op of drawOps) expect(skipped.get(op.id)).toBe('invalid');
    expect(oldEve.versionVector()).toEqual(newEve.versionVector());
    expect(oldEve.parkedSize).toBe(0);

    // And "without them": Dan, who only draws, removed whole changes nothing else.
    const withoutDan = ops.filter((e) => (e as SignedOp['env']).au !== dan.id);
    const plain = new old.TeamReplica(c, w.teamId, eveKeys);
    plain.ingest(withoutDan, now);
    const p = snapshot(plain as unknown as TeamReplica, eve.id, now, old, ['drw', 'cap']);
    const withDan = snapshot(newEve, eve.id, now, { alertFor, alertContext }, ['drw', 'cap']);
    expect(withDan.positions).toEqual(p.positions);
    expect(withDan.alerts).toEqual(p.alerts);
    expect(withDan.entities).toEqual(p.entities);
  });

  it('(2) an old replica receives drw at seq n and still applies the author’s message at n+1', () => {
    const { w, bob, rb, re, sync } = crew();
    sync(T0 + MIN);
    const n = drawOn(rb, T0 + 2 * MIN, 'a1', 5 * MIN);
    const n1 = rb.write(T0 + 2 * MIN + 1, 'msg', { id: 'after', th: 'team', tx: 'see the arrow' })!;
    expect(n1.env.sq).toBe(n.env.sq + 1);
    expect(n1.env.pv).toBe(n.id);
    const base = envs(re, T0 + 2 * MIN).filter((e) => (e as SignedOp['env']).au !== bob.id);
    const bobs = envs(w.root, T0 + 2 * MIN).filter((e) => (e as SignedOp['env']).au === bob.id);
    for (const order of ['together', 'in-order', 'reversed'] as const) {
      const oldEve = new old.TeamReplica(c, w.teamId, re.keys);
      oldEve.ingest([...base, ...bobs], T0 + 3 * MIN);
      if (order === 'together') oldEve.ingest([n.env, n1.env], T0 + 3 * MIN);
      if (order === 'in-order') {
        oldEve.ingest([n.env], T0 + 3 * MIN);
        oldEve.ingest([n1.env], T0 + 3 * MIN);
      }
      if (order === 'reversed') {
        expect(oldEve.ingest([n1.env], T0 + 3 * MIN).parked).toBe(1);
        oldEve.ingest([n.env], T0 + 3 * MIN);
      }
      const data = oldEve.data(T0 + 3 * MIN);
      expect(data.entities.get(`msg:${bob.id}:after`)).toBeDefined();
      expect(data.skipped.find((s) => s.id === n.id)?.why).toBe('invalid');
      expect(oldEve.versionVector()[bob.id]).toBe(n1.env.sq);
      expect(oldEve.parkedSize).toBe(0);
      // It still serves the drawing onwards (the chain is intact for everyone).
      expect(oldEve.opsInRange(bob.id, n.env.sq, n1.env.sq).map((o) => o.id)).toEqual([
        n.id,
        n1.id,
      ]);
    }
  });

  it('an admin’s e.del {o} of a drawing and a guest’s cap: skipped by an old peer, chains intact', () => {
    const { w, bob, gus, rb, re, rg, sync } = crew();
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    drawOn(rb, now, 'a1', 5 * MIN);
    sync(now + 1);
    const del = w.root.write(now + 2, 'e.del', { k: 'drw', id: 'a1', o: bob.id })!;
    const after = w.root.write(now + 3, 'msg', { id: 'm1', th: 'team', tx: 'Removed it' })!;
    const cap = rg.write(now + 4, 'e.set', capBody(gus.id))!;
    const gAfter = rg.write(now + 5, 'msg', { id: 'g1', th: 'team', tx: 'Guest still here' })!;
    w.root.ingest(envs(rg, now + 6), now + 6);
    const oldEve = new old.TeamReplica(c, w.teamId, re.keys);
    oldEve.ingest(envs(w.root, now + 6), now + 6);
    const data = oldEve.data(now + 6);
    const skipped = new Map(data.skipped.map((s) => [s.id, s.why]));
    expect(skipped.get(del.id)).toBe('invalid');
    expect(skipped.get(cap.id)).toBe('invalid');
    // What follows each in its author's chain still applies.
    expect(data.entities.get(`msg:${w.owner.id}:m1`)).toBeDefined();
    expect(data.entities.get(`msg:${gus.id}:g1`)).toBeDefined();
    expect(after.env.pv).toBe(del.id);
    expect(gAfter.env.pv).toBe(cap.id);
    expect(oldEve.versionVector()).toEqual(w.root.versionVector());
    expect(oldEve.parkedSize).toBe(0);
    // The current fold applies both: the drawing is gone, the guest is capable.
    expect(teamShapes(w.root.data(now + 6), now + 6)).toEqual([]);
    expect(w.root.canReceive(gus.id, 'pen')).toBe(true);
  });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

interface Link {
  a: SyncSession;
  b: SyncSession;
  events: SessionEvent[];
}

function pump(link: Link, first: Step, now: number): void {
  let toB = first.send;
  let toA: Uint8Array[] = [];
  link.events.push(...first.events);
  for (let i = 0; i < 200 && (toA.length > 0 || toB.length > 0); i++) {
    const nextA: Uint8Array[] = [];
    const nextB: Uint8Array[] = [];
    for (const f of toB) {
      const s = link.b.receive(f, now);
      nextA.push(...s.send);
      link.events.push(...s.events);
    }
    for (const f of toA) {
      const s = link.a.receive(f, now);
      nextB.push(...s.send);
      link.events.push(...s.events);
    }
    toA = nextA;
    toB = nextB;
  }
}

/**
 * `from` dials `to` over the LAN mesh (which may carry live strokes) unless
 * `carry` is false; `to` may be an old version's session class.
 */
function connect(
  from: SyncStore,
  to: SyncStore,
  now: number,
  opts: { limits?: typeof RELAY_LIMITS; Responder?: typeof SyncSession; carry?: boolean } = {},
): Link {
  const carry = opts.carry ?? true;
  const { session: a, step } = SyncSession.initiate(c, from, {
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(carry ? { carryLiveStrokes: true } : {}),
  });
  const b = (opts.Responder ?? SyncSession).respond(c, to, carry ? { carryLiveStrokes: true } : {});
  const link = { a, b, events: [] };
  pump(link, step, now);
  return link;
}

/** A store that counts every raw op it is handed, by type. */
function counting(r: TeamReplica): { store: SyncStore; seen: Map<string, number> } {
  const seen = new Map<string, number>();
  const store: SyncStore = Object.assign(Object.create(r) as TeamReplica, {
    ingest(raws: readonly unknown[], now: number) {
      for (const raw of raws) {
        const t = String((raw as { t?: unknown }).t);
        seen.set(t, (seen.get(t) ?? 0) + 1);
      }
      return r.ingest(raws, now);
    },
  });
  return { store, seen };
}

/** Deliver a step's frames to the other side; returns how many frames it held. */
function deliver(step: Step, to: SyncSession, now: number, events: SessionEvent[]): number {
  for (const f of step.send) events.push(...to.receive(f, now).events);
  return step.send.length;
}

const strikes = (events: SessionEvent[]) => events.filter((e) => e.type === 'strike');

function stroke(i: number, id = 'live'): Stroke {
  const pts = Array.from({ length: i + 2 }, (_, k) => destination(QC, 30 * k, 5 * k));
  return { id, sh: 'free', pts, style: { c: 2, w: 2, d: false } };
}

const pen = (r: TeamReplica, now: number, i: number, id?: string) =>
  r.stroke(now, penBody(stroke(i, id), toleranceM(16, QC[1])) as never)!;

describe('pen is capability-gated (#683)', () => {
  const old = oldVersion();

  it('(3) a session with a non-capable peer never emits pen (frames counted), relays included', () => {
    const { w, eve, rb, re, sync } = crew();
    // Eve advertises; Bob (an older phone, or one that has not yet) does not.
    re.write(T0 + MIN, 'e.set', capBody(eve.id));
    sync(T0 + 2 * MIN);
    const now = T0 + 3 * MIN;
    const toBob = counting(rb);
    const toEve = counting(re);
    // A stroke already live when the sessions open (the liveEphemeral burst).
    pen(w.root, now, 0);
    const lb = connect(w.root, toBob.store, now);
    const le = connect(w.root, toEve.store, now);
    expect(lb.a.phase).toBe('open');
    let framesToBob = 0;
    let framesToEve = 0;
    for (let i = 1; i <= 40; i++) {
      const t = now + i * 250;
      const op = pen(w.root, t, i);
      framesToBob += deliver(lb.a.push([op]), lb.b, t, lb.events);
      framesToEve += deliver(le.a.push([op]), le.b, t, le.events);
    }
    expect(framesToBob).toBe(0);
    expect(toBob.seen.get('pen')).toBeUndefined();
    expect(framesToEve).toBe(40);
    expect(toEve.seen.get('pen')).toBe(41); // the burst at open + 40 live
    // Relays: Eve's stroke reaches the owner, who relays to Bob: nothing goes.
    const evePen = pen(re, now + 20_000, 3, 'e');
    w.root.ingest([evePen.env], now + 20_000);
    expect(deliver(lb.a.push([evePen]), lb.b, now + 20_000, lb.events)).toBe(0);
    // Finished shapes still reach Bob.
    const shape = drawOn(w.root, now + 21_000, 'live', 5 * MIN);
    expect(deliver(lb.a.push([shape]), lb.b, now + 21_000, lb.events)).toBe(1);
    expect(rb.log.get(shape.id)).toBeDefined();
    expect(strikes([...lb.events, ...le.events])).toEqual([]);
  });

  it('never over a transport not cleared for it (the default), nor from a store that cannot tell', () => {
    const { w, eve, re, sync } = crew();
    re.write(T0 + MIN, 'e.set', capBody(eve.id));
    sync(T0 + 2 * MIN);
    const now = T0 + 3 * MIN;
    // A Nostr relay: the session is not told it may carry strokes.
    const relay = connect(w.root, re, now, { limits: RELAY_LIMITS, carry: false });
    expect(relay.a.phase).toBe('open');
    expect(relay.a.push([pen(w.root, now + 1, 1)]).send).toHaveLength(0);
    // The default is BLOCK, whatever the limits: LAN limits, no option, a capable peer.
    const plain = connect(w.root, re, now, { carry: false });
    expect(plain.a.phase).toBe('open');
    expect(plain.a.push([pen(w.root, now + 2, 2)]).send).toHaveLength(0);
    // The same peer over a cleared link does get it (the control).
    const lanOk = connect(w.root, re, now);
    expect(lanOk.a.push([pen(w.root, now + 3, 3)]).send).toHaveLength(1);
    // A store without `canReceive` (an embedding that predates it): fail closed.
    const bare: SyncStore = Object.assign(Object.create(w.root) as TeamReplica, {
      canReceive: undefined,
    });
    const lan = connect(bare, re, now + 2);
    expect(lan.a.push([pen(w.root, now + 4, 2)]).send).toHaveLength(0);
  });

  it('an old phone talking to a new one: no pen, no strike; ungated it would ban the drawer', () => {
    const { w, rb, sync } = crew();
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    const oldBob = new old.TeamReplica(c, w.teamId, rb.keys);
    oldBob.ingest(envs(rb, now), now);
    const gated = connect(w.root, oldBob as unknown as TeamReplica, now, {
      Responder: old.SyncSession,
    });
    expect(gated.b.phase).toBe('open');
    for (let i = 0; i < 60; i++) {
      const t = now + i * 250;
      deliver(gated.a.push([pen(w.root, t, i)]), gated.b, t, gated.events);
    }
    expect(strikes(gated.events)).toEqual([]);
    expect(gated.b.phase).toBe('open');
    // Negative control: a sender that ignored the gate gets struck and banned.
    const liar: SyncStore = Object.assign(Object.create(w.root) as TeamReplica, {
      canReceive: () => true,
    });
    const ungated = connect(liar, oldBob as unknown as TeamReplica, now, {
      Responder: old.SyncSession,
    });
    for (let i = 0; i < 60 && ungated.b.phase === 'open'; i++) {
      const t = now + 20_000 + i * 250;
      deliver(ungated.a.push([pen(w.root, t, i)]), ungated.b, t, ungated.events);
    }
    expect(strikes(ungated.events).length).toBeGreaterThanOrEqual(20);
    expect(ungated.b.phase).toBe('closed');
    expect(ungated.b.bannedUntil).toBeDefined();
  });

  it('(4) a capable peer takes 4 updates a second for 60 s without a strike or a ban', () => {
    const { w, bob, rb, sync } = crew();
    rb.write(T0 + MIN, 'e.set', capBody(bob.id));
    sync(T0 + 2 * MIN);
    const now = T0 + 3 * MIN;
    const toBob = counting(rb);
    const link = connect(w.root, toBob.store, now);
    let frames = 0;
    for (let i = 0; i < 240; i++) {
      const t = now + i * 250;
      frames += deliver(link.a.push([pen(w.root, t, i % 200)]), link.b, t, link.events);
    }
    expect(frames).toBe(240);
    expect(toBob.seen.get('pen')).toBe(240);
    expect(strikes(link.events)).toEqual([]);
    expect(link.b.bannedUntil).toBeUndefined();
    expect(link.b.phase).toBe('open');
    expect(rb.liveEphemeral(now + 60_000).filter((op) => op.env.t === 'pen')).toHaveLength(1);
  });

  it('three teammates and one noisy member through one relay: each honest drawer gets ≥ 3/s, no strike', () => {
    const { w, bob, rb, re, sync } = crew();
    const dan = device();
    const mal = device();
    addMember(w.root, dan, 'member', T0 + 5);
    addMember(w.root, mal, 'member', T0 + 6);
    const rd = joinReplica(w, dan, w.root, T0 + 7);
    const rm = joinReplica(w, mal, w.root, T0 + 7);
    rb.write(T0 + MIN, 'e.set', capBody(bob.id));
    sync(T0 + 2 * MIN);
    for (const r of [rd, rm]) r.ingest(envs(w.root, T0 + 2 * MIN), T0 + 2 * MIN);
    const now = T0 + 3 * MIN;
    // Count what reaches Bob's replica, per author.
    const got = new Map<string, number>();
    const store: SyncStore = Object.assign(Object.create(rb) as TeamReplica, {
      ingest(raws: readonly unknown[], t: number) {
        for (const raw of raws) {
          const e = raw as SignedOp['env'];
          if (e.t === 'pen') got.set(e.au, (got.get(e.au) ?? 0) + 1);
        }
        return rb.ingest(raws, t);
      },
    });
    const link = connect(w.root, store, now);
    const honest = [re, rd, w.root];
    const SECONDS = 20;
    for (let i = 0; i < SECONDS * 4; i++) {
      const t = now + i * 250;
      const ops = honest.map((r) => pen(r, t, i % 200, 'x'));
      // Mallory sends ten strokes in every 250 ms (40/s), unthrottled.
      for (let k = 0; k < 10; k++) ops.push(pen(rm, t + k * 25, (i + k) % 200, 'm'));
      w.root.ingest(
        ops.map((o) => o.env),
        t,
      );
      deliver(link.a.push(ops), link.b, t, link.events);
    }
    for (const r of honest) {
      expect(got.get(r.id) ?? 0).toBeGreaterThanOrEqual(3 * SECONDS);
    }
    // The noisy member gets their own share and no more (6/s plus a burst of 12 on a LAN).
    const [rate, burst] = LAN_LIMITS.drawPerAuthor;
    expect(got.get(mal.id) ?? 0).toBeLessThanOrEqual(rate * SECONDS + burst);
    expect(strikes(link.events)).toEqual([]);
    expect(link.b.phase).toBe('open');
  });

  it('ephemeral ops (seq 0) in a solicited frame still pay the per-op rate (P1-3)', () => {
    const { w, bob, rb, sync } = crew();
    rb.write(T0 + MIN, 'e.set', capBody(bob.id));
    sync(T0 + 2 * MIN);
    const now = T0 + 3 * MIN;
    const toBob = counting(rb);
    const link = connect(w.root, toBob.store, now);
    const before = toBob.seen.get('pen') ?? 0;
    // A peer marks a frame of 200 strokes "solicited" (re: 1) though nobody asked.
    const ops = Array.from({ length: 200 }, (_, i) => pen(w.root, now + i, i % 50).env);
    const step: Step = { send: [], events: [] };
    (link.a as unknown as { sendSealed(o: unknown, s: Step): void }).sendSealed(
      { t: 'ops', o: ops, re: 1 },
      step,
    );
    deliver(step, link.b, now + 200, link.events);
    // Only the author's burst went through; the rest dropped without a strike.
    expect((toBob.seen.get('pen') ?? 0) - before).toBe(LAN_LIMITS.drawPerAuthor[1]);
    expect(strikes(link.events)).toEqual([]);
  });

  it('pen bodies stay under the 6 KB envelope cap, and a stroke past it stops growing', () => {
    const { w } = crew();
    const tol = toleranceM(16, QC[1]);
    // A long scribble: grows until the body cap, then penBody refuses to grow it.
    let last: SignedOp | undefined;
    let i = 2;
    for (; i < 2000; i += 10) {
      const pts = Array.from({ length: i }, (_, k) =>
        destination(QC, (k * 37) % 360, 40 + (k % 7) * 9),
      );
      const body = penBody({ id: 'big', sh: 'free', pts, style: { c: 0, w: 1, d: false } }, tol);
      if (body === null) break;
      last = w.root.stroke(T0 + i, body as never);
      expect(last).toBeDefined();
      expect(last!.bytes).toBeLessThanOrEqual(6 * 1024);
    }
    expect(i).toBeLessThan(2000);
    expect(last).toBeDefined();
  });
});
