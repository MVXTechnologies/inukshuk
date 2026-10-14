import type { Area, GeoReference, MapDocument, TrackSummary, Waypoint } from '@core/models';

import {
  applyFolderMoves,
  applyShown,
  folderSnapshot,
  isEmptyRemoval,
  pagesToShow,
  removedFileUris,
  removeItems,
  restoreFolder,
  restoreItems,
  type LibraryIndexSlice,
} from './bulkEdits';
import { undoMoves, type ItemRef } from './selection';

const geo = (pageIndex: number): GeoReference => ({
  pageIndex,
  source: 'adobe-geo',
  pageWidthPt: 612,
  pageHeightPt: 792,
  viewport: {
    rect: { x0: 0, y0: 0, x1: 600, y1: 600 },
    corners: {
      topLeft: [-71.3, 46.9],
      topRight: [-71.1, 46.9],
      bottomRight: [-71.1, 46.7],
      bottomLeft: [-71.3, 46.7],
    },
  },
  bbox: { minLat: 46.7, minLng: -71.3, maxLat: 46.9, maxLng: -71.1 },
});

const map = (id: string, over: Partial<MapDocument> = {}): MapDocument => ({
  id,
  name: id,
  fileUri: `file:///${id}.pdf`,
  importedAt: 1,
  pageCount: 2,
  georeferences: [geo(0), geo(1)],
  activePages: [],
  ...over,
});
const track = (id: string, over: Partial<TrackSummary> = {}): TrackSummary =>
  ({
    id,
    name: id,
    fileUri: `file:///${id}.gpx`,
    startedAt: 1,
    stats: {},
    ...over,
  }) as TrackSummary;
const waypoint = (id: string, over: Partial<Waypoint> = {}): Waypoint => ({
  id,
  label: id,
  latitude: 47,
  longitude: -71,
  createdAt: 1,
  ...over,
});
const area = (id: string, over: Partial<Area> = {}): Area => ({
  id,
  name: id,
  ring: [
    [-71, 47],
    [-70, 47],
    [-70, 46],
  ],
  color: '#2563EB',
  createdAt: 1,
  ...over,
});

const state = (over: Partial<LibraryIndexSlice> = {}): LibraryIndexSlice => ({
  maps: [map('m1'), map('m2', { folderId: 'f1' })],
  tracks: [track('t1'), track('t2', { folderId: 'f1' }), track('t3')],
  waypoints: [waypoint('w1', { folderId: 'f2' })],
  areas: [area('a1')],
  folders: [
    { id: 'f1', name: 'One', createdAt: 1 },
    { id: 'f2', name: 'Two', createdAt: 2 },
  ],
  activeTrackIds: ['t1'],
  activeMapId: 'm1',
  visibleFolderIds: ['f1'],
  ...over,
});

const T = (id: string): ItemRef => ({ kind: 'track', id });
const M = (id: string): ItemRef => ({ kind: 'map', id });
const W = (id: string): ItemRef => ({ kind: 'waypoint', id });
const A = (id: string): ItemRef => ({ kind: 'area', id });

describe('applyFolderMoves', () => {
  it('moves every kind, and Undo puts each back in its own folder', () => {
    const s = state();
    const moves = [
      { ref: T('t1'), from: null, to: 'f2' },
      { ref: M('m2'), from: 'f1', to: 'f2' },
      { ref: A('a1'), from: null, to: 'f2' },
    ];
    const moved = { ...s, ...applyFolderMoves(s, moves) };
    expect(moved.tracks.find((t) => t.id === 't1')?.folderId).toBe('f2');
    expect(moved.maps.find((m) => m.id === 'm2')?.folderId).toBe('f2');
    expect(moved.areas[0]?.folderId).toBe('f2');
    const back = applyFolderMoves(moved, undoMoves(moves));
    expect(back.tracks.find((t) => t.id === 't1')).not.toHaveProperty('folderId');
    expect(back.maps.find((m) => m.id === 'm2')?.folderId).toBe('f1');
    expect(back.areas[0]).not.toHaveProperty('folderId');
    // Untouched items keep their identity (no needless re-render downstream).
    expect(back.tracks.find((t) => t.id === 't3')).toBe(s.tracks[2]);
  });

  it('skips a move into a folder that no longer exists', () => {
    const s = state();
    const out = applyFolderMoves(s, [{ ref: W('w1'), from: 'f2', to: 'deleted' }]);
    expect(out.waypoints[0]?.folderId).toBe('f2');
  });
});

describe('removeItems / restoreItems', () => {
  it('takes items out without touching files, then Undo puts them back in place', () => {
    const s = state();
    const { next, removed } = removeItems(s, [T('t1'), T('t3'), M('m1'), W('w1'), A('a1')]);
    expect(next.tracks.map((t) => t.id)).toEqual(['t2']);
    expect(next.maps.map((m) => m.id)).toEqual(['m2']);
    expect(next.waypoints).toEqual([]);
    expect(next.areas).toEqual([]);
    expect(next.activeTrackIds).toEqual([]);
    expect(next.activeMapId).toBeNull();
    expect(isEmptyRemoval(removed)).toBe(false);

    const after = { ...s, ...next };
    const restored = restoreItems(after, removed);
    expect(restored.tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(restored.maps.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(restored.waypoints.map((w) => w.id)).toEqual(['w1']);
    expect(restored.areas.map((a) => a.id)).toEqual(['a1']);
    expect(restored.activeTrackIds).toEqual(['t1']);
    expect(restored.activeMapId).toBe('m1');
  });

  it('restores around changes made in the meantime, never twice', () => {
    const s = state();
    const { next, removed } = removeItems(s, [T('t1')]);
    const changed = { ...s, ...next, tracks: [track('new'), ...next.tracks], activeMapId: 'm2' };
    const restored = restoreItems(changed, removed);
    expect(restored.tracks.map((t) => t.id)).toEqual(['t1', 'new', 't2', 't3']);
    expect(restored.activeMapId).toBe('m2');
    expect(restoreItems({ ...changed, ...restored }, removed).tracks).toHaveLength(4);
  });

  it('lists the files to delete once the Undo window has passed', () => {
    const s = state({
      tracks: [
        track('t1', { notes: [{ photoUri: 'file:///n.jpg' }, {}] as TrackSummary['notes'] }),
      ],
      waypoints: [waypoint('w1', { photoUri: 'file:///w.jpg' }), waypoint('w2')],
      areas: [area('a1', { photoUris: ['file:///a.jpg'] })],
    });
    const { removed } = removeItems(s, [T('t1'), M('m1'), W('w1'), W('w2'), A('a1')]);
    expect(removedFileUris(removed)).toEqual([
      'file:///m1.pdf',
      'file:///t1.gpx',
      'file:///n.jpg',
      'file:///w.jpg',
      'file:///a.jpg',
    ]);
  });

  it('removing unknown refs removes nothing', () => {
    expect(isEmptyRemoval(removeItems(state(), [T('nope')]).removed)).toBe(true);
  });
});

describe('folder delete with Undo', () => {
  it('snapshots the folder and its members, and restores them', () => {
    const s = state({ areas: [area('a1', { folderId: 'f1' })] });
    const snap = folderSnapshot(s, 'f1');
    expect(snap).toEqual({
      folder: { id: 'f1', name: 'One', createdAt: 1 },
      index: 0,
      members: [M('m2'), T('t2'), A('a1')],
      visible: true,
    });
    // What removeFolder leaves: no folder, members ungrouped, unchecked.
    const gone: LibraryIndexSlice = {
      ...s,
      folders: s.folders.filter((f) => f.id !== 'f1'),
      maps: s.maps.map(({ folderId: _f, ...m }) => m),
      tracks: s.tracks.map((t) => (t.id === 't2' ? { ...t, folderId: 'f2' } : t)), // refiled since
      areas: s.areas.map(({ folderId: _f, ...a }) => a),
      visibleFolderIds: [],
    };
    const back = restoreFolder(gone, snap!);
    expect(back.folders.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(back.maps.find((m) => m.id === 'm2')?.folderId).toBe('f1');
    expect(back.areas[0]?.folderId).toBe('f1');
    // The user filed t2 elsewhere meanwhile: that choice stands.
    expect(back.tracks.find((t) => t.id === 't2')?.folderId).toBe('f2');
    expect(back.visibleFolderIds).toEqual(['f1']);
    // Restoring twice adds nothing.
    expect(restoreFolder({ ...gone, ...back }, snap!).folders).toHaveLength(2);
  });

  it('has no snapshot for an unknown folder', () => {
    expect(folderSnapshot(state(), 'nope')).toBeNull();
    const s = state();
    const snap = folderSnapshot(s, 'f2')!;
    expect(snap.visible).toBe(false);
    expect(restoreFolder(s, snap).visibleFolderIds).toEqual(['f1']);
  });
});

describe('applyShown', () => {
  it('shows maps (healthy pages) and trails in one edit, counting real changes', () => {
    const s = state({
      maps: [
        map('m1', { renderRecoveryErrors: [{ pageIndex: 1, reason: 'interrupted' }] }),
        map('m2', { activePages: [0] }),
        map('flat', { georeferences: [] }),
      ],
    });
    const out = applyShown(s, [M('m1'), M('m2'), M('flat'), T('t1'), T('t2'), W('w1')], true);
    expect(out.maps.map((m) => m.activePages)).toEqual([[0], [0], []]);
    expect(out.activeTrackIds).toEqual(['t1', 't2']);
    expect(out.changed).toBe(2);
  });

  it('hides them', () => {
    const s = state({ maps: [map('m1', { activePages: [0, 1] })], activeTrackIds: ['t1', 't3'] });
    const out = applyShown(s, [M('m1'), T('t1'), T('t2')], false);
    expect(out.maps[0]?.activePages).toEqual([]);
    expect(out.activeTrackIds).toEqual(['t3']);
    expect(out.changed).toBe(2);
  });

  it('leaves a map whose pages all failed, and ignores unknown trails', () => {
    const failed = map('m1', {
      renderRecoveryErrors: [
        { pageIndex: 0, reason: 'interrupted' },
        { pageIndex: 1, reason: 'render-failed', message: 'x' },
      ],
    });
    expect(pagesToShow(failed)).toEqual([]);
    const out = applyShown(state({ maps: [failed] }), [M('m1'), T('ghost')], true);
    expect(out.changed).toBe(0);
    expect(out.maps[0]).toBe(failed);
  });
});
