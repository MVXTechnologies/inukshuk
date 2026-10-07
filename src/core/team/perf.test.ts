/**
 * Performance budget (review M2): 500 members, a 20k-op log, positions at
 * 50/s. Measured with the Node crypto double (OpenSSL verify); Hermes + noble
 * is slower per signature (see docs/design/team-protocol.md §Performance).
 */
import { performance } from 'node:perf_hooks';

import { addMemberBody, OpWriter, targetOf } from './actions';
import { checkEnvelope, type SignedOp } from './envelope';
import { TeamReplica } from './replica';
import { c, device, MIN, newWorld, T0, type Device } from './testing/fixtures';
import { nobleCrypto } from './testing/noble';

/** 500 members including the owner (`MAX_MEMBERS`). */
const MEMBERS = 499;
const OPS = 20_000;
const WRITERS = 40;
const BATCH = 200;

jest.setTimeout(120_000);

describe('performance budget (M2)', () => {
  it('ingests a 500-member, 20k-op team with no rebuilds and serves data() incrementally', () => {
    const w = newWorld();
    const members: Device[] = [];
    const t0 = performance.now();
    const key = w.root.sendKey()!;
    for (let i = 0; i < MEMBERS; i++) {
      const d = device();
      members.push(d);
      w.root.control(T0 + i + 1, 'm.add', addMemberBody(c, w.teamId, targetOf(d), 'member', key));
    }
    const addMs = (performance.now() - t0) / MEMBERS;

    // 20k data ops from 40 members, interleaved in time (as a session delivers them).
    const writers = members.slice(0, WRITERS).map((d) => new OpWriter(c, d.keys, w.teamId));
    const enc = { mode: 'group' as const, ...key };
    const ops: SignedOp[] = [];
    for (let i = 0; i < OPS; i++) {
      const wr = writers[i % WRITERS]!;
      ops.push(
        wr.data(T0 + MIN + i * 10, 'e.set', { k: 'point', id: `p${i % 2000}`, f: { n: i } }, enc),
      );
    }

    // A fresh member device receives the membership log, then the data in frames.
    const me = members[WRITERS]!;
    const r = new TeamReplica(c, w.teamId, me.keys);
    r.ingest(
      w.root.log.logged().map((o) => o.env),
      T0 + MIN,
    );
    expect(r.isActiveMember(me.id)).toBe(true);
    expect(r.state.needsRotation).toBe(false);
    const foldsBefore = r.fullFolds;
    const t1 = performance.now();
    for (let i = 0; i < OPS; i += BATCH) {
      r.ingest(
        ops.slice(i, i + BATCH).map((o) => o.env),
        T0 + 2 * OPS * 10,
      );
    }
    const ingestMs = (performance.now() - t1) / OPS;
    expect(r.state.data).toHaveLength(OPS);
    // Primary assertion: in-order data is appended incrementally, never rebuilt.
    expect(r.fullFolds).toBe(foldsBefore);

    const t2 = performance.now();
    const firstData = r.data().entities.size;
    const dataFullMs = performance.now() - t2;

    // Positions: 50/s from 500 members for 10 s, one at a time.
    const posWriters = members.map((d) => new OpWriter(c, d.keys, w.teamId));
    const pos = Array.from({ length: MEMBERS }, (_, i) =>
      posWriters[i]!.ephemeral(T0 + 3 * OPS * 10 + i * 20, {
        t: 'pos',
        secret: { la: 46.8, lo: -71.2, at: T0 },
        enc,
        ttl: 3600,
      }),
    );
    const foldsAtPositions = r.fullFolds;
    const t3 = performance.now();
    for (const p of pos) r.ingest([p.env], T0 + 3 * OPS * 10 + 10_000);
    const posMs = (performance.now() - t3) / pos.length;

    // First read after 500 new positions decrypts them once.
    const t35 = performance.now();
    r.data(T0 + 4 * OPS * 10);
    const posReadMs = performance.now() - t35;

    // One more appended op, then data(): incremental, not a rebuild.
    const more = writers[0]!.data(
      T0 + 4 * OPS * 10,
      'e.set',
      { k: 'point', id: 'new', f: { n: 1 } },
      enc,
    );
    // Positions never touch the membership fold.
    expect(r.fullFolds).toBe(foldsAtPositions);
    const t4 = performance.now();
    r.ingest([more.env], T0 + 4 * OPS * 10);
    const appendMs = performance.now() - t4;
    const t5 = performance.now();
    const view = r.data(T0 + 4 * OPS * 10);
    const dataIncMs = performance.now() - t5;
    expect(view.entities.size).toBe(firstData + 1);
    // An append extends the data view in place: no refold, same cached object.
    expect(r.fullFolds).toBe(foldsAtPositions);
    expect(view).toBe(r.data(T0 + 4 * OPS * 10));
    expect(view.positions.size).toBe(MEMBERS);

    // The shipped implementation: admission (canonical JSON + SHA-256 + strict Ed25519) with noble.
    const sample = ops.slice(0, 300);
    const t6 = performance.now();
    for (const o of sample) {
      expect(
        checkEnvelope(nobleCrypto, o.env, { teamId: w.teamId, now: T0 + 2 * OPS * 10 }).ok,
      ).toBe(true);
    }
    const nobleMs = (performance.now() - t6) / sample.length;

    console.log(
      `team perf: noble admission ${nobleMs.toFixed(2)} ms/op (Node JIT; Hermes is slower) · ` +
        `(Node, OpenSSL double): m.add ${addMs.toFixed(3)} ms/op · ` +
        `ingest ${ingestMs.toFixed(3)} ms/op over ${OPS} ops · position ${posMs.toFixed(3)} ms/op · ` +
        `append+fold ${appendMs.toFixed(2)} ms · data() full ${dataFullMs.toFixed(0)} ms, ` +
        `first read after 500 positions ${posReadMs.toFixed(1)} ms, incremental ${dataIncMs.toFixed(2)} ms`,
    );
    // Wall-clock: generous ceilings only (measured locally 0.13 ms/op, 0.13 ms,
    // 0.3 ms, < 0.1 ms). They still catch a per-op rebuild, which costs tens of
    // ms per op at this log size, while a loaded 2-core runner never trips them.
    expect(ingestMs).toBeLessThan(10);
    expect(posMs).toBeLessThan(10);
    expect(appendMs).toBeLessThan(100);
    expect(dataIncMs).toBeLessThan(100);
  });
});
