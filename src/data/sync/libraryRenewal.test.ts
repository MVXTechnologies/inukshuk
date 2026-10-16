/**
 * Renewal across the group's year (2.7.0 G10, #712), in fake time on the
 * rig: a shared folder outlives the 365-day lifetime of its sync group. The
 * owner's phone rolls it forward on day 300; the teammate's phone follows
 * `lnx`, picks the successor up through the old folder's link, and its
 * Library is untouched (no duplicates, no loss); edits keep flowing past the
 * old group's expiry; an edit made in the old group after the copy survives;
 * two managers renewing at once end with one successor everywhere.
 */
import { RENEW_OWNER_MS, SUPERSEDED_KEEP_MS, successorOf } from '@core/domains/library/renewal';

import {
  meOf,
  offline,
  online,
  pair,
  seed,
  shareJoin,
  sync,
  type Phone,
} from './testing/libraryRig';
import type { Rig } from './testing/rig';
import { Rig as RigClass } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

const DAY = 24 * 60 * 60 * 1000;

/** Move the clock by whole days as an app reopened later: the LAN goes and comes back. */
async function days(rig: Rig, phones: Phone[], n: number): Promise<void> {
  for (const p of phones) await offline(rig, p);
  rig.t += n * DAY;
  for (const p of phones) await online(rig, p);
  for (const p of phones) p.service.host.tick();
  await rig.settle();
}

async function shared() {
  const rig = new RigClass();
  const { a, b } = pair(rig);
  seed(a);
  const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
  await sync(rig, [a, b]);
  return { rig, a, b, f };
}

const libraries = (p: Phone) => p.service.host.libraries.map((r) => r.teamId);

describe('Share live renewal (2.7.0 G10)', () => {
  it('rolls a folder forward before its year is up; Libraries stay as they were', async () => {
    const { rig, a, b, f } = await shared();
    const before = { a: JSON.stringify(a.port.lib), b: JSON.stringify(b.port.lib) };
    await days(rig, [a, b], RENEW_OWNER_MS / DAY - 1);
    await sync(rig, [a, b]);
    expect(successorOf(f.replica.data(rig.now()))).toBeUndefined();

    await days(rig, [a, b], 2);
    await sync(rig, [a, b]);
    const next = successorOf(f.replica.data(rig.now()))!;
    expect(next).toBeDefined();
    // Both phones joined the successor, and their bridges moved there.
    for (const p of [a, b]) {
      const n = p.service.host.open(next)!;
      expect(n.pickupParent()).toBeUndefined();
      expect(n.replica.isActiveMember(meOf(a, f.teamId))).toBe(true);
      expect(n.replica.isActiveMember(meOf(b, f.teamId))).toBe(true);
      expect(p.bridge.recordOf(next)).toBeDefined();
      expect(p.bridge.recordOf(f.teamId)).toBeUndefined();
    }
    // The old owner is a manager in the successor (one owner per group).
    expect(a.service.host.open(next)!.replica.state.members.get(meOf(a, f.teamId))?.role).toBe(
      'owner',
    );
    expect(b.service.host.open(next)!.replica.state.members.get(meOf(b, f.teamId))?.role).toBe(
      'member',
    );
    expect(JSON.stringify(a.port.lib)).toBe(before.a);
    expect(JSON.stringify(b.port.lib)).toBe(before.b);

    // Past the old group's expiry, edits still travel in the successor, on its
    // own link (no team anywhere).
    await days(rig, [a, b], 70);
    expect(rig.now()).toBeGreaterThan(f.replica.state.expiresAt);
    b.port.lib.waypoints[0]!.label = 'Refuge (an 2)';
    await sync(rig, [a, b]);
    expect(a.port.lib.waypoints.find((w) => w.id === 'w1')!.label).toBe('Refuge (an 2)');
    expect(a.port.lib.folders).toHaveLength(1);
    expect(b.port.lib.folders).toHaveLength(1);

    // The superseded group is forgotten a while after its expiry.
    await days(rig, [a, b], SUPERSEDED_KEEP_MS / DAY + 1);
    await sync(rig, [a, b]);
    expect(libraries(a)).toEqual([next]);
    expect(libraries(b)).toEqual([next]);
  });

  it('an edit made in the old group after the copy is carried into the successor', async () => {
    const { rig, a, b, f } = await shared();
    // B is away when A renews; B edits in the old group meanwhile.
    await days(rig, [a, b], RENEW_OWNER_MS / DAY + 1);
    await offline(rig, b);
    await rig.settle();
    await a.bridge.runAll();
    const next = successorOf(f.replica.data(rig.now()))!;
    expect(next).toBeDefined();
    b.port.lib.waypoints[0]!.note = 'Roof leaks';
    await b.bridge.runAll();
    await online(rig, b);
    await rig.settle();
    a.service.host.tick();
    await rig.settle();
    await sync(rig, [a, b]);
    expect(b.bridge.recordOf(next)).toBeDefined();
    expect(a.port.lib.waypoints.find((w) => w.id === 'w1')!.note).toBe('Roof leaks');
    expect(a.port.lib.waypoints).toHaveLength(1);
    expect(b.port.lib.waypoints).toHaveLength(1);
  });

  it('two managers renewing at once end with one successor on every phone', async () => {
    const { rig, a, b, f } = await shared();
    // B becomes a manager; both renew while apart.
    expect(f.setRole(meOf(b, f.teamId), 'admin')).toBeNull();
    await sync(rig, [a, b]);
    await offline(rig, a);
    await offline(rig, b);
    rig.t += 330 * DAY;
    // Each renews while the other is out of reach.
    await a.bridge.runAll();
    await offline(rig, a);
    rig.t += 1000;
    await b.bridge.runAll();
    await offline(rig, b);
    const mine = successorOf(f.replica.data(rig.now()));
    const fb = b.service.host.open(f.teamId)!;
    const theirs = successorOf(fb.replica.data(rig.now()));
    expect(mine).toBeDefined();
    expect(theirs).toBeDefined();
    expect(mine).not.toBe(theirs);
    await online(rig, a);
    await online(rig, b);
    await rig.settle();
    a.service.host.tick();
    await rig.settle();
    await sync(rig, [a, b]);
    await sync(rig, [a, b]);
    const winA = successorOf(f.replica.data(rig.now()));
    const winB = successorOf(fb.replica.data(rig.now()));
    expect(winA).toBe(winB);
    for (const p of [a, b]) {
      expect(p.bridge.recordOf(winA!)).toBeDefined();
      expect(p.port.lib.folders).toHaveLength(1);
      expect(p.port.lib.waypoints).toHaveLength(1);
    }
    // The loser was closed by its creator.
    const loser = winA === mine ? theirs! : mine!;
    const holder = winA === mine ? b : a;
    expect(holder.service.host.open(loser)?.replica.state.closedAt ?? 'gone').toBeDefined();
  });
});
