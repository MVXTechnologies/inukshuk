import type { TeamState } from '@core/team/membership';

import { CURSOR_ID, LNX } from './kinds';
import { partBodies } from './parts';
import {
  RENEW_MANAGER_MS,
  RENEW_OWNER_MS,
  renewDue,
  snapshotBodies,
  successorMembers,
  successorOf,
} from './renewal';
import { gid, LibSim, mid, MIN, OWNER, T0 } from './testUtils';
import { newFolder, newItem, trash } from './writes';

const MG = mid('mg');
const ED = mid('ed');
const DAY = 24 * 60 * MIN;
const at = (n: number) => T0 + n * MIN;

function state(over: Partial<TeamState> = {}): TeamState {
  const members = new Map([
    [OWNER, { id: OWNER, role: 'owner', status: 'active', x: 'xo' }],
    [MG, { id: MG, role: 'admin', status: 'active', x: 'xm' }],
    [ED, { id: ED, role: 'member', status: 'active', x: 'xe' }],
    [mid('gone'), { id: mid('gone'), role: 'member', status: 'removed', x: 'xg' }],
  ]);
  return {
    members,
    genesis: { stamp: { wall: T0, counter: 0, author: OWNER } },
    expiresAt: T0 + 365 * DAY,
    ...over,
  } as unknown as TeamState;
}

describe('renewal', () => {
  it('the owner renews from day 300, other managers from day 320, editors never', () => {
    const s = state();
    expect(renewDue(s, OWNER, T0 + RENEW_OWNER_MS - 1)).toBe(false);
    expect(renewDue(s, OWNER, T0 + RENEW_OWNER_MS)).toBe(true);
    expect(renewDue(s, MG, T0 + RENEW_OWNER_MS)).toBe(false);
    expect(renewDue(s, MG, T0 + RENEW_MANAGER_MS)).toBe(true);
    expect(renewDue(s, ED, T0 + RENEW_MANAGER_MS)).toBe(false);
    // Too late: the old group no longer takes the successor's name.
    expect(renewDue(s, OWNER, T0 + 366 * DAY)).toBe(false);
    expect(
      renewDue(
        state({ closedAt: { wall: T0, counter: 0, author: OWNER } }),
        OWNER,
        T0 + RENEW_OWNER_MS,
      ),
    ).toBe(false);
  });

  it('the successor keeps everyone at their role; the old owner becomes a manager', () => {
    expect(successorMembers(state(), MG).map((m) => [m.id, m.role])).toEqual(
      [
        [OWNER, 'admin'],
        [ED, 'member'],
      ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    );
  });

  it('copies live folders, items (trash included) and trail parts, marked as copies', () => {
    const sim = new LibSim({ [ED]: 'member', [MG]: 'admin' });
    sim.meta(at(0), 'gasp');
    sim.set(OWNER, at(1), newFolder('gasp', 'Gaspésie'));
    sim.set(OWNER, at(2), newItem('w1', 'wpt', 'Refuge', 'gasp', { ll: [-66, 48] }));
    sim.set(OWNER, at(3), newItem('w2', 'wpt', 'Old', 'gasp', { ll: [-66, 48] }));
    sim.set(OWNER, at(4), trash(sim.look(OWNER).history, OWNER, 'lit', 'w2'));
    for (const p of partBodies('t1', 'rev1', 'A' + '?'.repeat(30))) sim.set(ED, at(5), p);
    const bodies = snapshotBodies(sim.fold());
    expect(bodies.map((b) => `${b.k}:${b.id}`)).toEqual([
      'lfo:gasp',
      'lit:w1',
      'lit:w2',
      'lpt:rev1_0',
    ]);
    expect(bodies[2]!.f).toMatchObject({ rm: 1, cp: 1, n: 'Old' });
    expect(bodies[3]!.f['cp']).toBeUndefined();
    expect(bodies.every((b) => b.f['b'] === undefined)).toBe(true);
  });

  it('lnx is a manager’s, one record that every phone reads the same way', () => {
    const sim = new LibSim({ [ED]: 'member', [MG]: 'admin' });
    sim.meta(at(0), 'gasp');
    const bad = sim.set(ED, at(1), { k: LNX, id: CURSOR_ID, f: { g: gid('x') } });
    expect(sim.why(bad.id)).toBe('forbidden');
    sim.set(OWNER, at(2), { k: LNX, id: CURSOR_ID, f: { g: gid('one') } });
    sim.set(MG, at(3), { k: LNX, id: CURSOR_ID, f: { g: gid('two') } });
    expect(successorOf(sim.fold())).toBe(gid('two'));
    const del = sim.del(OWNER, at(4), { k: LNX, id: CURSOR_ID });
    expect(sim.why(del.id)).toBe('forbidden');
    expect(successorOf(sim.fold([...sim.ops.keys()].slice(0, 2)))).toBeUndefined();
  });
});
