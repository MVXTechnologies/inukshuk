/**
 * The select mode's bulk edits (#711): each one is ONE index write, a bulk
 * delete keeps its files until it is purged, Undo puts things back, and areas
 * can be filed in folders like every other kind.
 */
import { LIBRARY_SCHEMA_VERSION } from '@core/library/migrations';
import type { Area, TrackSummary } from '@core/models';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => 'n_' + Math.random().toString(36).slice(2, 8),
  ensureStorage: jest.fn(),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  readIndex: jest.fn(),
}));
jest.mock('@data/photos/trailFolder', () => ({ deleteTrailPhotoFolder: jest.fn() }));

const storage = jest.requireMock('@data/storage') as {
  writeIndex: jest.Mock;
  readIndex: jest.Mock;
  deleteFileAt: jest.Mock;
};
const photos = jest.requireMock('@data/photos/trailFolder') as {
  deleteTrailPhotoFolder: jest.Mock;
};

const track = (id: string, folderId?: string): TrackSummary => ({
  id,
  name: id,
  fileUri: `file:///Documents/${id}.gpx`,
  startedAt: 1,
  stats: {
    distanceM: 0,
    ascentM: 0,
    descentM: 0,
    durationS: 0,
    movingTimeS: 0,
    avgSpeedMps: 0,
    maxSpeedMps: 0,
    pointCount: 0,
  },
  ...(folderId ? { folderId } : {}),
});
const area: Area = {
  id: 'a1',
  name: 'Field',
  ring: [
    [-71, 47],
    [-70, 47],
    [-70, 46],
  ],
  color: '#2563EB',
  createdAt: 1,
};

beforeAll(async () => {
  storage.readIndex.mockResolvedValue({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    maps: [],
    tracks: [],
    folders: [{ id: 'f1', name: 'TripA', createdAt: 1 }],
    mapVisibilityMode: 'type',
    visibleFolderIds: [],
    activeMapId: null,
    activeTrackIds: [],
    customCategories: [],
    waypoints: [],
    areas: [],
  });
  await useLibraryStore.getState().hydrate();
});

beforeEach(() => {
  useLibraryStore.setState({
    tracks: [track('t1', 'f1'), track('t2'), track('t3')],
    areas: [area],
    folders: [{ id: 'f1', name: 'TripA', createdAt: 1 }],
    activeTrackIds: ['t2'],
  });
  storage.writeIndex.mockClear();
  storage.deleteFileAt.mockClear();
  photos.deleteTrailPhotoFolder.mockClear();
});

const ids = () => useLibraryStore.getState().tracks.map((t) => t.id);

it('files an area in a folder, and a folder delete puts it back in Ungrouped', () => {
  useLibraryStore.getState().setItemFolder('area', 'a1', 'f1');
  expect(useLibraryStore.getState().areas[0]?.folderId).toBe('f1');
  useLibraryStore.getState().removeFolder('f1');
  expect(useLibraryStore.getState().areas[0]?.folderId).toBeUndefined();
});

it('moves many items in one write', () => {
  useLibraryStore.getState().moveItems([
    { ref: { kind: 'track', id: 't2' }, from: null, to: 'f1' },
    { ref: { kind: 'area', id: 'a1' }, from: null, to: 'f1' },
  ]);
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  expect(useLibraryStore.getState().tracks[1]?.folderId).toBe('f1');
  expect(useLibraryStore.getState().areas[0]?.folderId).toBe('f1');
  useLibraryStore.getState().moveItems([]);
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
});

it('deletes for Undo: one write, files kept until purged; Undo restores', () => {
  const removed = useLibraryStore.getState().removeItemsForUndo([
    { kind: 'track', id: 't2' },
    { kind: 'area', id: 'a1' },
  ]);
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  expect(ids()).toEqual(['t1', 't3']);
  expect(useLibraryStore.getState().activeTrackIds).toEqual([]);
  expect(storage.deleteFileAt).not.toHaveBeenCalled();

  useLibraryStore.getState().restoreRemovedItems(removed);
  expect(ids()).toEqual(['t1', 't2', 't3']);
  expect(useLibraryStore.getState().areas).toHaveLength(1);
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2']);
  expect(storage.writeIndex).toHaveBeenCalledTimes(2);
});

it('purges the files of a delete that stood', () => {
  const removed = useLibraryStore.getState().removeItemsForUndo([{ kind: 'track', id: 't3' }]);
  useLibraryStore.getState().purgeRemovedItems(removed);
  expect(storage.deleteFileAt).toHaveBeenCalledWith('file:///Documents/t3.gpx');
  expect(photos.deleteTrailPhotoFolder).toHaveBeenCalledWith('t3');
});

it('nothing to remove is no write', () => {
  useLibraryStore.getState().removeItemsForUndo([{ kind: 'track', id: 'nope' }]);
  expect(storage.writeIndex).not.toHaveBeenCalled();
});

it('deletes a folder for Undo and restores it with its members', () => {
  const snap = useLibraryStore.getState().removeFolderForUndo('f1');
  expect(useLibraryStore.getState().folders).toEqual([]);
  expect(useLibraryStore.getState().tracks[0]?.folderId).toBeUndefined();
  useLibraryStore.getState().restoreFolder(snap!);
  expect(useLibraryStore.getState().folders.map((f) => f.id)).toEqual(['f1']);
  expect(useLibraryStore.getState().tracks[0]?.folderId).toBe('f1');
  expect(useLibraryStore.getState().removeFolderForUndo('nope')).toBeNull();
});

it('shows and hides many trails in one write, counting changes', () => {
  const refs = [
    { kind: 'track' as const, id: 't1' },
    { kind: 'track' as const, id: 't2' },
  ];
  expect(useLibraryStore.getState().setItemsShown(refs, true)).toBe(1);
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2', 't1']);
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  expect(useLibraryStore.getState().setItemsShown(refs, true)).toBe(0);
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  expect(useLibraryStore.getState().setItemsShown(refs, false)).toBe(2);
  expect(useLibraryStore.getState().activeTrackIds).toEqual([]);
});
