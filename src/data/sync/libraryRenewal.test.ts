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

import { active, seed, sync, team, teamOf, type Phone } from './testing/libraryRig';
import type { Rig } from './testing/rig';
import { Rig as RigClass } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

const DAY = 24 * 60 * 60 * 1000;

/**
 * Move the clock by whole days as an app reopened later: the team on screen
 * renews its capability claims (as `activate` does at launch) and the LAN is
 * dialled again (links do not survive months of silence).
 */
async function days(rig: Rig, phones: Phone[], n: number): Promise<void> {
  rig.t += n * DAY;
  for (const p of phones) {
    await p.service.active?.stopMesh();
  }
  await rig.settle();
  for (const p of phones) p.service.active?.draw.advertise();
  for (const p of phones) await p.service.active?.startMesh();
  await rig.settle();
  for (const p of phones) p.service.active?.tick();
  await rig.settle();
}

/** A team that lasts until day 360 (teams outlive 14 days when their owner extends them). */
const TEAM_MS = 360 * DAY;

async function shared() {
  const rig = new RigClass();
  const { a, b } = await team(rig, { lifetimeMs: TEAM_MS });
  seed(a);
  const f = await a.bridge.shareFolder('gaspF', { team: active(a).teamId });
  if (typeof f === 'string') throw new Error(f);
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
      expect(n.replica.isActiveMember(active(a).me)).toBe(true);
      expect(n.replica.isActiveMember(active(b).me)).toBe(true);
      expect(p.bridge.recordOf(next)).toBeDefined();
      expect(p.bridge.recordOf(f.teamId)).toBeUndefined();
    }
    // The old owner is a manager in the successor (one owner per group).
    expect(a.service.host.open(next)!.replica.state.members.get(active(a).me)?.role).toBe('owner');
    expect(b.service.host.open(next)!.replica.state.members.get(active(b).me)?.role).toBe('member');
    expect(JSON.stringify(a.port.lib)).toBe(before.a);
    expect(JSON.stringify(b.port.lib)).toBe(before.b);

    // Past the old group's expiry (and the team's), edits still travel in the
    // successor, on whatever team link the two phones share now.
    await days(rig, [a, b], 70);
    await teamOf(rig, a, b, { name: 'Hiver', lifetimeMs: TEAM_MS });
    expect(rig.now()).toBeGreaterThan(f.replica.state.expiresAt);
    b.port.lib.waypoints[0]!.label = 'Refuge (an 2)';
    await sync(rig, [a, b]);
    expect(a.port.lib.waypoints.find((w) => w.id === 'w1')!.label).toBe('Refuge (an 2)');
    expect(a.port.lib.folders).toHaveLength(1);
    expect(b.port.lib.folders).toHaveLength(1);

    // The superseded group is forgotten a while after its expiry.
    await days(rig, [a, b], SUPERSEDED_KEEP_MS / DAY + 1);
    await teamOf(rig, a, b, { name: 'Printemps', lifetimeMs: TEAM_MS });
    await sync(rig, [a, b]);
    expect(libraries(a)).toEqual([next]);
    expect(libraries(b)).toEqual([next]);
  });

  it('an edit made in the old group after the copy is carried into the successor', async () => {
    const { rig, a, b, f } = await shared();
    // B is away when A renews; B edits in the old group meanwhile.
    await days(rig, [a, b], RENEW_OWNER_MS / DAY + 1);
    await active(b).stopMesh();
    await rig.settle();
    await a.bridge.runAll();
    const next = successorOf(f.replica.data(rig.now()))!;
    expect(next).toBeDefined();
    b.port.lib.waypoints[0]!.note = 'Roof leaks';
    await b.bridge.runAll();
    await active(b).startMesh();
    await rig.settle();
    active(a).tick();
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
    expect(f.setRole(active(b).me, 'admin')).toBeNull();
    await sync(rig, [a, b]);
    await days(rig, [a, b], 330);
    await active(a).stopMesh();
    await active(b).stopMesh();
    await rig.settle();
    await a.bridge.runAll();
    rig.t += 1000;
    await b.bridge.runAll();
    const mine = successorOf(f.replica.data(rig.now()));
    const fb = b.service.host.open(f.teamId)!;
    const theirs = successorOf(fb.replica.data(rig.now()));
    expect(mine).toBeDefined();
    expect(theirs).toBeDefined();
    expect(mine).not.toBe(theirs);
    await active(a).startMesh();
    await active(b).startMesh();
    await rig.settle();
    active(a).tick();
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
