/**
 * The library bridge end to end (2.7.0 G10, #712): two phones of one team,
 * each with its own Library (an in-memory port applying the same `SyncEdit`
 * the store applies), over the loopback mesh on the rig.
 */
import { applySyncEdit, type SyncEdit } from '@core/library/syncEdit';
import type {
  Area,
  Folder,
  LatLng,
  LngLat,
  MapDocument,
  TrackSummary,
  Waypoint,
} from '@core/models';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite, TeamSession } from '@data/team/teamSession';

import {
  LibraryBridge,
  memoryBridgeDisk,
  type LibraryPort,
  type LibrarySnapshot,
} from './libraryBridge';
import { LibraryGroups } from './libraryGroups';
import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

class MemoryLibrary implements LibraryPort {
  lib: LibrarySnapshot & {
    folders: Folder[];
    waypoints: Waypoint[];
    areas: Area[];
    tracks: TrackSummary[];
    maps: MapDocument[];
  } = { folders: [], waypoints: [], areas: [], tracks: [], maps: [] };
  files = new Map<string, LngLat[]>();
  applied = 0;
  private n = 0;
  private readonly fns = new Set<() => void>();
  constructor(readonly tag: string) {}
  snapshot = () => this.lib;
  async trackPoints(t: TrackSummary): Promise<LatLng[] | undefined> {
    return this.files.get(t.fileUri)?.map(([longitude, latitude]) => ({ latitude, longitude }));
  }
  writeTrack(id: string, name: string, points: readonly LngLat[]): TrackSummary {
    const fileUri = `file:///${this.tag}/${id}.gpx`;
    this.files.set(fileUri, [...points]);
    return { id, name, startedAt: 0, stats: {} as TrackSummary['stats'], fileUri };
  }
  apply(edit: SyncEdit): void {
    this.applied++;
    this.lib = applySyncEdit(this.lib, edit).index;
  }
  newId = () => `${this.tag}${++this.n}`;
  subscribe(fn: () => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  names(kind: 'waypoints' | 'areas' | 'tracks' | 'folders'): string[] {
    const list: readonly ({ label: string } | { name: string })[] = this.lib[kind];
    return list.map((x) => ('label' in x ? x.label : x.name)).sort();
  }
}

function phone(rig: Rig, tag: string) {
  const service = new TeamService({
    c: nodeCrypto,
    disk: new MemoryTeamDisk(),
    transport: rig.hub.createTransport(),
    now: rig.now,
    tickMs: 0,
    timers: rig.timers,
  });
  const groups = new LibraryGroups(service.host);
  const port = new MemoryLibrary(tag);
  const disk = memoryBridgeDisk();
  const bridge = new LibraryBridge(groups, port, disk, { debounceMs: 0, now: rig.now });
  return { service, groups, port, disk, bridge };
}
type Phone = ReturnType<typeof phone>;

const active = (p: Phone): TeamSession => p.service.active!;

async function team(rig: Rig) {
  const a = phone(rig, 'a');
  const b = phone(rig, 'b');
  await a.service.createTeam({ name: 'Chic-Chocs', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
  await rig.settle();
  const inv = active(a).createInvite(DEFAULT_INVITE) as CreatedInvite;
  await active(a).startMesh();
  const attempt = await b.service.startJoin(parseAnyInvite(webJoinLink(inv.payload))!, 'Julie');
  await rig.settle();
  expect(attempt.state().phase).toBe('verify');
  const joined = await b.service.confirmJoin();
  if (typeof joined === 'string') throw new Error(joined);
  joined.watchFirstLinkMs = 0;
  await rig.settle();
  await active(b).startMesh();
  await rig.settle();
  active(a).tick();
  await rig.settle();
  return { a, b };
}

async function sync(rig: Rig, phones: Phone[]): Promise<void> {
  for (let i = 0; i < 4; i++) {
    for (const p of phones) await p.bridge.runAll();
    for (const p of phones) p.service.host.tick();
    await rig.settle();
  }
}

const RING: [number, number][] = [
  [-66.2, 48.9],
  [-66.19, 48.91],
  [-66.18, 48.9],
];

function seed(a: Phone): void {
  a.port.lib.folders.push({ id: 'gaspF', name: 'Gaspésie 2026', createdAt: 1 });
  a.port.lib.waypoints.push({
    id: 'w1',
    latitude: 48.92,
    longitude: -66.18,
    label: 'Refuge',
    folderId: 'gaspF',
    photoUri: 'file:///a/photo.jpg',
    createdAt: 1,
  });
  a.port.lib.areas.push({
    id: 'a1',
    name: 'Bleuets',
    ring: RING,
    color: '#6E9F32',
    folderId: 'gaspF',
    createdAt: 1,
  });
  a.port.files.set('file:///a/t1.gpx', [
    [-66.2, 48.9],
    [-66.1, 48.95],
  ]);
  a.port.lib.tracks.push({
    id: 't1',
    name: 'Mont Albert',
    startedAt: 1,
    stats: {} as TrackSummary['stats'],
    fileUri: 'file:///a/t1.gpx',
    folderId: 'gaspF',
  });
  a.port.lib.maps.push({
    id: 'm1',
    name: 'Berger',
    fileUri: 'file:///a/m1.pdf',
    folderId: 'gaspF',
    sourceItemId: 'cpa-berger',
  } as MapDocument);
}

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
