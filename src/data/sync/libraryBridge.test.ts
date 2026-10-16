/**
 * The library bridge end to end (2.7.0 G10, #712): two phones of one team,
 * each with its own Library (an in-memory port applying the same `SyncEdit`
 * the store applies), over the loopback mesh on the rig.
 */
import { pair, seed, shareJoin, sync } from './testing/libraryRig';
import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

describe('library bridge (2.7.0 G10)', () => {
  it('shares a folder with the team; a teammate gets it in their Library', async () => {
    const rig = new Rig();
    const { a, b } = pair(rig);
    seed(a);
    const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
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
    const { a, b } = pair(rig);
    seed(a);
    await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
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
      photoUri: 'mem:///a/photo.jpg',
      folderId: 'gaspF',
    });
    // A deletes the area: gone on B too, and in the group's trash.
    a.port.lib.areas = [];
    await sync(rig, [a, b]);
    expect(b.port.lib.areas).toEqual([]);
  });

  it('leaving keeps a copy as a normal folder; removing it frees the Library', async () => {
    const rig = new Rig();
    const { a, b } = pair(rig);
    seed(a);
    const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
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
    const { a, b } = pair(rig);
    seed(a);
    const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
    await sync(rig, [a, b]);
    await b.bridge.leave(f.teamId, false);
    expect(b.port.lib.folders).toEqual([]);
    expect(b.port.lib.waypoints).toEqual([]);
    expect(b.port.lib.tracks).toEqual([]);
  });

  it('the owner stops sharing: each phone keeps its folder', async () => {
    const rig = new Rig();
    const { a, b } = pair(rig);
    seed(a);
    const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
    await sync(rig, [a, b]);
    expect(await a.bridge.stopSharing(f.teamId)).toBeNull();
    await sync(rig, [a, b]);
    expect(b.service.host.open(f.teamId)).toBeUndefined();
    expect(b.port.names('waypoints')).toEqual(['Refuge']);
    expect(a.port.names('waypoints')).toEqual(['Refuge']);
  });

  it('deleting the shared folder here leaves the share without trashing its items for anyone', async () => {
    const rig = new Rig();
    const { a, b } = pair(rig);
    seed(a);
    const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
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
    const { a, b } = pair(rig);
    seed(a);
    await shareJoin(rig, a, b, () => a.bridge.shareItem('track', 't1', { myName: 'Marc' }));
    await sync(rig, [a, b]);
    expect(b.port.names('tracks')).toEqual(['Mont Albert']);
    expect(b.port.lib.tracks[0]!.folderId).toBeUndefined();
    expect(b.port.lib.waypoints).toEqual([]);
    expect(b.port.lib.folders).toEqual([]);
    expect(await a.bridge.shareItem('track', 't1', { myName: 'Marc' })).toBe('no-change');
  });

  it('a long recorded run arrives whole: every point, elevation and time, its segments and type', async () => {
    const rig = new Rig();
    const { a, b } = pair(rig);
    seed(a);
    // 6,000 fixes at 1 Hz, as a GPX holds them (7-decimal coordinates, cm elevations, ms times).
    const points = Array.from({ length: 6_000 }, (_, i) => ({
      latitude: Math.round((48.9 + i * 0.0000137 + Math.sin(i / 30) * 0.00002) * 1e7) / 1e7,
      longitude: Math.round((-66.2 + i * 0.0000211) * 1e7) / 1e7,
      altitude: Math.round((700 + Math.sin(i / 90) * 140 + (i % 7) * 0.03) * 100) / 100,
      time: 1_790_000_000_000 + i * 1000 + (i % 3) * 7,
    }));
    a.port.files.set('mem:///a/run.gpx', { points, segmentStarts: [2_000, 4_100] });
    a.port.lib.tracks.push({
      id: 'run1',
      name: 'Morning run',
      startedAt: points[0]!.time,
      stats: {} as never,
      fileUri: 'mem:///a/run.gpx',
      folderId: 'gaspF',
      category: 'run',
    });
    const f = await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
    // Several parts, each within the op cap.
    const parts = [...f.replica.data().entities.values()].filter((e) => e.kind === 'lpt');
    expect(parts.length).toBeGreaterThan(1);
    await sync(rig, [a, b]);
    const got = b.port.lib.tracks.find((t) => t.name === 'Morning run')!;
    expect(got.category).toBe('run');
    expect(got.startedAt).toBe(points[0]!.time);
    const file = b.port.files.get(got.fileUri)!;
    expect(file.segmentStarts).toEqual([2_000, 4_100]);
    expect(file.points).toEqual(points);
  });

  it('sub-folders of a shared folder are shared, with their items', async () => {
    const rig = new Rig();
    const { a, b } = pair(rig);
    seed(a);
    a.port.lib.folders.push({ id: 'day1', name: 'Jour 1', createdAt: 1, parentId: 'gaspF' });
    a.port.lib.waypoints.push({
      id: 'w9',
      latitude: 48.93,
      longitude: -66.15,
      label: 'Source',
      folderId: 'day1',
      createdAt: 2,
    });
    await shareJoin(rig, a, b, () => a.bridge.shareFolder('gaspF', { myName: 'Marc' }));
    await sync(rig, [a, b]);
    const root = b.port.lib.folders.find((x) => x.name === 'Gaspésie 2026')!;
    const day = b.port.lib.folders.find((x) => x.name === 'Jour 1')!;
    expect(root.parentId).toBeUndefined();
    expect(day.parentId).toBe(root.id);
    expect(b.port.lib.waypoints.find((w) => w.label === 'Source')!.folderId).toBe(day.id);
    // B moves the refuge into the sub-folder: A's Library follows.
    const refuge = b.port.lib.waypoints.find((w) => w.label === 'Refuge')!;
    refuge.folderId = day.id;
    await sync(rig, [a, b]);
    expect(a.port.lib.waypoints.find((w) => w.id === 'w1')!.folderId).toBe('day1');
  });
});
