/**
 * The library bridge end to end (2.7.0 G10, #712): two phones of one team,
 * each with its own Library (an in-memory port applying the same `SyncEdit`
 * the store applies), over the loopback mesh on the rig.
 */
import { active, seed, sync, team } from './testing/libraryRig';
import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

describe('library bridge (2.7.0 G10)', () => {
  it('shares a folder with the team; a teammate gets it in their Library', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    seed(a);
    const f = await a.bridge.shareFolder('gaspF', { team: active(a).teamId });
    if (typeof f === 'string') throw new Error(f);
    expect(a.bridge.markOf('folder', 'gaspF')).toEqual({ groupId: f.teamId, root: true });
    expect(a.bridge.markOf('waypoint', 'w1')).toEqual({ groupId: f.teamId, root: false });
    await sync(rig, [a, b]);

    const bf = b.port.lib.folders.find((x) => x.name === 'Gaspésie 2026');
    expect(bf).toBeDefined();
    expect(b.port.names('waypoints')).toEqual(['Refuge']);
    expect(b.port.names('areas')).toEqual(['Bleuets']);
    expect(b.port.names('tracks')).toEqual(['Mont Albert']);
    const placed: readonly { folderId?: string }[] = [
      ...b.port.lib.waypoints,
      ...b.port.lib.areas,
      ...b.port.lib.tracks,
    ];
    expect(placed.every((x) => x.folderId === bf!.id)).toBe(true);
    // Photos stay on their phone; the catalog map waits for its download.
    expect(b.port.lib.waypoints[0]!.photoUri).toBeUndefined();
    expect(b.bridge.waiting(f.teamId)).toEqual(['m1']);
    // Quiet once in step: no more Library writes on either side.
    const applied = [a.port.applied, b.port.applied];
    await sync(rig, [a, b]);
    expect([a.port.applied, b.port.applied]).toEqual(applied);
  });

  it('edits and deletes travel both ways, local-only fields stay', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    seed(a);
    const f = await a.bridge.shareFolder('gaspF', { team: active(a).teamId });
    if (typeof f === 'string') throw new Error(f);
    await sync(rig, [a, b]);
    // B renames the waypoint and adds one.
    const bw = b.port.lib.waypoints[0]!;
    b.port.lib.waypoints = [
      { ...bw, label: 'Refuge (fermé)', note: 'Roof leaks' },
      {
        id: 'bw2',
        latitude: 48.93,
        longitude: -66.15,
        label: 'Source',
        folderId: bw.folderId,
        createdAt: 2,
      },
    ];
    await sync(rig, [a, b]);
    expect(a.port.names('waypoints')).toEqual(['Refuge (fermé)', 'Source']);
    const aw = a.port.lib.waypoints.find((w) => w.id === 'w1')!;
    expect(aw).toMatchObject({
      note: 'Roof leaks',
      photoUri: 'file:///a/photo.jpg',
      folderId: 'gaspF',
    });
    // A deletes the area: gone on B too, and in the group's trash.
    a.port.lib.areas = [];
    await sync(rig, [a, b]);
    expect(b.port.lib.areas).toEqual([]);
  });

  it('leaving keeps a copy as a normal folder; removing it frees the Library', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    seed(a);
    const f = await a.bridge.shareFolder('gaspF', { team: active(a).teamId });
    if (typeof f === 'string') throw new Error(f);
    await sync(rig, [a, b]);
    await b.bridge.leave(f.teamId);
    expect(b.port.names('folders')).toEqual(['Gaspésie 2026']);
    expect(b.port.names('waypoints')).toEqual(['Refuge']);
    expect(b.bridge.markOf('folder', b.port.lib.folders[0]!.id)).toBeUndefined();
    // A's later edits no longer reach B.
    a.port.lib.waypoints[0]!.label = 'Renamed later';
    await sync(rig, [a, b]);
    expect(b.port.names('waypoints')).toEqual(['Refuge']);
  });

  it('leaving without a copy removes the items', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    seed(a);
    const f = await a.bridge.shareFolder('gaspF', { team: active(a).teamId });
    if (typeof f === 'string') throw new Error(f);
    await sync(rig, [a, b]);
    await b.bridge.leave(f.teamId, false);
    expect(b.port.lib.folders).toEqual([]);
    expect(b.port.lib.waypoints).toEqual([]);
    expect(b.port.lib.tracks).toEqual([]);
  });

  it('the owner stops sharing: each phone keeps its folder', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    seed(a);
    const f = await a.bridge.shareFolder('gaspF', { team: active(a).teamId });
    if (typeof f === 'string') throw new Error(f);
    await sync(rig, [a, b]);
    expect(await a.bridge.stopSharing(f.teamId)).toBeNull();
    await sync(rig, [a, b]);
    expect(b.service.host.open(f.teamId)).toBeUndefined();
    expect(b.port.names('waypoints')).toEqual(['Refuge']);
    expect(a.port.names('waypoints')).toEqual(['Refuge']);
  });

  it('deleting the shared folder here leaves the share without trashing its items for anyone', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    seed(a);
    const f = await a.bridge.shareFolder('gaspF', { team: active(a).teamId });
    if (typeof f === 'string') throw new Error(f);
    await sync(rig, [a, b]);
    const bf = b.port.lib.folders[0]!.id;
    // As the store's folder delete does: the folder goes, its items are ungrouped.
    b.port.apply({ folders: { remove: [bf] } });
    await sync(rig, [a, b]);
    expect(b.service.host.open(f.teamId)).toBeUndefined();
    expect(b.port.names('waypoints')).toEqual(['Refuge']);
    expect(a.port.names('waypoints')).toEqual(['Refuge']);
    expect(a.port.names('areas')).toEqual(['Bleuets']);
  });

  it('shares a single trail on its own', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    seed(a);
    const f = await a.bridge.shareItem('track', 't1', { team: active(a).teamId });
    if (typeof f === 'string') throw new Error(f);
    await sync(rig, [a, b]);
    expect(b.port.names('tracks')).toEqual(['Mont Albert']);
    expect(b.port.lib.tracks[0]!.folderId).toBeUndefined();
    expect(b.port.lib.waypoints).toEqual([]);
    expect(b.port.lib.folders).toEqual([]);
    expect(await a.bridge.shareItem('track', 't1', { team: active(a).teamId })).toBe('no-change');
  });
});
