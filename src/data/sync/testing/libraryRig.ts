/**
 * TEST-ONLY: two phones of one team, each with an in-memory Library (the
 * same `SyncEdit` the store applies), for the Share live tests (G10).
 */
import { DEFAULT_AREA_COLOR } from '@core/library/areas';
import { applySyncEdit, type SyncEdit } from '@core/library/syncEdit';
import type { CodecTrack } from '@core/domains/library/trackCodec';
import type { Area, Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';
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
} from '../libraryBridge';
import { LibraryGroups } from '../libraryGroups';
import { Rig } from './rig';

export class MemoryLibrary implements LibraryPort {
  lib: LibrarySnapshot & {
    folders: Folder[];
    waypoints: Waypoint[];
    areas: Area[];
    tracks: TrackSummary[];
    maps: MapDocument[];
  } = { folders: [], waypoints: [], areas: [], tracks: [], maps: [] };
  files = new Map<string, CodecTrack>();
  applied = 0;
  private n = 0;
  private readonly fns = new Set<() => void>();
  constructor(readonly tag: string) {}
  snapshot = () => this.lib;
  async trackPoints(t: TrackSummary) {
    return this.files.get(t.fileUri);
  }
  writeTrack(id: string, name: string, track: CodecTrack, category?: string): TrackSummary {
    const fileUri = `file:///${this.tag}/${id}.gpx`;
    this.files.set(fileUri, track);
    const timed = track.points.some((p) => p.hasTime !== false);
    const kind = category ?? (timed ? undefined : 'navigation');
    return {
      id,
      name,
      startedAt: track.points[0]?.time ?? 0,
      stats: {} as TrackSummary['stats'],
      fileUri,
      ...(kind !== undefined ? { category: kind } : {}),
    };
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

export function phone(rig: Rig, tag: string) {
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
export type Phone = ReturnType<typeof phone>;

export const active = (p: Phone): TeamSession => p.service.active!;

export async function team(rig: Rig) {
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

export async function sync(rig: Rig, phones: Phone[]): Promise<void> {
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

export function seed(a: Phone): void {
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
    color: DEFAULT_AREA_COLOR,
    folderId: 'gaspF',
    createdAt: 1,
  });
  a.port.files.set('file:///a/t1.gpx', {
    points: [
      { latitude: 48.9, longitude: -66.2, altitude: 892.5, time: 1_790_000_000_000 },
      { latitude: 48.95, longitude: -66.1, altitude: 1_010.25, time: 1_790_000_060_000 },
    ],
    segmentStarts: [],
  });
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
