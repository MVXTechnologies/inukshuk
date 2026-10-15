/**
 * Mixed versions across the sync-group seam (2.7.0 PR G1): 2.6.1 phones and
 * 2.7 phones in one team.
 *
 * The 2.6.1 phone is the REAL replica and session code with the data fold
 * swapped for the frozen 2.6.1 fold (`@core/team/testing/legacyFold26`), in
 * an isolated module registry. It must store, relay and skip every 2.7.0
 * kind (`gmeta`, `gref`, `irdv`, `net`) as `invalid`, keep every chain whole,
 * and fold everything else exactly as a 2.7 phone does; a session between
 * the two must carry them without a strike.
 */
import type { Json } from '@core/team/canonical';
import { emptyData, type TeamData } from '@core/team/data';
import type { SignedOp } from '@core/team/envelope';
import { decodeInvite, encodeInvite } from '@core/team/invite';
import { fromB64u, toB64u } from '@core/team/bytes';
import { GroupReplica, type TeamReplica } from '@core/team/replica';
import { SyncSession, type SessionEvent, type Step, type SyncStore } from '@core/team/sync';
import { canonicalText } from '@core/team/testing/golden/canon';
import { legacyApplyDataOp } from '@core/team/testing/legacyFold26';
import { c, device, MIN, T0 } from '@core/team/testing/fixtures';
import { crew } from '@core/teamdraw/testUtils';
import { GMETA, groupMeta } from '@core/group/meta';

import { GREF, IRDV, NET } from './groupKinds';
import { TEAM_KINDS_V26 } from './index';

interface Old {
  TeamReplica: typeof import('@core/team/replica').TeamReplica;
  SyncSession: typeof SyncSession;
}

/** The real modules with the 2.6.1 data fold. */
function v26(): Old {
  let out: Old | undefined;
  jest.isolateModules(() => {
    jest.doMock('@core/team/data', () => ({
      ...jest.requireActual<object>('@core/team/data'),
      applyDataOp: (o: TeamData, s: never, op: SignedOp, d: (op: SignedOp) => Json | undefined) =>
        legacyApplyDataOp(o, s, op, d),
    }));
    /* eslint-disable @typescript-eslint/no-require-imports */
    out = {
      TeamReplica: (require('@core/team/replica') as typeof import('@core/team/replica'))
        .TeamReplica,
      SyncSession: (require('@core/team/sync') as typeof import('@core/team/sync')).SyncSession,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return out!;
}

const envs = (r: TeamReplica, now: number) =>
  [...r.log.logged(), ...r.liveEphemeral(now)].map((op) => op.env);

const V26 = new Set(TEAM_KINDS_V26);

/** The canonical view without the 2.7.0 kinds and the ops that wrote them. */
function v26View(r: TeamReplica, now: number, newOps: ReadonlySet<string>): string {
  const data = r.data(now);
  const out = emptyData();
  for (const [k, rec] of data.entities) if (V26.has(rec.kind)) out.entities.set(k, rec);
  out.positions = data.positions;
  out.skipped = data.skipped.filter((s) => !newOps.has(s.id));
  out.index = data.index;
  return canonicalText(r.state, out);
}

const SEED = toB64u(new Uint8Array(32).fill(7));
const CHILD = 'AAAAAAAAAAAAAAAAAAAAAA';

/** A busy team where 2.7 phones also write every 2.7.0 kind, interleaved with team ops. */
function mixedTeam() {
  const t = crew();
  const { w, eve, rb, re, rg, sync } = t;
  let now = T0 + MIN;
  const step = () => (now += 1000);
  const v27: SignedOp[] = [];
  const team: SignedOp[] = [];
  const put = (list: SignedOp[], op: SignedOp | undefined) => {
    if (op === undefined) throw new Error('write refused');
    list.push(op);
  };
  put(v27, w.root.write(step(), 'e.set', { k: GMETA, id: 'g', f: { app: 'team', v: 1, net: 1 } }));
  put(team, rb.write(step(), 'msg', { id: 'm1', th: 'team', tx: 'Leaving', mn: [eve.id] }));
  put(v27, w.root.write(step(), 'e.set', { k: NET, id: 'g', f: { inet: 1 } }));
  put(v27, rb.write(step(), 'e.set', { k: GREF, id: CHILD, f: { app: 'lib', name: 'Maps' } }));
  // Bob's next op sits right after his gref in his chain.
  put(team, rb.write(step(), 'e.set', { k: 'wpt', id: 'w1', f: { name: 'Camp' } }));
  put(v27, w.root.write(step(), 'e.set', { k: IRDV, id: device().id, f: { s: SEED } }));
  put(team, re.write(step(), 'e.set', { k: 'sos', id: 's1', f: { la: 46.8, lo: -71.2 } }));
  put(team, rg.write(step(), 'msg', { id: 'g1', th: 'team', tx: 'Guest here' }));
  put(v27, rb.write(step(), 'e.del', { k: GREF, id: CHILD }));
  put(team, rb.write(step(), 'msg', { id: 'm2', th: 'team', tx: 'After the gref' }));
  rb.position(step(), { la: 46.8, lo: -71.2, at: now });
  sync(step());
  return { ...t, v27, team, now };
}

const strikes = (events: SessionEvent[]) => events.filter((e) => e.type === 'strike');

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

function connect(
  from: SyncStore,
  to: SyncStore,
  now: number,
  Initiator: typeof SyncSession,
  Responder: typeof SyncSession,
): Link {
  const { session: a, step } = Initiator.initiate(c, from);
  const b = Responder.respond(c, to);
  const link = { a, b, events: [] };
  pump(link, step, now);
  return link;
}

describe('2.6.1 ↔ 2.7 across the sync-group seam', () => {
  const old = v26();

  it('a 2.6.1 phone stores and skips every 2.7.0 kind as invalid, chains whole, all else equal', () => {
    const { w, eve, v27, team, now } = mixedTeam();
    const keys = w.replicas.get(eve.id)!.keys;
    const oldEve = new old.TeamReplica(c, w.teamId, keys);
    oldEve.ingest(envs(w.root, now), now);
    const newEve = w.replicas.get(eve.id)!;
    const ids = new Set(v27.map((op) => op.id));
    // Stored (and so served onwards), chains whole, nothing parked.
    for (const op of [...v27, ...team]) expect(oldEve.log.get(op.id)).toBeDefined();
    expect(oldEve.versionVector()).toEqual(newEve.versionVector());
    expect(oldEve.parkedSize).toBe(0);
    // Skipped as invalid by 2.6.1; folded by 2.7.
    const skipped = new Map(oldEve.data(now).skipped.map((s) => [s.id, s.why]));
    for (const op of v27) expect(skipped.get(op.id)).toBe('invalid');
    const folded = newEve.data(now);
    expect(folded.skipped.filter((s) => ids.has(s.id))).toEqual([]);
    expect(groupMeta(folded)).toMatchObject({ app: 'team', net: true });
    expect(folded.entities.get('net:g')).toBeDefined();
    // Everything a 2.6.1 phone knows reads the same on both, Bob's next ops included.
    expect(v26View(oldEve as unknown as TeamReplica, now, ids)).toBe(v26View(newEve, now, ids));
    const msgs = [...oldEve.data(now).entities.values()].filter((r) => r.kind === 'msg');
    expect(msgs.map((r) => r.id).sort()).toEqual(['g1', 'm1', 'm2']);
  });

  it('through a 2.6.1 relay, a 2.7 phone receives the 2.7.0 kinds intact and folds them', () => {
    const { w, eve, gus, rg, v27, now } = mixedTeam();
    const oldEve = new old.TeamReplica(c, w.teamId, w.replicas.get(eve.id)!.keys);
    oldEve.ingest(envs(w.root, now), now);
    // Gus's phone (2.7), reinstalled, only ever meets the 2.6.1 phone.
    const fresh = new GroupReplica(c, w.teamId, w.replicas.get(gus.id)!.keys);
    fresh.ingest(envs(oldEve as unknown as TeamReplica, now), now);
    for (const op of v27) expect(fresh.log.get(op.id)).toBeDefined();
    // The same view as Gus's phone that got everything first hand.
    expect(canonicalText(fresh.state, fresh.data(now))).toBe(canonicalText(rg.state, rg.data(now)));
    expect(groupMeta(fresh.data(now))).toMatchObject({ app: 'team', v: 1, net: true });
  });

  it('a session between a 2.6.1 phone and a 2.7 phone carries them both ways, no strike', () => {
    const { w, eve, rb, v27, now } = mixedTeam();
    // Eve on 2.6.1 has seen nothing since she joined; Bob (2.7) has it all.
    const oldEve = new old.TeamReplica(c, w.teamId, w.replicas.get(eve.id)!.keys);
    oldEve.ingest(envs(w.root, T0 + 5), T0 + 5);
    const there = connect(rb, oldEve as unknown as TeamReplica, now, SyncSession, old.SyncSession);
    expect(there.a.phase).toBe('open');
    expect(there.b.phase).toBe('open');
    for (const op of v27) expect(oldEve.log.get(op.id)).toBeDefined();
    expect(oldEve.versionVector()).toEqual(rb.versionVector());
    // And back: a fresh 2.7 phone of Bob's catches up from the 2.6.1 phone.
    const newBob = new GroupReplica(c, w.teamId, rb.keys);
    newBob.ingest(envs(w.root, T0 + 5), T0 + 5);
    const back = connect(
      oldEve as unknown as TeamReplica,
      newBob,
      now + 1000,
      old.SyncSession,
      SyncSession,
    );
    expect(back.a.phase).toBe('open');
    expect(back.b.phase).toBe('open');
    for (const op of v27) expect(newBob.log.get(op.id)).toBeDefined();
    expect(newBob.data(now + 1000).entities.get('net:g')).toBeDefined();
    expect(strikes([...there.events, ...back.events])).toEqual([]);
  });

  it('a 2.6.1 phone refuses an invite token carrying a flag bit it does not know', () => {
    // 2.7 marks invites to non-team groups with a reserved flags bit (design §3.2):
    // a 2.6.1 phone must refuse the token, never join a folder as an empty team.
    const token = { teamId: CHILD, seed: new Uint8Array(16).fill(3), expiresAt: T0 + 3600_000 };
    const payload = encodeInvite(token, 'sms');
    expect(decodeInvite(payload)).toBeDefined();
    const bytes = fromB64u(payload)!;
    for (const bit of [1, 2, 4, 6, 7]) {
      const flagged = bytes.slice();
      flagged[1] = flagged[1]! | (1 << bit);
      expect(decodeInvite(toB64u(flagged))).toBeUndefined();
    }
  });
});
