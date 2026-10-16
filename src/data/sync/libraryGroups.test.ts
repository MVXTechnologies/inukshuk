/**
 * Share live's group side (2.7.0 G10, #712), owner decision 2026-10-16: a
 * shared folder is its own group, apart from team mode. On the rig's manual
 * queue, clock and timers, with **no team on either phone**:
 *
 * - sharing makes the folder's own group: internet on (its own relay room),
 *   its own `lnk`/`rtc` claims, never on the team screens;
 * - the folder's own invite (flag bit 1) is joined nearby: the LAN advertises
 *   the folder, the join never makes it the active team, and the link
 *   upgrades to the mux on the folder's own claims;
 * - leaving forgets it; stopping ends it everywhere.
 */
import { groupMeta, internetOn } from '@core/group/meta';
import { LINK_CAP, RTC_CAP } from '@core/team/sync';

import { active, meOf, pair, seed, shareJoin, sync, teamOf } from './testing/libraryRig';
import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

async function shared() {
  const rig = new Rig();
  const { a, b } = pair(rig);
  seed(a);
  const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
  return { rig, a, b, f };
}

describe('Share live groups, apart from teams (2.7.0 G10)', () => {
  it('a shared folder is its own group: internet on, its own claims, no team anywhere', async () => {
    const { rig, a, b, f } = await shared();
    const data = f.replica.data(rig.now());
    expect(groupMeta(data)).toMatchObject({ app: 'lib', root: 'gaspF', net: true });
    expect(groupMeta(data).parent).toBeUndefined();
    expect(internetOn(data)).toBe(true);
    for (const p of [a, b]) {
      expect(p.service.teams).toEqual([]);
      expect(p.service.active).toBeNull();
      expect(p.service.host.libraries.map((r) => r.teamId)).toEqual([f.teamId]);
    }
    // Both claim the link mux and WebRTC in the folder itself.
    const now = rig.now();
    expect(f.replica.canReceive(meOf(b, f.teamId), LINK_CAP, now)).toBe(true);
    expect(f.replica.canReceive(meOf(b, f.teamId), RTC_CAP, now)).toBe(true);
  });

  it('joined by its own invite, nearby, with the link upgraded on the folder’s claims', async () => {
    const { rig, a, b, f } = await shared();
    const bf = b.service.host.open(f.teamId)!;
    expect(bf.record.app).toBe('lib');
    expect(bf.replica.state.members.get(meOf(b, f.teamId))?.role).toBe('member');
    expect(b.port.names('waypoints')).toEqual(['Refuge']);
    const links = a.service.host.links();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ framing: 'mux', state: 'open', groups: [f.teamId] });
    // Edits flow both ways with no team at all.
    b.port.lib.waypoints[0]!.label = 'Refuge (fermé)';
    await sync(rig, [a, b]);
    expect(a.port.names('waypoints')).toEqual(['Refuge (fermé)']);
  });

  it('an invite that only lets people view', async () => {
    const rig = new Rig();
    const { a, b } = pair(rig);
    seed(a);
    const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }), {
      role: 'guest',
    });
    expect(b.service.host.open(f.teamId)!.myRole).toBe('guest');
    // A viewer writes nothing: a change on their phone is put back, a delete restored.
    const ops = b.service.host.open(f.teamId)!.replica.writer.cursor.seq;
    b.port.lib.waypoints[0]!.label = 'Nope';
    await sync(rig, [a, b]);
    expect(a.port.names('waypoints')).toEqual(['Refuge']);
    expect(b.port.names('waypoints')).toEqual(['Refuge']);
    b.port.lib.areas = [];
    await sync(rig, [a, b]);
    expect(b.port.names('areas')).toEqual(['Bleuets']);
    expect(a.port.names('areas')).toEqual(['Bleuets']);
    expect(b.service.host.open(f.teamId)!.replica.writer.cursor.seq).toBe(ops);
  });

  it('leaving forgets the folder; stopping ends it on every phone', async () => {
    const { rig, a, b, f } = await shared();
    await b.groups.leave(f.teamId);
    expect(b.service.host.open(f.teamId)).toBeUndefined();
    await sync(rig, [a, b]);
    expect(b.service.host.libraries).toEqual([]);

    const two = await shared();
    expect(await two.a.groups.stop(two.f.teamId)).toBeNull();
    await two.rig.settle();
    const ended = await two.b.groups.scan();
    expect(ended).toEqual([{ groupId: two.f.teamId, why: 'stopped' }]);
  });

  it('a non-folder invite is refused by the folder join', async () => {
    const { b } = pair(new Rig());
    await expect(
      b.groups.startJoin({ teamId: 'A'.repeat(22), seed: new Uint8Array(16), expiresAt: 1 }, 'x'),
    ).rejects.toThrow('not-a-folder');
  });

  it('a team that expired does not strand a folder: link claims count in any shared group', async () => {
    const { rig, a, b, f } = await shared();
    // The two then start a team (14 days): the LAN runs for it, the folder rides its link.
    await teamOf(rig, a, b);
    // A month of meeting every few days (the app reopened each time): the team
    // expires on day 14, so its claims can no longer be renewed, while the LAN
    // still runs for it. The folder's own claims keep upgrading the link.
    const DAY = 24 * 60 * 60 * 1000;
    for (let day = 0; day < 30; day += 3) {
      for (const p of [a, b]) await active(p).stopMesh();
      await rig.settle();
      rig.t += 3 * DAY;
      for (const p of [a, b]) await p.groups.scan();
      for (const p of [a, b]) await active(p).startMesh();
      await rig.settle();
      a.service.host.tick();
      await rig.settle();
      await sync(rig, [a, b]);
    }
    expect(rig.now()).toBeGreaterThan(active(a).replica.state.expiresAt);
    const teamClaim = active(a).replica.canReceive(meOf(b, f.teamId), LINK_CAP, rig.now());
    expect(teamClaim).toBe(false);
    expect(a.service.host.links()[0]).toMatchObject({ framing: 'mux' });
    b.port.lib.waypoints[0]!.label = 'Refuge (un mois après)';
    await sync(rig, [a, b]);
    expect(a.port.names('waypoints')).toEqual(['Refuge (un mois après)']);
    expect(f.replica.canReceive(meOf(b, f.teamId), LINK_CAP, rig.now())).toBe(true);
  });
});
