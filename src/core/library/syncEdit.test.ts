import type { Area, Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

import { applySyncEdit } from './syncEdit';

const folder = (id: string, name = id): Folder => ({ id, name, createdAt: 1 });
const wpt = (id: string, extra: Partial<Waypoint> = {}): Waypoint => ({
  id,
  latitude: 46,
  longitude: -71,
  label: id,
  createdAt: 1,
  ...extra,
});
const area = (id: string, extra: Partial<Area> = {}): Area => ({
  id,
  name: id,
  ring: [
    [0, 0],
    [1, 0],
    [1, 1],
  ],
  color: '#6E9F32',
  createdAt: 1,
  ...extra,
});
const track = (id: string, extra: Partial<TrackSummary> = {}): TrackSummary => ({
  id,
  name: id,
  startedAt: 1,
  stats: {} as TrackSummary['stats'],
  fileUri: `file:///tracks/${id}.gpx`,
  ...extra,
});
const map = (id: string, extra: Partial<MapDocument> = {}): MapDocument =>
  ({ id, name: id, fileUri: `file:///maps/${id}.pdf`, ...extra }) as MapDocument;

function index() {
  return {
    folders: [folder('f1', 'Gaspésie')],
    waypoints: [wpt('w1', { folderId: 'f1', photoUri: 'file:///p/w1.jpg' })],
    areas: [area('a1', { folderId: 'f1', photoUris: ['file:///p/a1.jpg', 'file:///p/a2.jpg'] })],
    tracks: [track('t1', { folderId: 'f1' })],
    maps: [map('m1', { folderId: 'f1' })],
    activeTrackIds: ['t1'],
    visibleFolderIds: ['f1'],
    activeMapId: 'm1',
  };
}

describe('applySyncEdit', () => {
  it('changes nothing for an empty edit (same object back)', () => {
    const i = index();
    const r = applySyncEdit(i, {});
    expect(r.changed).toBe(false);
    expect(r.index).toBe(i);
  });

  it('inserts and replaces by id, keeping order', () => {
    const r = applySyncEdit(index(), {
      waypoints: {
        put: [
          wpt('w1', { label: 'Refuge', folderId: 'f1', photoUri: 'file:///p/w1.jpg' }),
          wpt('w2'),
        ],
      },
      folders: { put: [folder('f1', 'Gaspésie 2026')] },
    });
    expect(r.index.waypoints.map((w) => [w.id, w.label])).toEqual([
      ['w1', 'Refuge'],
      ['w2', 'w2'],
    ]);
    expect(r.index.folders[0]!.name).toBe('Gaspésie 2026');
    expect(r.orphanedUris).toEqual([]);
  });

  it('removes items with their files, overlays and photos', () => {
    const r = applySyncEdit(index(), {
      waypoints: { remove: ['w1'] },
      tracks: { remove: ['t1'] },
      maps: { remove: ['m1'] },
      areas: { put: [area('a1', { folderId: 'f1', photoUris: ['file:///p/a1.jpg'] })] },
    });
    expect(r.index.waypoints).toEqual([]);
    expect(r.index.tracks).toEqual([]);
    expect(r.index.activeTrackIds).toEqual([]);
    expect(r.index.activeMapId).toBeNull();
    expect(r.deletedTrackIds).toEqual(['t1']);
    expect(r.orphanedUris.sort()).toEqual(
      [
        'file:///maps/m1.pdf',
        'file:///p/a2.jpg',
        'file:///p/w1.jpg',
        'file:///tracks/t1.gpx',
      ].sort(),
    );
  });

  it('a replaced GPX file is orphaned; a removed folder ungroups its items', () => {
    const r = applySyncEdit(index(), {
      tracks: { put: [track('t1', { fileUri: 'file:///tracks/t1-v2.gpx', folderId: 'f1' })] },
      folders: { remove: ['f1'] },
    });
    expect(r.orphanedUris).toEqual(['file:///tracks/t1.gpx']);
    expect(r.deletedTrackIds).toEqual([]);
    expect(r.index.folders).toEqual([]);
    expect(r.index.visibleFolderIds).toEqual([]);
    expect(r.index.tracks[0]!.folderId).toBeUndefined();
    expect(r.index.waypoints[0]!.folderId).toBeUndefined();
  });
});
