/**
 * Share live as the screens see it (2.7.0 G10, #712): the folder summaries
 * (joining, header, people, row notes), conflict review with Use this, the
 * trash and Restore, roles and removal, on two phones over the rig.
 */
import { LiveFolders } from './liveFolders';
import { meOf, offline, online, pair, seed, shareJoin, sync } from './testing/libraryRig';
import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

async function shared() {
  const rig = new Rig();
  const { a, b } = pair(rig);
  seed(a);
  const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
  const la = new LiveFolders(a.bridge, a.groups, rig.now);
  const lb = new LiveFolders(b.bridge, b.groups, rig.now);
  return { rig, a, b, f, la, lb };
}

const text = (l: { parts: { t: string }[] }) => l.parts.map((p) => p.t).join('');

describe('live folders (2.7.0 G10)', () => {
  it('the header, people and row notes on both phones', async () => {
    const { rig, a, b, f, la, lb } = await shared();
    await sync(rig, [a, b]);
    const [fa] = la.list();
    expect(fa).toMatchObject({
      groupId: f.teamId,
      joining: false,
      isOwner: true,
      canManage: true,
      local: { kind: 'folder', id: 'gaspF' },
      peopleSummary: '2 can edit',
      subtitle: 'Live · yours',
    });
    expect(fa!.people.map((p) => p.name)).toEqual(['You', 'Julie']);
    expect(fa!.line.tone).toBe('ok');
    const [fb] = lb.list();
    expect(fb!.subtitle).toBe('Live · from Marc');
    expect(fb!.isOwner).toBe(false);
    expect(fb!.canManage).toBe(false);
    const wb = b.port.lib.waypoints[0]!;
    expect(fb!.notes.get(`waypoint:${wb.id}`)?.text).toMatch(/^Added by Marc/);
  });

  it('a conflict is reviewed with Use this; a delete is restored from the trash', async () => {
    const { rig, a, b, f, la } = await shared();
    await sync(rig, [a, b]);
    // Both rename the waypoint while apart.
    await offline(rig, a);
    await offline(rig, b);
    await rig.settle();
    a.port.lib.waypoints[0]!.label = 'Refuge A';
    b.port.lib.waypoints[0]!.label = 'Refuge B';
    await a.bridge.runAll();
    rig.advance(1000);
    await b.bridge.runAll();
    await online(rig, a);
    await online(rig, b);
    await rig.settle();
    await sync(rig, [a, b]);
    expect(la.list()[0]!.toReview).toBe(1);
    const c = la.conflict(f.teamId, 'lit', 'w1')!;
    expect(c.conflicts).toHaveLength(1);
    expect(c.conflicts[0]!.kept.value).toBe('Refuge B');
    expect(c.conflicts[0]!.others[0]).toMatchObject({ value: 'Refuge A', who: 'You' });
    expect(la.activity(f.teamId)!.pinned.map(text)).toEqual([
      'Julie and You both renamed Refuge B',
    ]);
    expect(la.keepVersion(f.teamId, 'lit', 'w1', 'n', 'Refuge A')).toBeNull();
    await sync(rig, [a, b]);
    expect(b.port.names('waypoints')).toEqual(['Refuge A']);
    expect(la.conflict(f.teamId, 'lit', 'w1')!.conflicts).toEqual([]);
    la.markSeen(f.teamId);
    expect(la.list()[0]!.toReview).toBe(0);

    // Deleted on B, restored from A's Recently deleted.
    b.port.lib.areas = [];
    await sync(rig, [a, b]);
    expect(a.port.lib.areas).toEqual([]);
    expect(la.trash(f.teamId).map((e) => [e.node.name, e.by])).toEqual([['Bleuets', 'Julie']]);
    expect(la.list()[0]!.trashCount).toBe(1);
    expect(la.restore(f.teamId, 'lit', 'a1')).toBeNull();
    await sync(rig, [a, b]);
    expect(a.port.names('areas')).toEqual(['Bleuets']);
    expect(b.port.names('areas')).toEqual(['Bleuets']);
    const lines = la.activity(f.teamId)!.days.flatMap((d) => d.lines.map(text));
    expect(lines).toContain('Julie deleted Bleuets');
    expect(lines).toContain('You restored Bleuets');
    expect(lines[lines.length - 1]).toBe('You shared this folder');
  });

  it('a manager changes a role and removes someone, who keeps a copy', async () => {
    const { rig, a, b, f, la } = await shared();
    await sync(rig, [a, b]);
    const julie = meOf(b, f.teamId);
    expect(la.setRole(f.teamId, julie, 'guest')).toBeNull();
    expect(la.list()[0]!.peopleSummary).toBe('1 can edit · 1 can view');
    expect(la.remove(f.teamId, julie)).toBeNull();
    await sync(rig, [a, b]);
    expect(b.service.host.open(f.teamId)).toBeUndefined();
    expect(b.port.names('waypoints')).toEqual(['Refuge']);
    await sync(rig, [a, b]);
    expect(la.list()[0]!.people.map((p) => p.name)).toEqual(['You']);
  });

  it('a change no other phone has yet reads "Not sent yet"; it clears once delivered', async () => {
    const { rig, a, b, la } = await shared();
    await sync(rig, [a, b]);
    expect(la.list()[0]!.line.text).toMatch(/^Synced/);
    await offline(rig, b);
    await rig.settle();
    a.port.lib.waypoints[0]!.label = 'Refuge (fermé)';
    await a.bridge.runAll();
    const [f] = la.list();
    expect(f!.notes.get('waypoint:w1')).toEqual({
      text: 'Not sent yet · renamed by you',
      conflict: false,
      pending: true,
    });
    expect(f!.line).toMatchObject({ tone: 'wait' });
    expect(f!.line.text).toMatch(/waiting$/);
    await online(rig, b);
    await rig.settle();
    a.service.host.tick();
    await rig.settle();
    await sync(rig, [a, b]);
    expect(la.list()[0]!.notes.get('waypoint:w1')).toBeUndefined();
    expect(la.list()[0]!.line.tone).toBe('ok');
  });
});
