/**
 * Receipts (#708) with 2.5.2 / 2.6.0 peers. As in `@core/teamdraw/compat.test`,
 * an "old" phone is the REAL code with the new kind unknown (`RECORD_KINDS`
 * without `rcp`), in an isolated module registry: its fold skips each receipt
 * as invalid, keeps every chain whole, and still reads the `cap.pen` claim
 * that now also carries `rc`.
 */
import type { SignedOp } from '@core/team/envelope';
import type { TeamReplica } from '@core/team/replica';
import { c, MIN, T0 } from '@core/team/testing/fixtures';
import { capBody, hasCap, PEN_CAP } from '@core/teamdraw/caps';
import { crew } from '@core/teamdraw/testUtils';

import { alertContext, alertFor } from './alerts';
import { receiptBody } from './receipts';

const OLD_KINDS = ['trl', 'tve', 'sos', 'rly', 'mres', 'drw', 'cap'];

function oldReplica(): {
  TeamReplica: typeof import('@core/team/replica').TeamReplica;
  alertFor: typeof alertFor;
  alertContext: typeof alertContext;
} {
  let out: ReturnType<typeof oldReplica> | undefined;
  jest.isolateModules(() => {
    jest.doMock('@core/team/records', () => ({
      ...jest.requireActual<object>('@core/team/records'),
      RECORD_KINDS: OLD_KINDS,
    }));
    /* eslint-disable @typescript-eslint/no-require-imports */
    const alerts = require('@core/teamui/alerts') as typeof import('@core/teamui/alerts');
    out = {
      TeamReplica: (require('@core/team/replica') as typeof import('@core/team/replica'))
        .TeamReplica,
      alertFor: alerts.alertFor,
      alertContext: alerts.alertContext,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return out!;
}

const envs = (r: TeamReplica, now: number) =>
  [...r.log.logged(), ...r.liveEphemeral(now)].map((op) => op.env);

describe('receipts with 2.6.0 peers (#708)', () => {
  const old = oldReplica();

  it('an old fold skips every rcp as invalid, keeps the chains, and reads the same everything else', () => {
    const { w, bob, eve, gus, rb, re, rg, sync } = crew();
    let now = T0 + MIN;
    const step = () => (now += 1000);
    rb.write(step(), 'e.set', capBody(bob.id, now));
    re.write(step(), 'e.set', { k: 'sos', id: 's1', f: { la: 46.81, lo: -71.21, tx: 'Ankle' } });
    rb.write(step(), 'e.set', { k: 'rly', id: 'r1', f: { la: 46.8, lo: -71.2 } });
    sync(step());
    const r1 = rb.write(step(), 'e.set', receiptBody({ kind: 'sos', owner: eve.id, id: 's1' }))!;
    const after = rb.write(step(), 'msg', { id: 'm1', th: 'team', tx: 'Coming' })!;
    const r2 = rg.write(step(), 'e.set', receiptBody({ kind: 'rly', owner: bob.id, id: 'r1' }))!;
    const r3 = re.write(step(), 'e.set', receiptBody({ kind: 'rly', owner: bob.id, id: 'r1' }))!;
    sync(step());
    const ops = envs(w.root, now);
    const oldOwner = new old.TeamReplica(c, w.teamId, w.root.keys);
    oldOwner.ingest(ops, now);
    const data = oldOwner.data(now);
    const skipped = new Map(data.skipped.map((s) => [s.id, s.why]));
    for (const op of [r1, r2, r3] as SignedOp[]) expect(skipped.get(op.id)).toBe('invalid');
    expect(data.entities.get(`msg:${bob.id}:m1`)).toBeDefined();
    expect(after.env.pv).toBe(r1.id);
    expect(oldOwner.versionVector()).toEqual(w.root.versionVector());
    expect(oldOwner.parkedSize).toBe(0);
    // Everything but the receipts folds the same, and alerts the same.
    const newData = w.root.data(now);
    const strip = (d: typeof data) =>
      [...d.entities.entries()]
        .filter(([, e]) => e.kind !== 'rcp')
        .map(([k, e]) => [k, e.state] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1));
    expect(strip(data)).toEqual(strip(newData));
    const alerts = (r: TeamReplica, fns: typeof old) => {
      const ctx = fns.alertContext(r.state, r.data(now));
      return r.log
        .logged()
        .map((op) => fns.alertFor(r.state, op, r.decode(op), gus.id, ctx))
        .filter((a) => a !== null)
        .sort((a, b) => (a.key < b.key ? -1 : 1));
    };
    expect(alerts(oldOwner as unknown as TeamReplica, old)).toEqual(
      alerts(w.root, { TeamReplica: old.TeamReplica, alertFor, alertContext }),
    );
    // The claim with rc is still a pen claim for the old phone.
    expect(hasCap(data, bob.id, now, PEN_CAP)).toBe(true);
    const claim = [...rb.log.logged()]
      .map((o) => rb.decode(o) as { k?: string } | undefined)
      .find((b) => b?.k === 'cap');
    expect(claim).toMatchObject({ k: 'cap', f: { pen: 1, v: 1, rc: 1 } });
  });
});
